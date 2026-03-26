# K8s Architecture Simplification Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Dramatically simplify the AX k8s deployment by removing NATS, eliminating workspace sync complexity, making pods session-long with idle-based timeout, and routing all persistence through Postgres + GCS IPC calls.

**Architecture:** Replace the current per-turn pod lifecycle (NATS work dispatch → cold spawn → workspace provision → execute → workspace release → pod death) with session-long pods that get work via HTTP, persist files directly through GCS IPC calls, and store skills entirely in the DB. EventBus moves from NATS to Postgres LISTEN/NOTIFY.

**Tech Stack:** TypeScript, Postgres (LISTEN/NOTIFY), Kubernetes, GCS, Zod, Kysely, Helm

---

## Overview of Changes

| What | Before | After |
|------|--------|-------|
| EventBus | NATS pub/sub | Postgres LISTEN/NOTIFY |
| Work dispatch | NATS `sandbox.work` queue group | HTTP `GET /internal/work` |
| Pod lifecycle | Per-turn (new pod every message) | Session-long (one pod per session) |
| Pod timeout | `activeDeadlineSeconds` (fixed) | Host-side idle timer with 120s warning |
| Workspace files | GCS provision at start + release at end | Direct IPC: `workspace_read`/`workspace_write`/`workspace_list` |
| Skills | Filesystem + DB (dual write) | DB-only with `files` array |
| Warm pool | NATS queue groups + pool-controller | Gone |
| Root filesystem | Read-only | Writable (allows `npm install`, `pip install`) |
| Pod volumes | 4 emptyDirs (scratch, tmp, agent-ws, user-ws) | 2 emptyDirs (workspace, tmp) |

## Task Dependency Graph

```
Task 1 (postgres eventbus) ──────────────────────────────────────┐
Task 2 (skill CRUD IPC) ─────────────────────────────────────────┤
Task 3 (workspace list/read IPC) ────────────────────────────────┤
Task 4 (session pod manager + /internal/work) ───┐               ├─► Task 9 (helm cleanup)
Task 5 (agent runner work loop) ─────────────────┤               │
Task 6 (idle timeout + 120s warning) ────────────┼─► Task 7 ────┤
Task 7 (remove NATS from host) ──────────────────┘   Task 8 ────┘
Task 8 (remove workspace provision/release) ─────────────────────┘
```

Tasks 1-3 are independent of each other and of tasks 4-8. Tasks 4-6 build the new session-pod model. Task 7 rips out NATS. Task 8 removes workspace sync. Task 9 cleans up helm.

---

### Task 1: Postgres LISTEN/NOTIFY EventBus Provider

**Files:**
- Create: `src/providers/eventbus/postgres.ts`
- Modify: `src/host/provider-map.ts:86-89` (add `postgres` entry)
- Test: `tests/providers/eventbus/postgres.test.ts`

**Context:** The existing `EventBusProvider` interface (`src/providers/eventbus/types.ts`) requires: `emit(event)`, `subscribe(listener)`, `subscribeRequest(requestId, listener)`, `listenerCount()`, `close()`. The in-process provider (`src/providers/eventbus/inprocess.ts`) is the reference implementation. The Postgres database provider (`src/providers/database/postgres.ts`) uses Kysely + `pg` Pool. SSE events are small JSON (<8KB), well within Postgres NOTIFY's payload limit.

**Step 1: Write the failing test**

```typescript
// tests/providers/eventbus/postgres.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

// Integration test — requires POSTGRESQL_URL env var
const PG_URL = process.env.POSTGRESQL_URL;

describe.skipIf(!PG_URL)('postgres eventbus', () => {
  let provider: any;

  beforeAll(async () => {
    const mod = await import('../../../src/providers/eventbus/postgres.js');
    provider = await mod.create({ providers: { database: 'postgresql' } } as any);
  });

  afterAll(() => { provider?.close(); });

  it('delivers events to global subscribers', async () => {
    const received: any[] = [];
    provider.subscribe((e: any) => received.push(e));
    // Small delay for subscription to register
    await new Promise(r => setTimeout(r, 100));

    provider.emit({ type: 'test', requestId: 'req-1', timestamp: Date.now(), data: {} });
    await new Promise(r => setTimeout(r, 200));

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe('test');
  });

  it('delivers events to per-request subscribers', async () => {
    const received: any[] = [];
    provider.subscribeRequest('req-2', (e: any) => received.push(e));
    await new Promise(r => setTimeout(r, 100));

    // Should receive matching requestId
    provider.emit({ type: 'a', requestId: 'req-2', timestamp: Date.now(), data: {} });
    // Should NOT receive non-matching requestId
    provider.emit({ type: 'b', requestId: 'req-other', timestamp: Date.now(), data: {} });
    await new Promise(r => setTimeout(r, 200));

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe('a');
  });

  it('unsubscribe stops delivery', async () => {
    const received: any[] = [];
    const unsub = provider.subscribe((e: any) => received.push(e));
    await new Promise(r => setTimeout(r, 100));
    unsub();

    provider.emit({ type: 'after-unsub', requestId: 'x', timestamp: Date.now(), data: {} });
    await new Promise(r => setTimeout(r, 200));

    expect(received).toHaveLength(0);
  });

  it('reports listener count', () => {
    const unsub = provider.subscribe(() => {});
    expect(provider.listenerCount()).toBeGreaterThanOrEqual(1);
    unsub();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- --run tests/providers/eventbus/postgres.test.ts`
Expected: FAIL — module `../../../src/providers/eventbus/postgres.js` not found

**Step 3: Write the Postgres eventbus provider**

