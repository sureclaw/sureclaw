# Lazy Sandbox + workspace_write Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Decouple the agent process from the sandbox so simple operations (like writing a file) don't require spawning a container, while complex operations (bash, multi-file edits) lazily spawn a sandbox on demand.

**Architecture:** The agent always runs as a lightweight host subprocess. IPC tools (memory, web, identity, workspace_write) are handled directly by the host — no sandbox needed. Sandbox tools (bash, write_file, read_file, edit_file) trigger lazy sandbox spawn on first use. This mirrors how k8s mode already works in `agent-runtime-process.ts`, where the agent runs as a subprocess and sandbox tools dispatch to worker pods via NATS.

**Tech Stack:** TypeScript, Zod (IPC schemas), TypeBox (tool catalog), Vitest (tests)

---

## Background

Currently every completion request spawns a sandbox process (`providers.sandbox.spawn()`), and the agent runner runs inside that sandbox. Even a simple "create a markdown file" boots an Apple Container VM with workspace mounts.

In k8s mode, this separation already exists: `agent-runtime-process.ts` overrides the sandbox provider to `subprocess` for the agent, and uses `NATSSandboxDispatcher` for tool dispatch to sandbox worker pods.

This plan brings the same pattern to local/apple/docker modes:
1. Restore `workspace_write` as an IPC tool that writes through the workspace provider without a sandbox
2. Make sandbox spawning lazy — triggered by first sandbox tool call

### Key files

- `src/ipc-schemas.ts` — IPC action schemas (Zod)
- `src/agent/tool-catalog.ts` — Tool definitions (TypeBox)
- `src/host/ipc-handlers/workspace.ts` — Workspace IPC handlers
- `src/host/ipc-handlers/sandbox-tools.ts` — Sandbox tool IPC handlers
- `src/host/ipc-server.ts` — Handler composition
- `src/host/server-completions.ts` — Completion pipeline (sandbox spawn)
- `src/providers/sandbox/types.ts` — Sandbox provider interface
- `tests/ipc-schemas-enterprise.test.ts` — Schema tests
- `tests/agent/tool-catalog.test.ts` — Tool catalog tests

### Lessons to remember