```typescript
// src/providers/eventbus/postgres.ts — Postgres LISTEN/NOTIFY EventBusProvider
//
// Uses Postgres LISTEN/NOTIFY for real-time event distribution.
// Each event is published to two channels:
//   events_global    — all subscribers receive it
//   events_{reqId}   — only per-request subscribers for that requestId
//
// NOTIFY payload limit is 8KB. SSE events are small JSON, well under this.

import type { Config } from '../../types.js';
import type { EventBusProvider, StreamEvent, EventListener } from './types.js';
import { getLogger } from '../../logger.js';

const logger = getLogger().child({ component: 'eventbus-postgres' });

const MAX_REQUEST_LISTENERS = 50;
const MAX_LISTENERS = 100;

/** Sanitize a requestId for use as a Postgres channel name suffix. */
function sanitizeChannel(requestId: string): string {
  return requestId.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 60);
}

export async function create(_config: Config): Promise<EventBusProvider> {
  const { createRequire } = await import('node:module');
  const req = createRequire(import.meta.url);
  const { Client } = req('pg');

  const connectionString = process.env.POSTGRESQL_URL
    ?? process.env.DATABASE_URL
    ?? 'postgresql://localhost:5432/ax';

  // Dedicated connection for LISTEN (cannot share with query pool —
  // pg LISTEN requires a persistent, non-pooled connection).
  const listenClient = new Client({ connectionString });
  await listenClient.connect();

  // Separate client for NOTIFY (can use any connection)
  const notifyClient = new Client({ connectionString });
  await notifyClient.connect();

  const globals: EventListener[] = [];
  const perRequest = new Map<string, EventListener[]>();
  const activeChannels = new Set<string>();

  // Listen on global channel
  await listenClient.query('LISTEN events_global');

  // Route incoming notifications to the right listeners
  listenClient.on('notification', (msg: { channel: string; payload?: string }) => {
    if (!msg.payload) return;
    let event: StreamEvent;
    try {
      event = JSON.parse(msg.payload) as StreamEvent;
    } catch {
      return;
    }

    if (msg.channel === 'events_global') {
      for (const listener of [...globals]) {
        try { listener(event); } catch (err) {
          logger.warn('event_listener_error', { type: event.type, error: (err as Error).message });
        }
      }
    } else {
      // events_{requestId}
      const reqId = msg.channel.replace(/^events_/, '');
      const listeners = perRequest.get(reqId);
      if (!listeners) return;
      for (const listener of [...listeners]) {
        try { listener(event); } catch (err) {
          logger.warn('event_listener_error', { type: event.type, requestId: reqId, error: (err as Error).message });
        }
      }
    }
  });

  logger.info('postgres_eventbus_connected');

  return {
    emit(event: StreamEvent): void {
      const payload = JSON.stringify(event);
      if (payload.length > 7900) {
        logger.warn('event_payload_too_large', { type: event.type, bytes: payload.length });
        return;
      }
      const escaped = payload.replace(/'/g, "''");
      notifyClient.query(`NOTIFY events_global, '${escaped}'`).catch((err: Error) => {
        logger.warn('notify_failed', { channel: 'events_global', error: err.message });
      });
      const channel = `events_${sanitizeChannel(event.requestId)}`;
      notifyClient.query(`NOTIFY ${channel}, '${escaped}'`).catch((err: Error) => {
        logger.warn('notify_failed', { channel, error: err.message });
      });
    },

    subscribe(listener: EventListener): () => void {
      if (globals.length >= MAX_LISTENERS) {
        globals.shift();
        logger.warn('event_listener_evicted', { reason: 'max_listeners_reached', max: MAX_LISTENERS });
      }
      globals.push(listener);

      let removed = false;
      return () => {
        if (removed) return;
        removed = true;
        const idx = globals.indexOf(listener);
        if (idx >= 0) globals.splice(idx, 1);
      };
    },

    subscribeRequest(requestId: string, listener: EventListener): () => void {
      const channel = sanitizeChannel(requestId);
      let listeners = perRequest.get(channel);
      if (!listeners) {
        listeners = [];
        perRequest.set(channel, listeners);
      }

      if (listeners.length >= MAX_REQUEST_LISTENERS) {
        listeners.shift();
      }
      listeners.push(listener);

      // LISTEN on this channel if not already
      if (!activeChannels.has(channel)) {
        activeChannels.add(channel);
        listenClient.query(`LISTEN events_${channel}`).catch((err: Error) => {
          logger.warn('listen_failed', { channel, error: err.message });
        });
      }

      let removed = false;
      return () => {
        if (removed) return;
        removed = true;
        const arr = perRequest.get(channel);
        if (!arr) return;
        const idx = arr.indexOf(listener);
        if (idx >= 0) arr.splice(idx, 1);
        if (arr.length === 0) {
          perRequest.delete(channel);
          activeChannels.delete(channel);
          listenClient.query(`UNLISTEN events_${channel}`).catch(() => {});
        }
      };
    },

    listenerCount(): number {
      return globals.length;
    },

    close(): void {
      listenClient.end().catch(() => {});
      notifyClient.end().catch(() => {});
    },
  };
}
```

**Step 4: Register in provider map**

In `src/host/provider-map.ts:86-89`, add `postgres` to the eventbus map:

```typescript
  eventbus: {
    inprocess: '../providers/eventbus/inprocess.js',
    nats:      '../providers/eventbus/nats.js',
    postgres:  '../providers/eventbus/postgres.js',
  },
```

**Step 5: Run test to verify it passes**

Run: `POSTGRESQL_URL=postgresql://localhost:5432/ax npm test -- --run tests/providers/eventbus/postgres.test.ts`
Expected: PASS (all 4 tests)

**Step 6: Commit**

```bash
git add src/providers/eventbus/postgres.ts src/host/provider-map.ts tests/providers/eventbus/postgres.test.ts
git commit -m "feat: add Postgres LISTEN/NOTIFY eventbus provider"
```

---

### Task 2: Skill CRUD IPC Actions with Files Field

> **Note (2026-03-26):** This task has been implemented differently than originally planned.
> The `skill_list`/`skill_read` IPC actions were not added — instead, the existing `skill_install`,
> `skill_update`, and `skill_delete` handlers in `src/host/ipc-handlers/skills.ts` cover all CRUD.
> The agent-side `skill` tool in `src/agent/mcp-server.ts` uses a `type` enum (`install`/`update`/`delete`)
> rather than the multi-op `actionMap` described below. The plan below is retained for historical context only.

**Files:**
- Modify: `src/providers/storage/skills.ts` (add `files` field to `SkillRecord` + `SkillUpsertInput`)
- Modify: `src/ipc-schemas.ts:155-160` (add `skill_list`, `skill_read`, `skill_update`, `skill_delete` schemas)
- Modify: `src/host/ipc-handlers/skills.ts` (add handlers + store files on install)
- Modify: `src/agent/tool-catalog.ts:202-218` (expand skill tool with multi-op `actionMap`)
- Test: `tests/host/ipc-handlers/skills-crud.test.ts`

**Context:** The DB layer in `src/providers/storage/skills.ts` already has `upsertSkill()`, `getSkill()`, `listSkills()`, `deleteSkill()`. The only IPC action is `skill_install`. Skills are directories (SKILL.md + auxiliary files). The `SkillRecord` currently stores only `instructions` (the SKILL.md content). We need to add a `files` array to store all files in the skill directory.

**Step 1: Add `files` field to SkillRecord**

In `src/providers/storage/skills.ts`, update the interfaces:

```typescript
export interface SkillFile {
  path: string;
  content: string;
}

export interface SkillRecord {
  id: string;
  agentId: string;
  version: string;
  instructions: string;
  files: SkillFile[];         // <-- NEW: all files in the skill directory
  mcpApps: string[];
  mcpTools: string[] | null;
  authType: 'oauth' | 'api_key' | null;
  installedAt: string;
}

export interface SkillUpsertInput {
  id: string;
  agentId: string;
  version: string;
  instructions: string;
  files?: SkillFile[];        // <-- NEW
  mcpApps: string[];
  mcpTools?: string[] | null;
  authType?: 'oauth' | 'api_key' | null;
}
```

Update `upsertSkill()` to include files:

```typescript
export async function upsertSkill(
  documents: DocumentStore,
  input: SkillUpsertInput,
): Promise<void> {
  const record: SkillRecord = {
    id: input.id,
    agentId: input.agentId,
    version: input.version,
    instructions: input.instructions,
    files: input.files ?? [{ path: 'SKILL.md', content: input.instructions }],
    mcpApps: input.mcpApps,
    mcpTools: input.mcpTools ?? null,
    authType: input.authType ?? null,
    installedAt: new Date().toISOString(),
  };
  await documents.put('skills', skillKey(input.agentId, input.id), JSON.stringify(record));
}
```

**Step 2: Add IPC schemas**

In `src/ipc-schemas.ts`, after the existing `SkillInstallSchema` (~line 160):

```typescript
export const SkillListSchema = ipcAction('skill_list', {});

export const SkillReadSchema = ipcAction('skill_read', {
  slug: safeString(200),
});

export const SkillUpdateSchema = ipcAction('skill_update', {
  slug: safeString(200),
  path: safeString(1024),
  content: safeString(500_000),
});

export const SkillDeleteSchema = ipcAction('skill_delete', {
  slug: safeString(200),
});
```

**Step 3: Add IPC handlers**

In `src/host/ipc-handlers/skills.ts`, add to the returned object from `createSkillsHandlers()`:

```typescript
    skill_list: async (_req: any, ctx: IPCContext) => {
      if (!providers.storage?.documents) return { skills: [] };
      const agentName = ctx.agentId ?? 'main';
      const skills = await listSkills(providers.storage.documents, agentName);
      return {
        skills: skills.map(s => ({
          id: s.id,
          name: s.id,
          version: s.version,
          fileCount: s.files?.length ?? 1,
          mcpApps: s.mcpApps,
          installedAt: s.installedAt,
        })),
      };
    },

    skill_read: async (req: any, ctx: IPCContext) => {
      if (!providers.storage?.documents) return { ok: false, error: 'No storage provider' };
      const agentName = ctx.agentId ?? 'main';
      const skill = await getSkill(providers.storage.documents, agentName, req.slug);
      if (!skill) return { ok: false, error: 'Skill not found' };
      return {
        ok: true,
        id: skill.id,
        version: skill.version,
        instructions: skill.instructions,
        files: skill.files ?? [{ path: 'SKILL.md', content: skill.instructions }],
        mcpApps: skill.mcpApps,
      };
    },

    skill_update: async (req: any, ctx: IPCContext) => {
      if (!providers.storage?.documents) return { ok: false, error: 'No storage provider' };
      const agentName = ctx.agentId ?? 'main';
      const existing = await getSkill(providers.storage.documents, agentName, req.slug);
      if (!existing) return { ok: false, error: 'Skill not found' };

      // Update the specific file, or add it if new
      const files = existing.files ?? [{ path: 'SKILL.md', content: existing.instructions }];
      const idx = files.findIndex(f => f.path === req.path);
      if (idx >= 0) {
        files[idx].content = req.content;
      } else {
        files.push({ path: req.path, content: req.content });
      }

      // If SKILL.md was updated, also update instructions
      const skillMd = files.find(f => f.path === 'SKILL.md');
      const instructions = skillMd?.content ?? existing.instructions;

      await upsertSkill(providers.storage.documents, {
        ...existing,
        instructions,
        files,
      });

      await providers.audit.log({
        action: 'skill_update',
        sessionId: ctx.sessionId,
        args: { slug: req.slug, path: req.path },
        result: 'success',
      });

      return { ok: true, updated: req.path };
    },

    skill_delete: async (req: any, ctx: IPCContext) => {
      if (!providers.storage?.documents) return { ok: false, error: 'No storage provider' };
      const agentName = ctx.agentId ?? 'main';
      const deleted = await deleteSkill(providers.storage.documents, agentName, req.slug);

      await providers.audit.log({
        action: 'skill_delete',
        sessionId: ctx.sessionId,
        args: { slug: req.slug },
        result: deleted ? 'success' : 'not_found',
      });

      return { ok: deleted, slug: req.slug };
    },
```

Add imports at the top of the file:
```typescript
import { upsertSkill, getSkill, listSkills, deleteSkill } from '../../providers/storage/skills.js';
```

**Step 4: Update `skill_install` handler to store files**

In the existing `skill_install` handler in `src/host/ipc-handlers/skills.ts`, update the `upsertSkill` call (~line 113) to include files:

```typescript
          await upsertSkill(providers.storage.documents, {
            id: slug,
            agentId: agentName,
            version: '1.0.0',
            instructions: skillMd.content,
            files: pkg.files.map(f => ({ path: f.path, content: f.content })),
            mcpApps,
          });
```

**Step 5: Update tool catalog**

In `src/agent/tool-catalog.ts:202-218`, replace the singleton skill tool with a multi-op tool:

```typescript
  {
    name: 'skill',
    label: 'Skill',
    description:
      'Install, list, read, update, and delete skills.\n\nUse `type` to select:\n' +
      '- install: Install a skill from ClawHub by slug or search query\n' +
      '- list: List all installed skills\n' +
      '- read: Read a skill\'s files by slug\n' +
      '- update: Update a specific file in a skill\n' +
      '- delete: Uninstall a skill by slug',
    parameters: Type.Union([
      Type.Object({
        type: Type.Literal('install'),
        slug: Type.Optional(Type.String({ description: 'ClawHub skill slug' })),
        query: Type.Optional(Type.String({ description: 'Search query' })),
      }),
      Type.Object({
        type: Type.Literal('list'),
      }),
      Type.Object({
        type: Type.Literal('read'),
        slug: Type.String({ description: 'Skill slug to read' }),
      }),
      Type.Object({
        type: Type.Literal('update'),
        slug: Type.String({ description: 'Skill slug to update' }),
        path: Type.String({ description: 'File path within the skill (e.g. "SKILL.md")' }),
        content: Type.String({ description: 'New file content' }),
      }),
      Type.Object({
        type: Type.Literal('delete'),
        slug: Type.String({ description: 'Skill slug to delete' }),
      }),
    ]),
    category: 'skill',
    actionMap: {
      install: 'skill_install',
      list: 'skill_list',
      read: 'skill_read',
      update: 'skill_update',
      delete: 'skill_delete',
    },
  },
```

**Step 6: Write tests**

```typescript
// tests/host/ipc-handlers/skills-crud.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { upsertSkill, getSkill, listSkills, deleteSkill } from '../../../src/providers/storage/skills.js';

// Use an in-memory DocumentStore mock
function createMockDocStore() {
  const store = new Map<string, Map<string, string>>();
  return {
    async put(collection: string, key: string, value: string) {
      if (!store.has(collection)) store.set(collection, new Map());
      store.get(collection)!.set(key, value);
    },
    async get(collection: string, key: string) {
      return store.get(collection)?.get(key) ?? null;
    },
    async list(collection: string) {
      return [...(store.get(collection)?.keys() ?? [])];
    },
    async delete(collection: string, key: string) {
      return store.get(collection)?.delete(key) ?? false;
    },
  };
}

describe('skill CRUD with files', () => {
  let docs: ReturnType<typeof createMockDocStore>;

  beforeEach(() => { docs = createMockDocStore(); });

  it('upsertSkill stores files array', async () => {
    await upsertSkill(docs as any, {
      id: 'linear',
      agentId: 'main',
      version: '1.0.0',
      instructions: '# Linear Skill',
      files: [
        { path: 'SKILL.md', content: '# Linear Skill' },
        { path: 'schema.json', content: '{}' },
      ],
      mcpApps: ['linear'],
    });

    const skill = await getSkill(docs as any, 'main', 'linear');
    expect(skill).not.toBeNull();
    expect(skill!.files).toHaveLength(2);
    expect(skill!.files[1].path).toBe('schema.json');
  });

  it('upsertSkill defaults files to SKILL.md when omitted', async () => {
    await upsertSkill(docs as any, {
      id: 'test',
      agentId: 'main',
      version: '1.0.0',
      instructions: '# Test',
      mcpApps: [],
    });

    const skill = await getSkill(docs as any, 'main', 'test');
    expect(skill!.files).toHaveLength(1);
    expect(skill!.files[0].path).toBe('SKILL.md');
  });

  it('listSkills returns all skills for agent', async () => {
    await upsertSkill(docs as any, { id: 'a', agentId: 'main', version: '1', instructions: '', mcpApps: [] });
    await upsertSkill(docs as any, { id: 'b', agentId: 'main', version: '1', instructions: '', mcpApps: [] });
    await upsertSkill(docs as any, { id: 'c', agentId: 'other', version: '1', instructions: '', mcpApps: [] });

    const skills = await listSkills(docs as any, 'main');
    expect(skills).toHaveLength(2);
  });

  it('deleteSkill removes from store', async () => {
    await upsertSkill(docs as any, { id: 'x', agentId: 'main', version: '1', instructions: '', mcpApps: [] });
    const deleted = await deleteSkill(docs as any, 'main', 'x');
    expect(deleted).toBe(true);
    const skill = await getSkill(docs as any, 'main', 'x');
    expect(skill).toBeNull();
  });
});
```