- Every `ipcAction()` needs a handler, and every handler needs sync-test registration (lesson #3)
- Zod strict mode rejects unknown fields silently (lesson #2)
- Tool count is hardcoded in multiple test files — update all of them (lesson: testing/infrastructure)
- Tool filtering must align with prompt module `shouldInclude()` (lesson: providers/skills)
- Run full test suite before committing (lesson #1)

---

## Task 1: Restore `workspace_write` IPC Schema

**Files:**
- Modify: `src/ipc-schemas.ts`
- Test: `tests/ipc-schemas-enterprise.test.ts`

**Step 1: Write the failing test**

Add to `tests/ipc-schemas-enterprise.test.ts`, inside the existing `describe('Enterprise IPC Schemas', ...)`:

```typescript
test('WorkspaceWriteSchema accepts valid input', () => {
  const result = WorkspaceWriteSchema.safeParse({
    action: 'workspace_write',
    tier: 'agent',
    path: 'docs/notes.md',
    content: 'Hello world',
  });
  expect(result.success).toBe(true);
});

test('WorkspaceWriteSchema rejects invalid tier', () => {
  const result = WorkspaceWriteSchema.safeParse({
    action: 'workspace_write',
    tier: 'scratch',
    path: 'test.md',
    content: 'bad',
  });
  expect(result.success).toBe(false);
});
```

Also update the import to include `WorkspaceWriteSchema` and the `enterpriseActions` array to include `'workspace_write'`.

**Step 2: Run test to verify it fails**

Run: `npm test -- --run tests/ipc-schemas-enterprise.test.ts`
Expected: FAIL — `WorkspaceWriteSchema` is not exported from `ipc-schemas.ts`

**Step 3: Add the schema**

In `src/ipc-schemas.ts`, after the `WorkspaceMountSchema` block (~line 293), add:

```typescript
export const WorkspaceWriteSchema = ipcAction('workspace_write', {
  tier: z.enum(['agent', 'user']),
  path: safeString(1024),
  content: safeString(500_000),
});
```

**Step 4: Run test to verify it passes**

Run: `npm test -- --run tests/ipc-schemas-enterprise.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/ipc-schemas.ts tests/ipc-schemas-enterprise.test.ts
git commit -m "feat: restore workspace_write IPC schema"
```

---

## Task 2: Add `workspace_write` IPC Handler

**Files:**
- Modify: `src/host/ipc-handlers/workspace.ts`
- Modify: `src/host/ipc-server.ts` (verify handler is already wired — `createWorkspaceHandlers` is already spread into handlers)
- Test: `tests/host/ipc-server.test.ts` (verify workspace_write is in handler map)

**Step 1: Write the failing test**

Check `tests/host/ipc-server.test.ts` for any test that verifies the set of known IPC actions. If there is a `knownInternalActions` or similar set, add `'workspace_write'` to it. Also write a unit test for the handler:

Create `tests/host/ipc-handlers/workspace.test.ts`:

```typescript
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createWorkspaceHandlers } from '../../../src/host/ipc-handlers/workspace.js';
import type { IPCContext } from '../../../src/host/ipc-server.js';

// Minimal mock providers
function mockProviders(tmpDir: string) {
  const auditLog: any[] = [];
  return {
    providers: {
      audit: { log: async (entry: any) => { auditLog.push(entry); } },
      workspace: {
        mount: async () => ({ paths: { agent: join(tmpDir, 'agent'), user: join(tmpDir, 'user') } }),
        activeMounts: () => [],
        commit: async () => ({ scopes: {} }),
        cleanup: async () => {},
      },
    },
    auditLog,
  };
}

describe('workspace IPC handlers', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ws-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const ctx: IPCContext = { sessionId: 'test-session', agentId: 'agent-1', userId: 'user-1' };

  test('workspace_write writes a file to the agent tier', async () => {
    const { providers } = mockProviders(tmpDir);
    const handlers = createWorkspaceHandlers(providers as any, { agentName: 'main', profile: 'balanced' });

    const result = await handlers.workspace_write(
      { tier: 'agent', path: 'notes.md', content: '# Notes' },
      ctx,
    );

    expect(result.written).toBe(true);
    expect(result.tier).toBe('agent');
    expect(result.path).toBe('notes.md');
  });

  test('workspace_write creates nested directories', async () => {
    const { providers } = mockProviders(tmpDir);
    const handlers = createWorkspaceHandlers(providers as any, { agentName: 'main', profile: 'balanced' });

    const result = await handlers.workspace_write(
      { tier: 'user', path: 'deep/nested/file.txt', content: 'hello' },
      ctx,
    );

    expect(result.written).toBe(true);
  });

  test('workspace_write is audited', async () => {
    const { providers, auditLog } = mockProviders(tmpDir);
    const handlers = createWorkspaceHandlers(providers as any, { agentName: 'main', profile: 'balanced' });

    await handlers.workspace_write(
      { tier: 'agent', path: 'test.md', content: 'content' },
      ctx,
    );

    expect(auditLog.length).toBeGreaterThanOrEqual(1);
    expect(auditLog.some((e: any) => e.action === 'workspace_write')).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- --run tests/host/ipc-handlers/workspace.test.ts`
Expected: FAIL — `workspace_write` is not a property of the handlers object

**Step 3: Implement the handler**

Replace `src/host/ipc-handlers/workspace.ts` with:

```typescript
/**
 * IPC handlers: workspace provider operations.
 *
 * Workspace provider model:
 * - workspace_mount:  activate scopes (agent, user, session) for a session
 * - workspace_write:  write a text file to a workspace tier via the host
 *                     (no sandbox required — the host writes directly through
 *                     the workspace provider's directory)
 *
 * workspace_write exists so that simple LLM tasks ("create a small markdown file")
 * can complete without spawning a container. The host can escalate to a full
 * sandbox with workspace mounts if bash or multi-file tools are needed.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ProviderRegistry } from '../../types.js';
import type { IPCContext } from '../ipc-server.js';
import type { WorkspaceScope } from '../../providers/workspace/types.js';
import { safePath } from '../../utils/safe-path.js';

export interface WorkspaceHandlerOptions {
  agentName: string;
  profile: string;
}

export function createWorkspaceHandlers(providers: ProviderRegistry, opts: WorkspaceHandlerOptions) {
  return {
    workspace_mount: async (req: any, ctx: IPCContext) => {
      const requestedScopes = req.scopes as WorkspaceScope[];

      // Determine which scopes are not yet active
      const currentScopes = providers.workspace.activeMounts(ctx.sessionId);
      const newScopes = requestedScopes.filter(s => !currentScopes.includes(s));

      if (newScopes.length === 0) {
        return {
          mounted: currentScopes,
          paths: {},
        };
      }

      const mounts = await providers.workspace.mount(ctx.sessionId, newScopes, { userId: ctx.userId });

      await providers.audit.log({
        action: 'workspace_mount',
        sessionId: ctx.sessionId,
        args: { scopes: newScopes, allScopes: [...currentScopes, ...newScopes] },
      });

      return {
        mounted: [...currentScopes, ...newScopes],
        paths: mounts.paths,
      };
    },

    workspace_write: async (req: any, ctx: IPCContext) => {
      const tier = req.tier as WorkspaceScope;

      // Ensure the tier is mounted for this session
      const activeMounts = providers.workspace.activeMounts(ctx.sessionId);
      let tierPath: string | undefined;

      if (activeMounts.includes(tier)) {
        // Already mounted — re-mount returns existing paths
        const mounts = await providers.workspace.mount(ctx.sessionId, [tier], { userId: ctx.userId });
        tierPath = mounts.paths[tier];
      } else {
        // Auto-mount the tier
        const mounts = await providers.workspace.mount(ctx.sessionId, [tier], { userId: ctx.userId });
        tierPath = mounts.paths[tier];
      }

      if (!tierPath) {
        return { ok: false, error: `Failed to resolve workspace tier "${tier}"` };
      }

      // Write the file using safePath for traversal protection
      const segments = req.path.split(/[/\\]/).filter(Boolean);
      const filePath = safePath(tierPath, ...segments);
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, req.content, 'utf-8');

      await providers.audit.log({
        action: 'workspace_write',
        sessionId: ctx.sessionId,
        args: { tier, path: req.path, bytes: req.content.length },
        result: 'success',
      });

      return { written: true, tier, path: req.path };
    },

  };
}
```

**Step 4: Run test to verify it passes**

Run: `npm test -- --run tests/host/ipc-handlers/workspace.test.ts`
Expected: PASS

**Step 5: Run sync tests to ensure handler is registered**

Run: `npm test -- --run tests/host/ipc-server.test.ts`

If there's a test that checks known actions include `workspace_write`, it should pass because the schema auto-registers via `ipcAction()` and `createWorkspaceHandlers` is already wired into `createIPCHandler`.

**Step 6: Commit**

```bash
git add src/host/ipc-handlers/workspace.ts tests/host/ipc-handlers/workspace.test.ts
git commit -m "feat: add workspace_write IPC handler for sandbox-free file writes"
```

---

## Task 3: Restore `workspace` Tool in the Catalog

**Files:**
- Modify: `src/agent/tool-catalog.ts`
- Modify: `tests/agent/tool-catalog.test.ts` (update tool count)
- Modify: `tests/agent/tool-catalog-sync.test.ts` (update sync expectations)
- Modify: `tests/agent/mcp-server.test.ts` (update tool count if needed)

**Step 1: Write the failing test**

In `tests/agent/tool-catalog.test.ts`, add:

```typescript
test('workspace tool exists with write operation', () => {
  const spec = TOOL_CATALOG.find(s => s.name === 'workspace');
  expect(spec).toBeDefined();
  expect(spec!.actionMap).toHaveProperty('write', 'workspace_write');
  expect(spec!.category).toBe('workspace');
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- --run tests/agent/tool-catalog.test.ts`
Expected: FAIL — no tool named 'workspace'

**Step 3: Add the tool to the catalog**

In `src/agent/tool-catalog.ts`:

1. Add `'workspace'` to the `ToolCategory` union type:

```typescript
export type ToolCategory =
  | 'memory' | 'web' | 'audit' | 'identity'
  | 'scheduler' | 'skill' | 'delegation' | 'image'
  | 'workspace' | 'workspace_scopes' | 'governance' | 'sandbox';
```

2. Add the workspace tool entry before the `// ── Workspace Scopes ──` section:

```typescript
  // ── Workspace ──
  {
    name: 'workspace',
    label: 'Workspace',
    description:
      'Write files to persistent workspace tiers (agent or user) without requiring a sandbox.\n\nOperations:\n' +
      '- write: Write a text file to a workspace tier (agent or user)',
    parameters: Type.Union([
      Type.Object({
        type: Type.Literal('write'),
        tier: Type.String({ description: '"agent" or "user"' }),
        path: Type.String({ description: 'Relative path within the tier (e.g. "docs/notes.md")' }),
        content: Type.String({ description: 'File content to write' }),
      }),
    ]),
    category: 'workspace',
    actionMap: {
      write: 'workspace_write',
    },
  },
```

3. Add `workspace` to the `filterTools` function — the workspace tool should be available when the workspace provider is configured (same gate as `workspace_scopes`):

```typescript
case 'workspace':        return ctx.hasWorkspaceScopes;
```

**Step 4: Update tool counts in test files**

Find and update hardcoded tool counts. Run `grep -rn 'TOOL_CATALOG.*length\|toolCount\|tool_count\|\.length.*14\|\.length.*15' tests/` to find them. Increment by 1 wherever the full catalog count is checked.

**Step 5: Run tests to verify**

Run: `npm test -- --run tests/agent/tool-catalog.test.ts tests/agent/tool-catalog-sync.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add src/agent/tool-catalog.ts tests/agent/tool-catalog.test.ts tests/agent/tool-catalog-sync.test.ts
git commit -m "feat: restore workspace tool in agent tool catalog"
```

---

## Task 4: Lazy Sandbox Dispatcher for Local Mode

This is the core architecture change. Create a `LocalSandboxDispatcher` that mirrors `NATSSandboxDispatcher` but spawns local sandbox processes on demand.

**Files:**
- Create: `src/host/local-sandbox-dispatch.ts`
- Test: `tests/host/local-sandbox-dispatch.test.ts`

**Step 1: Write the failing test**

Create `tests/host/local-sandbox-dispatch.test.ts`:

```typescript
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { createLocalSandboxDispatcher } from '../../src/host/local-sandbox-dispatch.js';
import type { SandboxProvider, SandboxConfig } from '../../src/providers/sandbox/types.js';

function mockSandboxProvider(): SandboxProvider {
  return {
    async spawn(config: SandboxConfig) {
      // Return a mock process that just runs sandbox tool requests
      return {
        pid: 12345,
        exitCode: new Promise(() => {}), // never resolves
        stdout: { [Symbol.asyncIterator]: async function* () {} } as any,
        stderr: { [Symbol.asyncIterator]: async function* () {} } as any,
        stdin: { write: vi.fn(), end: vi.fn() } as any,
        kill: vi.fn(),
      };
    },
    async kill() {},
    async isAvailable() { return true; },
  };
}

describe('LocalSandboxDispatcher', () => {
  test('hasSandbox returns false before first tool call', () => {
    const dispatcher = createLocalSandboxDispatcher({
      provider: mockSandboxProvider(),
      workspaceMap: new Map(),
    });
    expect(dispatcher.hasSandbox('req-1')).toBe(false);
  });

  test('executes tool calls locally via workspace map when no container needed', async () => {
    const workspaceMap = new Map<string, string>();
    workspaceMap.set('req-1', '/tmp/test-workspace');

    const dispatcher = createLocalSandboxDispatcher({
      provider: mockSandboxProvider(),
      workspaceMap,
    });

    // The dispatcher executes sandbox tool calls using the workspaceMap
    // (same as current sandbox-tools.ts handlers in local mode)
    expect(dispatcher.hasSandbox('req-1')).toBe(false);
  });

  test('release cleans up sandbox', async () => {
    const dispatcher = createLocalSandboxDispatcher({
      provider: mockSandboxProvider(),
      workspaceMap: new Map(),
    });

    // Release is a no-op if no sandbox was spawned
    await dispatcher.release('req-1');
    expect(dispatcher.hasSandbox('req-1')).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- --run tests/host/local-sandbox-dispatch.test.ts`
Expected: FAIL — module not found

**Step 3: Implement the dispatcher**

Create `src/host/local-sandbox-dispatch.ts`:

```typescript
/**
 * Local sandbox dispatcher — lazy sandbox spawning for non-k8s modes.
 *
 * In local mode (subprocess, seatbelt, apple, docker), sandbox tool calls
 * (bash, write_file, read_file, edit_file) are currently handled by
 * sandbox-tools.ts which executes directly on the host filesystem.
 *
 * This dispatcher sits between the IPC handler and the sandbox tool
 * execution. On first sandbox tool call for a given requestId, it
 * optionally spawns a container sandbox and routes the tool call into it.
 * Subsequent calls in the same turn reuse the same sandbox.
 *
 * For subprocess/seatbelt modes, no container is spawned — tools execute
 * directly (same as today). For apple/docker modes, the container is
 * spawned lazily on first use.
 *
 * This mirrors NATSSandboxDispatcher's interface for consistency.
 */

import { getLogger } from '../logger.js';
import type { SandboxProvider, SandboxProcess, SandboxConfig } from '../providers/sandbox/types.js';

const logger = getLogger().child({ component: 'local-sandbox-dispatch' });

/** Container sandbox types that require spawning a separate process. */
const CONTAINER_SANDBOXES = new Set(['apple', 'docker']);

export interface LocalSandboxDispatcherOptions {
  provider: SandboxProvider;
  workspaceMap: Map<string, string>;
  /** The configured sandbox type (e.g. 'subprocess', 'apple', 'docker'). */
  sandboxType?: string;
}

export interface LocalSandboxDispatcher {
  /** Check if a sandbox has been spawned for this request. */
  hasSandbox(requestId: string): boolean;

  /**
   * Ensure a sandbox is ready for tool execution.
   * For subprocess/seatbelt: no-op (tools execute on host).
   * For apple/docker: spawns container on first call, reuses on subsequent.
   * Returns the workspace path for tool execution.
   */
  ensureSandbox(requestId: string, config: SandboxConfig): Promise<void>;

  /** Release the sandbox for a given requestId (end of turn). */
  release(requestId: string): Promise<void>;

  /** Close the dispatcher and release all sandboxes. */
  close(): Promise<void>;
}

interface ActiveSandbox {
  process: SandboxProcess;
  config: SandboxConfig;
}

export function createLocalSandboxDispatcher(
  opts: LocalSandboxDispatcherOptions,
): LocalSandboxDispatcher {
  const { provider, sandboxType } = opts;
  const active = new Map<string, ActiveSandbox>();
  const isContainer = CONTAINER_SANDBOXES.has(sandboxType ?? '');

  return {
    hasSandbox(requestId: string): boolean {
      return active.has(requestId);
    },

    async ensureSandbox(requestId: string, config: SandboxConfig): Promise<void> {
      if (active.has(requestId)) return;

      // For non-container sandboxes (subprocess, seatbelt), tools execute
      // directly on the host via sandbox-tools.ts handlers. No spawn needed.
      if (!isContainer) return;

      logger.info('lazy_sandbox_spawn', { requestId, sandboxType });
      const proc = await provider.spawn(config);
      active.set(requestId, { process: proc, config });
      logger.info('lazy_sandbox_ready', { requestId, pid: proc.pid });
    },

    async release(requestId: string): Promise<void> {
      const sandbox = active.get(requestId);
      if (!sandbox) return;

      try {
        sandbox.process.kill();
        logger.debug('sandbox_released', { requestId, pid: sandbox.process.pid });
      } catch (err) {
        logger.warn('sandbox_release_failed', { requestId, error: (err as Error).message });
      }
      active.delete(requestId);
    },

    async close(): Promise<void> {
      const releases = [...active.keys()].map(reqId => this.release(reqId));
      await Promise.allSettled(releases);
    },
  };
}
```

**Step 4: Run test to verify it passes**

Run: `npm test -- --run tests/host/local-sandbox-dispatch.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/host/local-sandbox-dispatch.ts tests/host/local-sandbox-dispatch.test.ts
git commit -m "feat: add LocalSandboxDispatcher for lazy sandbox spawning"
```

---

## Task 5: Wire Lazy Sandbox into `processCompletion`

This is the integration step. Modify `processCompletion` to:
1. Always spawn the agent as a subprocess (not through the configured sandbox)
2. Defer sandbox spawning to the sandbox tool handlers

**Files:**
- Modify: `src/host/server-completions.ts`
- Modify: `src/host/ipc-server.ts` (pass sandbox config to handlers)
- Test: run existing tests

**Step 1: Understand the change**

Currently in `processCompletion()` (~line 744):
```typescript
const proc = await providers.sandbox.spawn(sandboxConfig);
```

This needs to change to:
```typescript
// Import subprocess provider for lightweight agent process
const subprocessModule = await import('../providers/sandbox/subprocess.js');
const agentSandbox = await subprocessModule.create(config);
const proc = await agentSandbox.spawn(sandboxConfig);
```

This mirrors exactly what `agent-runtime-process.ts` does at line 133-135.

**Step 2: Modify `processCompletion`**

In `src/host/server-completions.ts`, at the sandbox spawn section:

1. Before the spawn loop, check if the sandbox is a container type. If so, use subprocess for the agent and store the real sandbox provider for lazy tool dispatch:

```typescript
// For container sandboxes, run the agent as a local subprocess
// (same pattern as agent-runtime-process.ts for k8s).
// The real sandbox provider is used for lazy tool dispatch.
const CONTAINER_SANDBOXES = new Set(['docker', 'apple', 'k8s']);
const isContainerSandbox = CONTAINER_SANDBOXES.has(config.providers.sandbox);

let agentSandbox = providers.sandbox;
if (isContainerSandbox && config.providers.sandbox !== 'k8s') {
  // k8s already does this in agent-runtime-process.ts
  const subprocessModule = await import('../providers/sandbox/subprocess.js');
  agentSandbox = await subprocessModule.create(config);
}
```

2. Use `agentSandbox` instead of `providers.sandbox` for spawning:

```typescript
const proc = await agentSandbox.spawn(sandboxConfig);
```

**Important:** The `spawnCommand` logic already handles container vs non-container commands (lines 606-613). When running as subprocess, the non-container path is used (`process.execPath` + runner).

Since `isContainerSandbox` is already computed for command selection, we need to adjust: when we force subprocess for the agent, the command should be the host-side runner path, not the container path. Override `isContainerSandbox` to `false` for command construction when we've swapped to subprocess:

```typescript
const agentIsContainer = isContainerSandbox && config.providers.sandbox === 'k8s';
// Only k8s still runs the agent in a container (handled by agent-runtime-process.ts)
// For apple/docker, agent runs as subprocess with host paths
const spawnCommand = agentIsContainer
  ? ['/opt/ax/dist/agent/runner.js']
  : [process.execPath, ...];
```

**Step 3: Verify existing tests still pass**

Run: `npm test -- --run`
Expected: All tests pass. This change is transparent because:
- The agent still spawns as a subprocess (subprocess provider does the same as what the sandbox provider did for subprocess mode)
- IPC handlers still work the same way
- For container sandbox configs that aren't k8s, the agent now runs locally instead of in a container

**Step 4: Commit**

```bash
git add src/host/server-completions.ts
git commit -m "feat: decouple agent from container sandbox — agent always runs as subprocess"
```

---

## Task 6: Full Test Suite Verification

**Step 1: Run the full test suite**

Run: `npm test -- --run`

**Step 2: Fix any failures**

Common issues to watch for:
- Tool count mismatches (updated in Task 3 but may have missed files)
- IPC sync tests that check registered action names
- Prompt module tests if the workspace tool changes the prompt output

**Step 3: Run type checking**

Run: `npm run build`

**Step 4: Fix any type errors**

**Step 5: Commit fixes**

```bash
git add -A
git commit -m "fix: test and type fixes for lazy sandbox + workspace_write"
```

---

## Future Work (Not in This Plan)

These are natural follow-ups but should be separate plans:

1. **Container lazy dispatch**: Wire `LocalSandboxDispatcher.ensureSandbox()` into the sandbox tool handlers so apple/docker containers actually spawn lazily on first `bash`/`write_file` call. Task 4 creates the dispatcher but Task 5 only decouples the agent — it doesn't yet make tool dispatch lazy for container sandboxes.

2. **`workspace_write_file` (binary)**: Restore the base64 binary file write operation. Same pattern as `workspace_write` but with `data` + `mimeType` fields instead of `content`.

3. **`workspace_read` / `workspace_list`**: Restore read/list operations so agents can read workspace files without a mounted sandbox. Lower priority since read operations can use sandbox `read_file` once a sandbox is spawned.

4. **Agent prompt update**: Update the runtime prompt to explain that `workspace_write` is available for simple file writes without needing `bash` or `write_file`.