**Step 7: Run tests**

Run: `npm test -- --run tests/host/ipc-handlers/skills-crud.test.ts`
Expected: PASS

**Step 8: Commit**

```bash
git add src/providers/storage/skills.ts src/ipc-schemas.ts src/host/ipc-handlers/skills.ts \
        src/agent/tool-catalog.ts tests/host/ipc-handlers/skills-crud.test.ts
git commit -m "feat: add skill CRUD IPC actions with files field"
```

---

### Task 3: Workspace List and Single-File Read IPC Actions

**Files:**
- Modify: `src/ipc-schemas.ts` (add `workspace_list`, `workspace_read` schemas)
- Modify: `src/host/ipc-handlers/workspace.ts` (add handlers)
- Modify: `src/agent/tool-catalog.ts` (add workspace_read tool, update workspace tool)
- Test: `tests/host/ipc-handlers/workspace-list-read.test.ts`

**Context:** The workspace provider already has `listFiles(scope, id)` and `downloadScope(scope, id)` methods (`src/providers/workspace/types.ts:125,129`). We need IPC actions to expose these to the agent. `workspace_read` should return a single file (not bulk like `downloadScope`). For the read path, we can use `downloadScope` and filter to the requested path — or we can read from GCS directly. Using `downloadScope` + filter is simpler.

**Step 1: Add IPC schemas**

In `src/ipc-schemas.ts`, after `WorkspaceWriteSchema` (~line 282):

```typescript
export const WorkspaceListSchema = ipcAction('workspace_list', {
  scope: z.enum(['agent', 'user', 'session']),
  prefix: safeString(1024).optional(),
});

export const WorkspaceReadSchema = ipcAction('workspace_read', {
  scope: z.enum(['agent', 'user', 'session']),
  path: safeString(1024),
});
```

**Step 2: Add IPC handlers**

In `src/host/ipc-handlers/workspace.ts`, add to the returned object:

```typescript
    workspace_list: async (req: any, ctx: IPCContext) => {
      if (!providers.workspace?.listFiles) {
        return { ok: false, error: 'Workspace provider does not support listing' };
      }
      const scope = req.scope as WorkspaceScope;
      const id = scope === 'session' ? ctx.sessionId
        : scope === 'user' ? (ctx.userId ?? ctx.sessionId)
        : opts.agentName;
      const files = await providers.workspace.listFiles(scope, id);

      // Optional prefix filter
      const filtered = req.prefix
        ? files.filter(f => f.path.startsWith(req.prefix))
        : files;

      return { ok: true, files: filtered.map(f => ({ path: f.path, size: f.size })) };
    },

    workspace_read: async (req: any, ctx: IPCContext) => {
      if (!providers.workspace?.downloadScope) {
        return { ok: false, error: 'Workspace provider does not support reading' };
      }
      const scope = req.scope as WorkspaceScope;
      const id = scope === 'session' ? ctx.sessionId
        : scope === 'user' ? (ctx.userId ?? ctx.sessionId)
        : opts.agentName;
      const allFiles = await providers.workspace.downloadScope(scope, id);
      const file = allFiles.find(f => f.path === req.path);
      if (!file) return { ok: false, error: `File not found: ${req.path}` };

      return {
        ok: true,
        path: file.path,
        content: file.content.toString('utf-8'),
        size: file.content.length,
      };
    },
```

**Step 3: Update tool catalog**

Update the existing `workspace_write` tool in `src/agent/tool-catalog.ts` to be a multi-op `workspace` tool, or add `workspace_read` and `workspace_list` as separate tools. Adding them as separate entries is simpler and avoids breaking the existing `workspace_write` tool:

After the existing workspace_write entry (~line 251):

```typescript
  {
    name: 'workspace_read',
    label: 'Read Workspace File',
    description:
      'Read a file from a workspace scope (agent, user, or session). Returns the file content as text.',
    parameters: Type.Object({
      scope: Type.String({ description: '"agent", "user", or "session"' }),
      path: Type.String({ description: 'Relative path within the scope' }),
    }),
    category: 'workspace',
    singletonAction: 'workspace_read',
  },

  {
    name: 'workspace_list',
    label: 'List Workspace Files',
    description:
      'List files in a workspace scope (agent, user, or session). Optionally filter by path prefix.',
    parameters: Type.Object({
      scope: Type.String({ description: '"agent", "user", or "session"' }),
      prefix: Type.Optional(Type.String({ description: 'Filter by path prefix' })),
    }),
    category: 'workspace',
    singletonAction: 'workspace_list',
  },
```

**Step 4: Write tests**

```typescript
// tests/host/ipc-handlers/workspace-list-read.test.ts
import { describe, it, expect } from 'vitest';
import { createWorkspaceHandlers } from '../../../src/host/ipc-handlers/workspace.js';

function mockProviders(files: Array<{ path: string; content: Buffer; size: number }>) {
  return {
    workspace: {
      activeMounts: () => [],
      mount: async () => ({ paths: {} }),
      listFiles: async () => files.map(f => ({ path: f.path, size: f.size })),
      downloadScope: async () => files.map(f => ({ path: f.path, content: f.content })),
    },
    audit: { log: async () => {} },
  } as any;
}

const ctx = { sessionId: 'test-session', agentId: 'main', userId: 'user1' } as any;

describe('workspace_list', () => {
  it('lists all files in scope', async () => {
    const files = [
      { path: 'a.txt', content: Buffer.from('hello'), size: 5 },
      { path: 'dir/b.txt', content: Buffer.from('world'), size: 5 },
    ];
    const handlers = createWorkspaceHandlers(mockProviders(files), { agentName: 'main', profile: '' });
    const result = await handlers.workspace_list({ scope: 'agent' }, ctx);
    expect(result.ok).toBe(true);
    expect(result.files).toHaveLength(2);
  });

  it('filters by prefix', async () => {
    const files = [
      { path: 'a.txt', content: Buffer.from(''), size: 0 },
      { path: 'dir/b.txt', content: Buffer.from(''), size: 0 },
    ];
    const handlers = createWorkspaceHandlers(mockProviders(files), { agentName: 'main', profile: '' });
    const result = await handlers.workspace_list({ scope: 'agent', prefix: 'dir/' }, ctx);
    expect(result.ok).toBe(true);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].path).toBe('dir/b.txt');
  });
});

describe('workspace_read', () => {
  it('reads a single file', async () => {
    const files = [{ path: 'test.md', content: Buffer.from('# Hello'), size: 7 }];
    const handlers = createWorkspaceHandlers(mockProviders(files), { agentName: 'main', profile: '' });
    const result = await handlers.workspace_read({ scope: 'user', path: 'test.md' }, ctx);
    expect(result.ok).toBe(true);
    expect(result.content).toBe('# Hello');
  });

  it('returns error for missing file', async () => {
    const handlers = createWorkspaceHandlers(mockProviders([]), { agentName: 'main', profile: '' });
    const result = await handlers.workspace_read({ scope: 'user', path: 'missing.md' }, ctx);
    expect(result.ok).toBe(false);
  });
});
```

**Step 5: Run tests**

Run: `npm test -- --run tests/host/ipc-handlers/workspace-list-read.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add src/ipc-schemas.ts src/host/ipc-handlers/workspace.ts \
        src/agent/tool-catalog.ts tests/host/ipc-handlers/workspace-list-read.test.ts
git commit -m "feat: add workspace_list and workspace_read IPC actions"
```

---

### Task 4: Session Pod Manager and `/internal/work` Endpoint

**Files:**
- Create: `src/host/session-pod-manager.ts`
- Modify: `src/host/server-k8s.ts` (add `/internal/work` route, replace `processCompletionWithNATS`)
- Test: `tests/host/session-pod-manager.test.ts`

**Context:** Currently each turn spawns a new pod (`processCompletionWithNATS` → `processCompletion` → sandbox spawn). We need a session-pod manager that: (1) tracks `sessionId → pod` mappings, (2) reuses existing pods for the same session, (3) creates new pods on first turn, (4) provides a `/internal/work` endpoint where pods fetch their work payload. The pod calls `GET /internal/work?token={AX_IPC_TOKEN}` on startup instead of subscribing to NATS.

**Step 1: Write the session pod manager**

```typescript
// src/host/session-pod-manager.ts — Tracks session-long pods.
//
// Maps sessionId → active pod. Pods are reused across turns.
// Work payloads are queued per-token; pods fetch via GET /internal/work.

import { getLogger } from '../logger.js';

const logger = getLogger().child({ component: 'session-pod-manager' });

export interface SessionPod {
  podName: string;
  pid: number;
  sessionId: string;
  /** Last IPC activity timestamp (ms). Reset on every IPC call. */
  lastActivity: number;
  /** Timer for the expiry warning (fires 120s before kill). */
  warningTimer?: ReturnType<typeof setTimeout>;
  /** Timer for the final kill (fires after warning period). */
  killTimer?: ReturnType<typeof setTimeout>;
  /** Per-turn token for the current active turn. Null between turns. */
  activeTurnToken: string | null;
  /** Kill function from SandboxProcess. */
  kill: () => void;
}

export interface PendingWork {
  payload: string;
  resolve: (value: string) => void;
  reject: (err: Error) => void;
}

export interface SessionPodManagerOptions {
  idleTimeoutMs: number;       // e.g. 30 * 60 * 1000 (30 min)
  warningLeadMs: number;       // e.g. 120 * 1000 (120s before kill)
  onExpiring?: (sessionId: string, pod: SessionPod) => Promise<void>;
  onKill?: (sessionId: string, pod: SessionPod) => void;
}

export function createSessionPodManager(opts: SessionPodManagerOptions) {
  const sessions = new Map<string, SessionPod>();
  const pendingWork = new Map<string, PendingWork>();  // token → pending work

  function resetIdleTimer(sessionId: string): void {
    const pod = sessions.get(sessionId);
    if (!pod) return;

    pod.lastActivity = Date.now();

    // Clear existing timers
    if (pod.warningTimer) clearTimeout(pod.warningTimer);
    if (pod.killTimer) clearTimeout(pod.killTimer);

    // Set warning timer (fires warningLeadMs before the kill)
    const warningDelay = opts.idleTimeoutMs - opts.warningLeadMs;
    pod.warningTimer = setTimeout(async () => {
      logger.info('session_expiring_warning', { sessionId, podName: pod.podName });
      try {
        await opts.onExpiring?.(sessionId, pod);
      } catch (err) {
        logger.warn('session_expiring_callback_failed', { sessionId, error: (err as Error).message });
      }

      // Set kill timer for after the warning period
      pod.killTimer = setTimeout(() => {
        logger.info('session_pod_idle_kill', { sessionId, podName: pod.podName });
        pod.kill();
        sessions.delete(sessionId);
        opts.onKill?.(sessionId, pod);
      }, opts.warningLeadMs);
      if (pod.killTimer.unref) pod.killTimer.unref();
    }, Math.max(warningDelay, 0));
    if (pod.warningTimer.unref) pod.warningTimer.unref();
  }

  return {
    /** Register a pod for a session. */
    register(sessionId: string, pod: Omit<SessionPod, 'lastActivity' | 'activeTurnToken'>): void {
      const entry: SessionPod = { ...pod, lastActivity: Date.now(), activeTurnToken: null };
      sessions.set(sessionId, entry);
      resetIdleTimer(sessionId);
      logger.info('session_pod_registered', { sessionId, podName: pod.podName });
    },

    /** Get the active pod for a session, or undefined. */
    get(sessionId: string): SessionPod | undefined {
      return sessions.get(sessionId);
    },

    /** Check if session has an active pod. */
    has(sessionId: string): boolean {
      return sessions.has(sessionId);
    },

    /** Remove a session (pod exited or was killed externally). */
    remove(sessionId: string): void {
      const pod = sessions.get(sessionId);
      if (pod) {
        if (pod.warningTimer) clearTimeout(pod.warningTimer);
        if (pod.killTimer) clearTimeout(pod.killTimer);
        sessions.delete(sessionId);
      }
    },

    /** Record IPC activity — resets the idle timer. */
    touch(sessionId: string): void {
      resetIdleTimer(sessionId);
    },

    /** Queue a work payload for a pod to fetch via GET /internal/work. */
    queueWork(token: string, payload: string): Promise<string> {
      return new Promise((resolve, reject) => {
        pendingWork.set(token, { payload, resolve, reject });
      });
    },

    /** Pod calls this to fetch its work. Returns the payload and removes from queue. */
    claimWork(token: string): PendingWork | undefined {
      const work = pendingWork.get(token);
      if (work) pendingWork.delete(token);
      return work;
    },

    /** Get all active sessions (for metrics/debugging). */
    activeSessions(): string[] {
      return [...sessions.keys()];
    },

    /** Shutdown — kill all pods, clear timers. */
    shutdown(): void {
      for (const [sessionId, pod] of sessions) {
        if (pod.warningTimer) clearTimeout(pod.warningTimer);
        if (pod.killTimer) clearTimeout(pod.killTimer);
        pod.kill();
      }
      sessions.clear();
      for (const [, work] of pendingWork) {
        work.reject(new Error('Session pod manager shutting down'));
      }
      pendingWork.clear();
    },
  };
}
```

**Step 2: Write tests**

```typescript
// tests/host/session-pod-manager.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createSessionPodManager } from '../../src/host/session-pod-manager.js';

describe('SessionPodManager', () => {
  let manager: ReturnType<typeof createSessionPodManager>;
  const killFn = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    manager = createSessionPodManager({
      idleTimeoutMs: 30_000,
      warningLeadMs: 5_000,
    });
  });

  afterEach(() => {
    manager.shutdown();
    vi.useRealTimers();
    killFn.mockClear();
  });

  it('registers and retrieves a session pod', () => {
    manager.register('s1', { podName: 'pod-1', pid: 1, sessionId: 's1', kill: killFn });
    expect(manager.has('s1')).toBe(true);
    expect(manager.get('s1')?.podName).toBe('pod-1');
  });

  it('removes a session pod', () => {
    manager.register('s1', { podName: 'pod-1', pid: 1, sessionId: 's1', kill: killFn });
    manager.remove('s1');
    expect(manager.has('s1')).toBe(false);
  });

  it('kills pod after idle timeout', () => {
    manager.register('s1', { podName: 'pod-1', pid: 1, sessionId: 's1', kill: killFn });
    vi.advanceTimersByTime(30_001);
    expect(killFn).toHaveBeenCalled();
    expect(manager.has('s1')).toBe(false);
  });

  it('touch resets idle timer', () => {
    manager.register('s1', { podName: 'pod-1', pid: 1, sessionId: 's1', kill: killFn });
    vi.advanceTimersByTime(20_000);
    manager.touch('s1');
    vi.advanceTimersByTime(20_000);
    expect(killFn).not.toHaveBeenCalled(); // only 20s since touch, not 30s
    vi.advanceTimersByTime(10_001);
    expect(killFn).toHaveBeenCalled();
  });

  it('queues and claims work', () => {
    const promise = manager.queueWork('token-1', '{"msg":"hello"}');
    const work = manager.claimWork('token-1');
    expect(work).toBeDefined();
    expect(work!.payload).toBe('{"msg":"hello"}');
    // Resolve to prevent unhandled rejection
    work!.resolve('done');
  });

  it('claimWork returns undefined for unknown token', () => {
    expect(manager.claimWork('nope')).toBeUndefined();
  });
});
```

**Step 3: Run tests**

Run: `npm test -- --run tests/host/session-pod-manager.test.ts`
Expected: PASS

**Step 4: Add `/internal/work` route to server-k8s.ts**

In `src/host/server-k8s.ts`, within `handleInternalRoutes()`, add before the closing `return false`:

```typescript
    // Pod work fetch: new pod calls this to get its initial work payload
    if (url === '/internal/work' && req.method === 'GET') {
      const token = req.headers.authorization?.replace('Bearer ', '');
      if (!token) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'missing token' }));
        return true;
      }
      const work = sessionPodManager.claimWork(token);
      if (!work) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'no pending work for token' }));
        return true;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(work.payload);
      return true;
    }
```

**Step 5: Commit**

```bash
git add src/host/session-pod-manager.ts tests/host/session-pod-manager.test.ts src/host/server-k8s.ts
git commit -m "feat: add session pod manager with idle timeout and /internal/work endpoint"
```

---

### Task 5: Agent Runner Work Loop (Multi-Turn)

**Files:**
- Modify: `src/agent/runner.ts:640-701` (replace single-shot with work loop)
- Modify: `src/agent/http-ipc-client.ts` (add `fetchWork()` method)
- Test: `tests/agent/runner-work-loop.test.ts`

**Context:** Currently in HTTP mode (`runner.ts:652-674`), the runner calls `waitForNATSWork()` once, processes, then exits. For session-long pods, the runner needs to loop: fetch work → process → send response → fetch next work. The pod exits when `/internal/work` returns 404 (no more work) or the host sends a `session_expiring` signal.

**Step 1: Add `fetchWork()` to HttpIPCClient**

In `src/agent/http-ipc-client.ts`, add a method:

```typescript
  /**
   * Fetch work payload from host. Returns null if no work pending (404).
   * Used by session-long pods to receive each turn's payload.
   */
  async fetchWork(pollIntervalMs = 2000, maxWaitMs = 0): Promise<string | null> {
    const url = `${this.hostUrl}/internal/work`;
    const startTime = Date.now();

    while (true) {
      try {
        const res = await fetch(url, {
          method: 'GET',
          headers: { 'Authorization': `Bearer ${this.token}` },
          signal: AbortSignal.timeout(10_000),
        });

        if (res.ok) {
          return await res.text();
        }

        if (res.status === 404) {
          // No work available yet — poll or give up
          if (maxWaitMs > 0 && (Date.now() - startTime) < maxWaitMs) {
            await new Promise(r => setTimeout(r, pollIntervalMs));
            continue;
          }
          return null;
        }

        logger.warn('fetch_work_error', { status: res.status });
        return null;
      } catch (err) {
        logger.warn('fetch_work_failed', { error: (err as Error).message });
        // If we're in a long poll, keep trying
        if (maxWaitMs > 0 && (Date.now() - startTime) < maxWaitMs) {
          await new Promise(r => setTimeout(r, pollIntervalMs));
          continue;
        }
        return null;
      }
    }
  }
```

**Step 2: Replace the runner's k8s entry point**

In `src/agent/runner.ts`, replace the `isHTTPMode` block (~line 652-674) with a work loop:

```typescript
  if (isHTTPMode) {
    const { HttpIPCClient } = await import('./http-ipc-client.js');
    const client = new HttpIPCClient({ hostUrl: process.env.AX_HOST_URL! });
    await client.connect();
    config.ipcClient = client;

    // Session-long work loop: fetch → process → respond → repeat
    while (true) {
      logger.info('work_loop_waiting');
      // Long-poll for work (wait up to 5 minutes, then re-poll)
      const data = await client.fetchWork(2000, 5 * 60 * 1000);
      if (!data) {
        logger.info('work_loop_no_work');
        continue;
      }

      try {
        const payload = parseStdinPayload(data);
        applyPayload(config, payload);

        // Update IPC client context for this turn
        client.setContext({
          sessionId: config.sessionId,
          requestId: config.requestId,
          userId: config.userId,
          sessionScope: config.sessionScope,
          token: process.env.AX_IPC_TOKEN,
        });

        await run(config);
      } catch (err) {
        logger.error('work_loop_error', { error: (err as Error).message, stack: (err as Error).stack });
        // Send error response back to host
        try {
          await client.call({
            action: 'agent_response',
            content: `Agent error: ${(err as Error).message}`,
            error: true,
          });
        } catch { /* best effort */ }
      }
    }
  }
```

**Step 3: Write test**

```typescript
// tests/agent/runner-work-loop.test.ts
import { describe, it, expect, vi } from 'vitest';
import { HttpIPCClient } from '../../src/agent/http-ipc-client.js';

describe('HttpIPCClient.fetchWork', () => {
  it('returns payload on 200', async () => {
    const client = new HttpIPCClient({ hostUrl: 'http://localhost:9999' });
    // @ts-expect-error — accessing private for test
    client.token = 'test-token';

    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => '{"msg":"hello"}',
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await client.fetchWork(100, 0);
    expect(result).toBe('{"msg":"hello"}');

    vi.unstubAllGlobals();
  });

  it('returns null on 404 with no wait', async () => {
    const client = new HttpIPCClient({ hostUrl: 'http://localhost:9999' });
    // @ts-expect-error
    client.token = 'test-token';

    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: async () => 'not found',
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await client.fetchWork(100, 0);
    expect(result).toBeNull();

    vi.unstubAllGlobals();
  });
});
```

**Step 4: Run tests**

Run: `npm test -- --run tests/agent/runner-work-loop.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/agent/runner.ts src/agent/http-ipc-client.ts tests/agent/runner-work-loop.test.ts
git commit -m "feat: agent runner work loop for session-long pods"
```

---

### Task 6: Idle Timeout with 120s `session_expiring` Warning

**Files:**
- Modify: `src/ipc-schemas.ts` (add `session_expiring` schema)
- Modify: `src/host/server-k8s.ts` (wire session pod manager's `onExpiring` callback to send IPC)
- Modify: `src/agent/runner.ts` (handle `session_expiring` in work loop — save state, exit gracefully)
- Test: `tests/host/session-expiring.test.ts`

**Context:** The session pod manager (Task 4) fires `onExpiring` 120s before killing the pod. We need to: (1) send a `session_expiring` IPC message to the pod, (2) have the agent runner handle it by saving important files and sending a final `agent_response`, and (3) exit the work loop gracefully.

**Step 1: Add IPC schema**

In `src/ipc-schemas.ts`:

```typescript
export const SessionExpiringSchema = ipcAction('session_expiring', {
  secondsRemaining: z.number().int().min(0).max(600),
  reason: z.enum(['idle_timeout', 'shutdown']),
});
```

**Step 2: Wire `onExpiring` in server-k8s.ts**

When creating the session pod manager, provide the callback:

```typescript
const sessionPodManager = createSessionPodManager({
  idleTimeoutMs: (config.sandbox.idle_timeout_sec ?? 1800) * 1000,
  warningLeadMs: 120_000,
  onExpiring: async (sessionId, pod) => {
    // Send session_expiring to the pod via HTTP IPC
    if (pod.activeTurnToken) {
      const entry = activeTokens.get(pod.activeTurnToken);
      if (entry) {
        try {
          await entry.handleIPC(
            JSON.stringify({ action: 'session_expiring', secondsRemaining: 120, reason: 'idle_timeout' }),
            entry.ctx,
          );
        } catch (err) {
          logger.warn('session_expiring_send_failed', { sessionId, error: (err as Error).message });
        }
      }
    }
  },
  onKill: (sessionId) => {
    logger.info('session_pod_killed', { sessionId });
  },
});
```

**Step 3: Handle in agent runner**

The `session_expiring` message arrives as an IPC push to the pod. Since the HttpIPCClient is request-response only, we need an alternative. The simplest approach: the host calls a new endpoint on the pod, or the runner polls a `GET /internal/status` endpoint.

Simpler alternative: when the runner's work loop is idle (between turns), it already polls `/internal/work`. We can have the host return a special `session_expiring` payload type instead of a work payload. The runner checks the payload type and exits:

```typescript
// In the runner work loop:
const data = await client.fetchWork(2000, 5 * 60 * 1000);
if (!data) continue;

const parsed = JSON.parse(data);
if (parsed._type === 'session_expiring') {
  logger.info('session_expiring_received', { secondsRemaining: parsed.secondsRemaining });
  // Agent can save state here via workspace_write IPC calls if needed
  process.exit(0);
}
```

The host queues this as a special work payload when the warning timer fires.

**Step 4: Write test**

```typescript
// tests/host/session-expiring.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createSessionPodManager } from '../../src/host/session-pod-manager.js';

describe('session expiring flow', () => {
  afterEach(() => vi.useRealTimers());

  it('fires onExpiring callback before kill', async () => {
    vi.useFakeTimers();
    const onExpiring = vi.fn();
    const killFn = vi.fn();

    const mgr = createSessionPodManager({
      idleTimeoutMs: 10_000,
      warningLeadMs: 3_000,
      onExpiring,
      onKill: vi.fn(),
    });

    mgr.register('s1', { podName: 'pod-1', pid: 1, sessionId: 's1', kill: killFn });

    // Advance to warning time (10s - 3s = 7s)
    vi.advanceTimersByTime(7_001);
    // onExpiring is async — need to flush microtasks
    await vi.runAllTimersAsync();

    expect(onExpiring).toHaveBeenCalledWith('s1', expect.objectContaining({ podName: 'pod-1' }));
    expect(killFn).not.toHaveBeenCalled(); // not yet killed

    // Advance past the warning period
    vi.advanceTimersByTime(3_001);
    expect(killFn).toHaveBeenCalled();

    mgr.shutdown();
  });
});
```

**Step 5: Run tests**

Run: `npm test -- --run tests/host/session-expiring.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add src/ipc-schemas.ts src/host/server-k8s.ts src/agent/runner.ts tests/host/session-expiring.test.ts
git commit -m "feat: idle timeout with 120s session_expiring warning"
```

---

### Task 7: Remove NATS from Host

**Files:**
- Modify: `src/host/server-k8s.ts` (remove NATS connection, `publishWork`, NATS-specific code)
- Delete references to: `waitForNATSWork` in `src/agent/runner.ts`
- Modify: `src/host/server-completions.ts` (remove `publishWork` and `agentResponsePromise` from `CompletionDeps`)
- Delete: `src/host/nats-session-protocol.ts`
- Delete: `src/providers/eventbus/nats.ts` (optional — can keep but mark deprecated)
- Modify: `src/host/provider-map.ts:88` (remove `nats` from eventbus map, or keep for backward compat)

**Context:** With session-long pods fetching work via `GET /internal/work` and the eventbus moved to Postgres, NATS has no remaining uses in the k8s path. The host no longer needs `nc.request('sandbox.work')` or the NATS connection at all.

**Step 1: Remove NATS connection from server-k8s.ts**

In `src/host/server-k8s.ts`:
- Remove the NATS import and `nc` connection (~line 111-113)
- Remove the `publishWork` function (~line 304-332)
- Remove `agentResponsePromise`/`agentResponseResolve`/`agentResponseReject` (~line 213-227)
- Remove `startAgentResponseTimer` (~line 337-346)
- Remove `nc.drain()` from shutdown (~line 706)
- Simplify `processCompletionWithNATS` to `processCompletionForSession` — it now just:
  1. Registers the turn token
  2. Queues work in session pod manager
  3. Waits for the agent_response IPC callback
  4. Returns the response

**Step 2: Remove `waitForNATSWork` from runner.ts**

In `src/agent/runner.ts`:
- Delete the `waitForNATSWork()` function (~line 603-637)
- The HTTP mode work loop (from Task 5) replaces it entirely

**Step 3: Remove workspace release intercept from wrappedHandleIPC**

The `workspace_release` action and staging store are no longer needed (removed in Task 8). For now, remove the `workspace_release` intercept from `wrappedHandleIPC` (~line 236-276) but keep the `agent_response` intercept.

**Step 4: Delete nats-session-protocol.ts**

```bash
rm src/host/nats-session-protocol.ts
```

**Step 5: Clean up CompletionDeps**

In `src/host/server-completions.ts`, remove from `CompletionDeps`:
- `publishWork`
- `agentResponsePromise`
- `startAgentResponseTimer`

**Step 6: Run full test suite**

Run: `npm test`
Expected: PASS (some NATS-specific tests may need updating/deletion)

**Step 7: Commit**

```bash
git add -u  # stages all modifications and deletions
git commit -m "refactor: remove NATS dependency from host and agent"
```

---

### Task 8: Remove Workspace Provision/Release

**Files:**
- Modify: `src/host/server-k8s.ts` (remove `/internal/workspace/release`, `/internal/workspace/provision`, `/internal/workspace-staging` routes, remove stagingStore)
- Modify: `src/host/server-completions.ts` (remove workspace provisioning logic from processCompletion)
- Modify: `src/agent/runner.ts` (remove `provisionWorkspaceFromPayload`)
- Delete: `src/host/workspace-release-screener.ts` (or keep if still used for workspace_write scanning)
- Modify: `src/providers/sandbox/k8s.ts` (simplify buildPodSpec — see Task 9)

**Context:** With workspace_read/write/list going through IPC (Task 3), pods no longer need workspace provisioning at startup or release at shutdown. The staging store, screening, and all `/internal/workspace/*` routes (except `/internal/work` and `/internal/ipc`) can be removed.

**Step 1: Remove routes from server-k8s.ts**

In `handleInternalRoutes()`:
- Delete the `/internal/workspace/release` handler (~line 446-506)
- Delete the `/internal/workspace/provision` handler (~line 509-546)
- Delete the `/internal/workspace-staging` handler (~line 549-557)
- Delete the `stagingStore` Map and `cleanupStaging()` function (~line 59-81)
- Delete the `handleWorkspaceStaging()` function (~line 414-440)
- Remove the staging cleanup interval (~line 91-92)

**Step 2: Remove provisioning from processCompletion**

In `src/host/server-completions.ts`, find where workspace provisioning happens in the sandbox path and remove it. The pod now starts with an empty `/workspace` and uses IPC for all file access.

**Step 3: Remove provisionWorkspaceFromPayload from runner**

In `src/agent/runner.ts`, remove the `provisionWorkspaceFromPayload` call and function. The pod doesn't provision workspace files from GCS on startup anymore.

**Step 4: Run test suite**

Run: `npm test`
Expected: PASS (workspace release tests will need updating/deletion)

**Step 5: Commit**

```bash
git add -u
git commit -m "refactor: remove workspace provision/release cycle"
```

---

### Task 9: Simplify Pod Spec and Helm Chart

**Files:**
- Modify: `src/providers/sandbox/k8s.ts:47-164` (simplify `buildPodSpec`)
- Modify: `charts/ax/Chart.yaml` (remove NATS dependency)
- Delete: `charts/ax/templates/nats-auth-secret.yaml`
- Delete: `charts/ax/templates/nats-stream-init-job.yaml`
- Delete: `charts/ax/templates/pool-controller/` (entire directory)
- Modify: `charts/ax/values.yaml` (remove NATS and pool-controller sections, add eventbus: postgres)
- Modify: `charts/ax/templates/host/deployment.yaml` (remove NATS env vars)
- Modify: `charts/ax/templates/networkpolicies/` (remove NATS-related rules)

**Step 1: Simplify buildPodSpec**

In `src/providers/sandbox/k8s.ts`, update `buildPodSpec`:

```typescript
function buildPodSpec(podName: string, config: SandboxConfig, options: {
  image: string;
  namespace: string;
  runtimeClass: string;
}) {
  const [cmd, ...args] = config.command;
  const envVars = canonicalEnv(config);

  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: podName,
      namespace: options.namespace,
      labels: {
        'app.kubernetes.io/name': 'ax-sandbox',
        'app.kubernetes.io/component': 'execution',
        'ax.io/plane': 'execution',
      },
    },
    spec: {
      ...(options.runtimeClass ? { runtimeClassName: options.runtimeClass } : {}),
      restartPolicy: 'Never',
      automountServiceAccountToken: false,
      hostNetwork: false,
      ...(process.env.K8S_IMAGE_PULL_SECRETS ? {
        imagePullSecrets: process.env.K8S_IMAGE_PULL_SECRETS.split(',').map(s => ({ name: s.trim() })),
      } : {}),
      containers: [{
        name: 'sandbox',
        image: options.image,
        ...(process.env.K8S_IMAGE_PULL_POLICY ? { imagePullPolicy: process.env.K8S_IMAGE_PULL_POLICY } : {}),
        command: [cmd, ...args],
        workingDir: '/workspace',
        resources: {
          requests: {
            cpu: DEFAULT_CPU_LIMIT,
            memory: config.memoryMB ? `${config.memoryMB}Mi` : DEFAULT_MEMORY_LIMIT,
          },
          limits: {
            cpu: DEFAULT_CPU_LIMIT,
            memory: config.memoryMB ? `${config.memoryMB}Mi` : DEFAULT_MEMORY_LIMIT,
          },
        },
        securityContext: {
          // Writable root: allows npm install, pip install, etc.
          readOnlyRootFilesystem: false,
          allowPrivilegeEscalation: false,
          runAsNonRoot: true,
          runAsUser: 1000,
          capabilities: { drop: ['ALL'] },
        },
        env: [
          // No NATS env vars — work comes via HTTP
          { name: 'LOG_LEVEL', value: process.env.K8S_POD_LOG_LEVEL ?? (process.env.AX_VERBOSE === '1' ? 'debug' : 'warn') },
          ...Object.entries(envVars)
            .filter(([k]) => k !== 'AX_IPC_SOCKET' && k !== 'AX_WEB_PROXY_SOCKET')
            .map(([name, value]) => ({ name, value })),
          ...Object.entries(config.extraEnv ?? {})
            .map(([name, value]) => ({ name, value })),
          { name: 'POD_NAME', valueFrom: { fieldRef: { fieldPath: 'metadata.name' } } },
        ],
        volumeMounts: [
          { name: 'workspace', mountPath: '/workspace' },
          { name: 'tmp', mountPath: '/tmp' },
        ],
      }],
      volumes: [
        { name: 'workspace', emptyDir: { sizeLimit: '2Gi' } },
        { name: 'tmp', emptyDir: { sizeLimit: '256Mi' } },
      ],
      // No activeDeadlineSeconds — host manages lifecycle via idle timeout
    },
  };
}
```

Key changes:
- `readOnlyRootFilesystem: false` (allows package installs)
- 2 volumes instead of 4 (workspace + tmp only)
- No NATS env vars
- No `activeDeadlineSeconds` (host manages lifecycle)
- Removed `natsUrl` from options

**Step 2: Remove NATS from helm chart**

In `charts/ax/Chart.yaml`, remove the NATS dependency:

```yaml
dependencies:
  - name: postgresql
    version: "16.x.x"
    repository: "https://charts.bitnami.com/bitnami"
    condition: postgresql.internal.enabled
```

**Step 3: Delete NATS and pool-controller templates**

```bash
rm charts/ax/templates/nats-auth-secret.yaml
rm charts/ax/templates/nats-stream-init-job.yaml
rm -rf charts/ax/templates/pool-controller/
```

**Step 4: Update values.yaml**

Remove NATS and pool-controller sections. Add `eventbus: postgres` to the config block. Remove NATS env var references from host deployment.

**Step 5: Update network policies**

Remove NATS-related egress/ingress rules from `charts/ax/templates/networkpolicies/`.

**Step 6: Run helm template to verify**

```bash
cd charts/ax && helm dependency update && helm template . --debug
```
Expected: renders without errors, no NATS references

**Step 7: Commit**

```bash
git add -u
git add charts/ax/  # catch any new files
git commit -m "refactor: simplify pod spec, remove NATS and pool-controller from helm chart"
```

---

## Post-Implementation: Optional Fast-Follows

These are NOT part of the core plan but should be tracked for later:

### GCS Workspace Snapshots
When the `session_expiring` warning fires, the agent saves `/workspace` state to GCS as a tarball. Next pod for the same session restores from this snapshot. Adds resilience for long-running sessions.

### Workspace Read Optimization
Current `workspace_read` uses `downloadScope()` which fetches ALL files then filters. For large scopes, add a `readFile(scope, id, path)` method to the workspace provider that reads a single file from GCS.

### Multi-Host Sticky Sessions
If scaling to multiple host pods, SSE events from the Postgres eventbus already work cross-host. But session pod management needs to be host-affine (only one host manages a given session's pod). Use Postgres advisory locks or a sessions table to claim session ownership.

---

## Config Changes Summary

```yaml
# ax.yaml (before)
providers:
  eventbus: nats
  sandbox: k8s

# ax.yaml (after)
providers:
  eventbus: postgres
  sandbox: k8s

sandbox:
  idle_timeout_sec: 1800   # 30 min idle before pod kill
```

No more NATS config, pool-controller config, or warm pool settings.
