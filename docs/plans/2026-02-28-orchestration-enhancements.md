# Orchestration Enhancements Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add four enhancements to the agent orchestration layer: (1) persistent event store for replay/debugging, (2) heartbeat liveness detection for stuck agents, (3) policy tags on inter-agent messages for taint tracking, and (4) wall-clock timeout for agent loops.

**Architecture:** Builds on the existing orchestration layer on branch `claude/agent-orchestration-architecture-eppZW`. The persistent event store follows AX's existing SQLite persistence pattern (Kysely for migrations, raw `SQLiteDatabase` for queries). The heartbeat monitor subscribes to EventBus and auto-interrupts stuck agents. Policy tags extend the existing `AgentMessage` envelope. Wall-clock timeout adds a deadline to `runAgentLoop()`.

**Tech Stack:** TypeScript, SQLite (via `src/utils/sqlite.ts`), Kysely (migrations only), Vitest

**Branch:** Start from `claude/agent-orchestration-architecture-eppZW`

---

## Task 1: Persistent Event Store

Persist all orchestration events (`agent.*`) to SQLite for debugging, replay, and post-mortem analysis. The store subscribes to EventBus and auto-captures events, while also exposing query methods for timeline views.

**Files:**
- Create: `src/migrations/orchestration.ts`
- Create: `src/host/orchestration/event-store.ts`
- Create: `tests/host/orchestration/event-store.test.ts`
- Modify: `src/host/orchestration/orchestrator.ts` (wire in event store)
- Modify: `src/host/orchestration/types.ts` (add event types)
- Modify: `src/host/ipc-handlers/orchestration.ts` (add timeline handler)
- Modify: `src/ipc-schemas.ts` (add timeline schema)

### Step 1: Create the migration file

```typescript
// src/migrations/orchestration.ts
import { sql, type Kysely } from 'kysely';
import type { MigrationSet } from '../utils/migrator.js';

export const orchestrationMigrations: MigrationSet = {
  orch_001_events: {
    async up(db: Kysely<any>) {
      await db.schema
        .createTable('orchestration_events')
        .ifNotExists()
        .addColumn('id', 'text', (col) => col.primaryKey())
        .addColumn('event_type', 'text', (col) => col.notNull())
        .addColumn('handle_id', 'text', (col) => col.notNull())
        .addColumn('agent_id', 'text', (col) => col.notNull())
        .addColumn('session_id', 'text', (col) => col.notNull())
        .addColumn('user_id', 'text', (col) => col.notNull())
        .addColumn('parent_id', 'text')
        .addColumn('payload_json', 'text', (col) => col.notNull())
        .addColumn('created_at', 'integer', (col) =>
          col.notNull().defaultTo(sql`(unixepoch())`),
        )
        .execute();

      await db.schema
        .createIndex('idx_orch_events_type')
        .ifNotExists()
        .on('orchestration_events')
        .column('event_type')
        .execute();

      await db.schema
        .createIndex('idx_orch_events_handle')
        .ifNotExists()
        .on('orchestration_events')
        .column('handle_id')
        .execute();

      await db.schema
        .createIndex('idx_orch_events_session')
        .ifNotExists()
        .on('orchestration_events')
        .column('session_id')
        .execute();

      await db.schema
        .createIndex('idx_orch_events_agent')
        .ifNotExists()
        .on('orchestration_events')
        .column('agent_id')
        .execute();

      await db.schema
        .createIndex('idx_orch_events_created')
        .ifNotExists()
        .on('orchestration_events')
        .column('created_at')
        .execute();
    },
    async down(db: Kysely<any>) {
      await db.schema.dropTable('orchestration_events').execute();
    },
  },
};
```

### Step 2: Add event types to `types.ts`

Append these types to `src/host/orchestration/types.ts`:

```typescript
// --- Persistent Event Store Types ---

export interface OrchestrationEvent {
  readonly id: string;
  readonly eventType: string;
  readonly handleId: string;
  readonly agentId: string;
  readonly sessionId: string;
  readonly userId: string;
  readonly parentId: string | null;
  readonly payload: Record<string, unknown>;
  readonly createdAt: number; // Unix epoch ms
}

export interface EventFilter {
  eventType?: string;
  handleId?: string;
  agentId?: string;
  sessionId?: string;
  userId?: string;
  since?: number; // Unix epoch ms
  until?: number; // Unix epoch ms
  limit?: number;
}

export interface OrchestrationEventStore {
  append(event: OrchestrationEvent): void;
  query(filter?: EventFilter): OrchestrationEvent[];
  byAgent(handleId: string, limit?: number): OrchestrationEvent[];
  bySession(sessionId: string, limit?: number): OrchestrationEvent[];
  startCapture(eventBus: EventBus): () => void; // returns unsubscribe
  close(): void;
}
```

Note: `EventBus` import will need to be added at the top of `types.ts`:
```typescript
import type { EventBus } from '../event-bus.js';
```

### Step 3: Write failing tests for the event store

Create `tests/host/orchestration/event-store.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createOrchestrationEventStore } from '../../../src/host/orchestration/event-store.js';
import type { OrchestrationEvent, OrchestrationEventStore } from '../../../src/host/orchestration/types.js';
import type { EventBus, StreamEvent } from '../../../src/host/event-bus.js';

function createMockEventBus(): EventBus & { captured: Array<(e: StreamEvent) => void> } {
  const captured: Array<(e: StreamEvent) => void> = [];
  return {
    captured,
    emit: vi.fn(),
    subscribe: vi.fn((listener: (e: StreamEvent) => void) => {
      captured.push(listener);
      return () => {
        const idx = captured.indexOf(listener);
        if (idx >= 0) captured.splice(idx, 1);
      };
    }),
    subscribeRequest: vi.fn(() => vi.fn()),
    listenerCount: vi.fn(() => 0),
  };
}

function makeEvent(overrides: Partial<OrchestrationEvent> = {}): OrchestrationEvent {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    eventType: overrides.eventType ?? 'agent.state',
    handleId: overrides.handleId ?? 'handle-1',
    agentId: overrides.agentId ?? 'main',
    sessionId: overrides.sessionId ?? 'session-1',
    userId: overrides.userId ?? 'user-1',
    parentId: overrides.parentId ?? null,
    payload: overrides.payload ?? { oldState: 'spawning', newState: 'running' },
    createdAt: overrides.createdAt ?? Date.now(),
  };
}

describe('OrchestrationEventStore', () => {
  let store: OrchestrationEventStore;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ax-orch-test-'));
    store = await createOrchestrationEventStore(join(tmpDir, 'test.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('append + query', () => {
    it('stores and retrieves an event', () => {
      const event = makeEvent();
      store.append(event);

      const results = store.query();
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(event.id);
      expect(results[0].eventType).toBe(event.eventType);
      expect(results[0].handleId).toBe(event.handleId);
      expect(results[0].payload).toEqual(event.payload);
    });

    it('stores multiple events in order', () => {
      const e1 = makeEvent({ createdAt: 1000 });
      const e2 = makeEvent({ createdAt: 2000 });
      const e3 = makeEvent({ createdAt: 3000 });
      store.append(e1);
      store.append(e2);
      store.append(e3);

      const results = store.query();
      expect(results).toHaveLength(3);
      expect(results[0].createdAt).toBe(1000);
      expect(results[2].createdAt).toBe(3000);
    });

    it('filters by eventType', () => {
      store.append(makeEvent({ eventType: 'agent.state' }));
      store.append(makeEvent({ eventType: 'agent.completed' }));
      store.append(makeEvent({ eventType: 'agent.state' }));

      const results = store.query({ eventType: 'agent.state' });
      expect(results).toHaveLength(2);
      expect(results.every((e) => e.eventType === 'agent.state')).toBe(true);
    });

    it('filters by handleId', () => {
      store.append(makeEvent({ handleId: 'h1' }));
      store.append(makeEvent({ handleId: 'h2' }));
      store.append(makeEvent({ handleId: 'h1' }));

      const results = store.query({ handleId: 'h1' });
      expect(results).toHaveLength(2);
    });

    it('filters by sessionId', () => {
      store.append(makeEvent({ sessionId: 's1' }));
      store.append(makeEvent({ sessionId: 's2' }));

      const results = store.query({ sessionId: 's1' });
      expect(results).toHaveLength(1);
    });

    it('filters by time range (since/until)', () => {
      store.append(makeEvent({ createdAt: 1000 }));
      store.append(makeEvent({ createdAt: 2000 }));
      store.append(makeEvent({ createdAt: 3000 }));

      const results = store.query({ since: 1500, until: 2500 });
      expect(results).toHaveLength(1);
      expect(results[0].createdAt).toBe(2000);
    });

    it('respects limit', () => {
      for (let i = 0; i < 10; i++) {
        store.append(makeEvent({ createdAt: i * 1000 }));
      }

      const results = store.query({ limit: 3 });
      expect(results).toHaveLength(3);
    });

    it('combines multiple filters with AND', () => {
      store.append(makeEvent({ handleId: 'h1', eventType: 'agent.state' }));
      store.append(makeEvent({ handleId: 'h1', eventType: 'agent.completed' }));
      store.append(makeEvent({ handleId: 'h2', eventType: 'agent.state' }));

      const results = store.query({ handleId: 'h1', eventType: 'agent.state' });
      expect(results).toHaveLength(1);
    });
  });

  describe('byAgent', () => {
    it('returns events for a specific handle ordered by time', () => {
      store.append(makeEvent({ handleId: 'h1', createdAt: 2000 }));
      store.append(makeEvent({ handleId: 'h2', createdAt: 1000 }));
      store.append(makeEvent({ handleId: 'h1', createdAt: 3000 }));

      const results = store.byAgent('h1');
      expect(results).toHaveLength(2);
      expect(results[0].createdAt).toBe(2000);
      expect(results[1].createdAt).toBe(3000);
    });

    it('respects limit', () => {
      for (let i = 0; i < 10; i++) {
        store.append(makeEvent({ handleId: 'h1', createdAt: i * 1000 }));
      }
      const results = store.byAgent('h1', 3);
      expect(results).toHaveLength(3);
    });
  });

  describe('bySession', () => {
    it('returns events for a specific session', () => {
      store.append(makeEvent({ sessionId: 's1' }));
      store.append(makeEvent({ sessionId: 's2' }));
      store.append(makeEvent({ sessionId: 's1' }));

      const results = store.bySession('s1');
      expect(results).toHaveLength(2);
    });
  });

  describe('startCapture', () => {
    it('auto-captures agent.* events from EventBus', () => {
      const bus = createMockEventBus();
      const unsub = store.startCapture(bus);

      expect(bus.subscribe).toHaveBeenCalledOnce();

      // Simulate an agent event
      const listener = bus.captured[0];
      listener({
        type: 'agent.state',
        requestId: 'session-1',
        timestamp: Date.now(),
        data: {
          handleId: 'h1',
          agentId: 'main',
          userId: 'user-1',
          parentId: null,
          oldState: 'spawning',
          newState: 'running',
        },
      });

      const results = store.query();
      expect(results).toHaveLength(1);
      expect(results[0].eventType).toBe('agent.state');
      expect(results[0].handleId).toBe('h1');
      expect(results[0].sessionId).toBe('session-1');

      unsub();
    });

    it('ignores non-agent events', () => {
      const bus = createMockEventBus();
      store.startCapture(bus);

      const listener = bus.captured[0];
      listener({
        type: 'llm.start',
        requestId: 'req-1',
        timestamp: Date.now(),
        data: { model: 'claude' },
      });

      expect(store.query()).toHaveLength(0);
    });

    it('unsubscribe stops capture', () => {
      const bus = createMockEventBus();
      const unsub = store.startCapture(bus);
      unsub();

      expect(bus.captured).toHaveLength(0);
    });
  });
});
```

### Step 4: Run tests to verify they fail

Run: `npx vitest run tests/host/orchestration/event-store.test.ts`
Expected: FAIL — module `event-store.js` does not exist

### Step 5: Implement the event store

Create `src/host/orchestration/event-store.ts`:

```typescript
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { openDatabase } from '../../utils/sqlite.js';
import type { SQLiteDatabase } from '../../utils/sqlite.js';
import { createKyselyDb } from '../../utils/database.js';
import { runMigrations } from '../../utils/migrator.js';
import { orchestrationMigrations } from '../../migrations/orchestration.js';
import { dataFile } from '../../paths.js';
import { getLogger } from '../../logger.js';
import type { EventBus, StreamEvent } from '../event-bus.js';
import type {
  OrchestrationEvent,
  OrchestrationEventStore,
  EventFilter,
} from './types.js';

const logger = getLogger('orchestration-event-store');

interface EventRow {
  id: string;
  event_type: string;
  handle_id: string;
  agent_id: string;
  session_id: string;
  user_id: string;
  parent_id: string | null;
  payload_json: string;
  created_at: number;
}

function rowToEvent(row: EventRow): OrchestrationEvent {
  return {
    id: row.id,
    eventType: row.event_type,
    handleId: row.handle_id,
    agentId: row.agent_id,
    sessionId: row.session_id,
    userId: row.user_id,
    parentId: row.parent_id,
    payload: JSON.parse(row.payload_json),
    createdAt: row.created_at,
  };
}

function streamEventToOrchEvent(event: StreamEvent): OrchestrationEvent | null {
  const data = event.data;
  const handleId = (data.handleId as string) ?? '';
  const agentId = (data.agentId as string) ?? '';
  const userId = (data.userId as string) ?? '';
  const parentId = (data.parentId as string | undefined) ?? null;

  if (!handleId) return null;

  return {
    id: randomUUID(),
    eventType: event.type,
    handleId,
    agentId,
    sessionId: event.requestId,
    userId,
    parentId,
    payload: data,
    createdAt: event.timestamp,
  };
}

export async function createOrchestrationEventStore(
  dbPath: string = dataFile('orchestration.db'),
): Promise<OrchestrationEventStore> {
  mkdirSync(dirname(dbPath), { recursive: true });

  const kyselyDb = createKyselyDb({ type: 'sqlite', path: dbPath });
  try {
    const result = await runMigrations(kyselyDb, orchestrationMigrations);
    if (result.error) throw result.error;
  } finally {
    await kyselyDb.destroy();
  }

  const db: SQLiteDatabase = openDatabase(dbPath);

  function append(event: OrchestrationEvent): void {
    db.prepare(
      `INSERT INTO orchestration_events
       (id, event_type, handle_id, agent_id, session_id, user_id, parent_id, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      event.id,
      event.eventType,
      event.handleId,
      event.agentId,
      event.sessionId,
      event.userId,
      event.parentId,
      JSON.stringify(event.payload),
      event.createdAt,
    );
  }

  function query(filter?: EventFilter): OrchestrationEvent[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter?.eventType) {
      conditions.push('event_type = ?');
      params.push(filter.eventType);
    }
    if (filter?.handleId) {
      conditions.push('handle_id = ?');
      params.push(filter.handleId);
    }
    if (filter?.agentId) {
      conditions.push('agent_id = ?');
      params.push(filter.agentId);
    }
    if (filter?.sessionId) {
      conditions.push('session_id = ?');
      params.push(filter.sessionId);
    }
    if (filter?.userId) {
      conditions.push('user_id = ?');
      params.push(filter.userId);
    }
    if (filter?.since) {
      conditions.push('created_at >= ?');
      params.push(filter.since);
    }
    if (filter?.until) {
      conditions.push('created_at <= ?');
      params.push(filter.until);
    }

    let sql = 'SELECT * FROM orchestration_events';
    if (conditions.length > 0) sql += ' WHERE ' + conditions.join(' AND ');
    sql += ' ORDER BY created_at ASC';
    if (filter?.limit) {
      sql += ' LIMIT ?';
      params.push(filter.limit);
    }

    const rows = db.prepare(sql).all(...params) as EventRow[];
    return rows.map(rowToEvent);
  }

  function byAgent(handleId: string, limit?: number): OrchestrationEvent[] {
    return query({ handleId, limit });
  }

  function bySession(sessionId: string, limit?: number): OrchestrationEvent[] {
    return query({ sessionId, limit });
  }

  function startCapture(eventBus: EventBus): () => void {
    return eventBus.subscribe((event: StreamEvent) => {
      if (!event.type.startsWith('agent.')) return;

      const orchEvent = streamEventToOrchEvent(event);
      if (!orchEvent) {
        logger.debug('skipping_event_no_handle', { type: event.type });
        return;
      }

      try {
        append(orchEvent);
      } catch (err) {
        logger.error('event_store_append_failed', { type: event.type, err });
      }
    });
  }

  function close(): void {
    db.close();
  }

  return { append, query, byAgent, bySession, startCapture, close };
}
```

### Step 6: Run tests to verify they pass

Run: `npx vitest run tests/host/orchestration/event-store.test.ts`
Expected: PASS

### Step 7: Wire event store into orchestrator

Modify `src/host/orchestration/orchestrator.ts`:

Add to imports:
```typescript
import type { OrchestrationEventStore } from './types.js';
```

Add to `OrchestratorConfig`:
```typescript
interface OrchestratorConfig {
  supervisor?: AgentSupervisorConfig;
  maxMailboxSize?: number;
  maxMessagePayloadBytes?: number;
}
```
No config change needed — the event store is passed as a dependency.

Add `eventStore` parameter to `createOrchestrator`:
```typescript
export function createOrchestrator(
  eventBus: EventBus,
  audit?: AuditProvider,
  config?: OrchestratorConfig,
  eventStore?: OrchestrationEventStore,  // NEW
): Orchestrator {
```

Inside the function body, after creating supervisor and directory, start capture if event store is provided:
```typescript
  const captureUnsub = eventStore?.startCapture(eventBus);
```

Update `shutdown()` to stop capture and close store:
```typescript
  function shutdown(): void {
    // ... existing shutdown logic ...
    captureUnsub?.();
  }
```

Expose `eventStore` on the returned `Orchestrator` object:
```typescript
  return {
    eventBus,
    supervisor,
    directory,
    eventStore,  // NEW — may be undefined
    register,
    send,
    broadcast,
    // ...rest
  };
```

Add `eventStore` to the `Orchestrator` interface:
```typescript
interface Orchestrator {
  readonly eventBus: EventBus;
  readonly supervisor: AgentSupervisor;
  readonly directory: AgentDirectory;
  readonly eventStore?: OrchestrationEventStore;  // NEW
  // ...rest
}
```

### Step 8: Add IPC handler + schema for timeline queries

Add to `src/ipc-schemas.ts`:
```typescript
export const AgentOrchTimelineSchema = ipcAction('agent_orch_timeline', {
  handleId: z.string(),
  limit: z.number().int().min(1).max(500).optional(),
  since: z.number().optional(),
  eventType: z.string().optional(),
});
```

Add handler to `src/host/ipc-handlers/orchestration.ts`:
```typescript
agent_orch_timeline: async (req: any, ctx: IPCContext) => {
  if (!orchestrator.eventStore) {
    return { ok: false, error: 'Event store not available' };
  }

  const { handleId, limit, since, eventType } = req;

  // Scope check: handle must be in caller's session
  const handle = orchestrator.supervisor.get(handleId);
  if (!handle || handle.sessionId !== ctx.sessionId) {
    return { ok: false, error: 'Agent not found in current session' };
  }

  const events = orchestrator.eventStore.query({
    handleId,
    limit: limit ?? 100,
    since,
    eventType,
  });

  return { ok: true, events, count: events.length };
},
```

### Step 9: Run all orchestration tests

Run: `npx vitest run tests/host/orchestration/`
Expected: All tests PASS (existing + new)

### Step 10: Commit

```bash
git add src/migrations/orchestration.ts \
  src/host/orchestration/event-store.ts \
  src/host/orchestration/types.ts \
  src/host/orchestration/orchestrator.ts \
  src/host/ipc-handlers/orchestration.ts \
  src/ipc-schemas.ts \
  tests/host/orchestration/event-store.test.ts
git commit -m "feat: add persistent event store for orchestration events"
```

---

## Task 2: Heartbeat Liveness Monitor

Detect stuck or unresponsive agents by tracking activity timestamps and auto-interrupting agents that exceed a configurable timeout. Any `agent.*` event counts as proof of life.

**Files:**
- Create: `src/host/orchestration/heartbeat-monitor.ts`
- Create: `tests/host/orchestration/heartbeat-monitor.test.ts`
- Modify: `src/host/orchestration/orchestrator.ts` (wire in monitor)
- Modify: `src/host/orchestration/types.ts` (add monitor types)

### Step 1: Add heartbeat monitor types to `types.ts`

Append to `src/host/orchestration/types.ts`:

```typescript
// --- Heartbeat Liveness Monitor Types ---

export interface HeartbeatMonitorConfig {
  timeoutMs?: number;       // Default: 120_000 (2 min)
  checkIntervalMs?: number; // Default: 10_000 (10s)
}

export interface HeartbeatMonitor {
  start(eventBus: EventBus, supervisor: AgentSupervisor): () => void;
  recordActivity(handleId: string): void;
  getLastActivity(handleId: string): number | null;
  isTimedOut(handleId: string): boolean;
  stop(): void;
}
```

Note: `AgentSupervisor` import will be needed — add `import type { AgentSupervisor } from './agent-supervisor.js';` at the top if not already present, OR define the types inline. Since `types.ts` is imported by `agent-supervisor.ts`, we have a circular dependency risk. To avoid this, define the monitor interface in `heartbeat-monitor.ts` itself and only export the config type from `types.ts`.

**Revised approach — put the interface in the implementation file:**

Only add to `types.ts`:
```typescript
export interface HeartbeatMonitorConfig {
  timeoutMs?: number;       // Default: 120_000 (2 min)
  checkIntervalMs?: number; // Default: 10_000 (10s)
}
```

### Step 2: Write failing tests

Create `tests/host/orchestration/heartbeat-monitor.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHeartbeatMonitor } from '../../../src/host/orchestration/heartbeat-monitor.js';
import type { EventBus, StreamEvent } from '../../../src/host/event-bus.js';
import type { AgentSupervisor } from '../../../src/host/orchestration/agent-supervisor.js';

function createMockEventBus(): EventBus & { captured: Array<(e: StreamEvent) => void> } {
  const captured: Array<(e: StreamEvent) => void> = [];
  return {
    captured,
    emit: vi.fn(),
    subscribe: vi.fn((listener: (e: StreamEvent) => void) => {
      captured.push(listener);
      return () => {
        const idx = captured.indexOf(listener);
        if (idx >= 0) captured.splice(idx, 1);
      };
    }),
    subscribeRequest: vi.fn(() => vi.fn()),
    listenerCount: vi.fn(() => 0),
  };
}

function createMockSupervisor(handles: any[] = []): AgentSupervisor {
  return {
    register: vi.fn(),
    transition: vi.fn(),
    interrupt: vi.fn(),
    cancel: vi.fn(),
    complete: vi.fn(),
    fail: vi.fn(),
    get: vi.fn((id: string) => handles.find((h) => h.id === id)),
    remove: vi.fn(),
    all: vi.fn(() => handles),
    activeCount: vi.fn(() => handles.filter((h) => h.state !== 'completed').length),
  };
}

describe('HeartbeatMonitor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('records activity from agent.* events', () => {
    const bus = createMockEventBus();
    const supervisor = createMockSupervisor();
    const monitor = createHeartbeatMonitor({ timeoutMs: 5000, checkIntervalMs: 1000 });
    monitor.start(bus, supervisor);

    const listener = bus.captured[0];
    listener({
      type: 'agent.state',
      requestId: 'session-1',
      timestamp: Date.now(),
      data: { handleId: 'h1' },
    });

    expect(monitor.getLastActivity('h1')).not.toBeNull();
    monitor.stop();
  });

  it('ignores non-agent events', () => {
    const bus = createMockEventBus();
    const supervisor = createMockSupervisor();
    const monitor = createHeartbeatMonitor({ timeoutMs: 5000, checkIntervalMs: 1000 });
    monitor.start(bus, supervisor);

    const listener = bus.captured[0];
    listener({
      type: 'llm.start',
      requestId: 'session-1',
      timestamp: Date.now(),
      data: {},
    });

    expect(monitor.getLastActivity('h1')).toBeNull();
    monitor.stop();
  });

  it('detects timed-out agents', () => {
    const monitor = createHeartbeatMonitor({ timeoutMs: 5000, checkIntervalMs: 1000 });
    monitor.recordActivity('h1');

    vi.advanceTimersByTime(6000);

    expect(monitor.isTimedOut('h1')).toBe(true);
  });

  it('does not report recently active agents as timed out', () => {
    const monitor = createHeartbeatMonitor({ timeoutMs: 5000, checkIntervalMs: 1000 });
    monitor.recordActivity('h1');

    vi.advanceTimersByTime(3000);

    expect(monitor.isTimedOut('h1')).toBe(false);
  });

  it('auto-interrupts stuck agents on check interval', () => {
    const handles = [
      { id: 'h1', agentId: 'main', state: 'running', sessionId: 's1' },
    ];
    const bus = createMockEventBus();
    const supervisor = createMockSupervisor(handles);
    const monitor = createHeartbeatMonitor({ timeoutMs: 5000, checkIntervalMs: 1000 });
    monitor.start(bus, supervisor);
    monitor.recordActivity('h1');

    // Advance past timeout + one check interval
    vi.advanceTimersByTime(6000);

    expect(supervisor.interrupt).toHaveBeenCalledWith('h1', expect.stringContaining('heartbeat'));
    monitor.stop();
  });

  it('does not interrupt terminal agents', () => {
    const handles = [
      { id: 'h1', agentId: 'main', state: 'completed', sessionId: 's1' },
    ];
    const bus = createMockEventBus();
    const supervisor = createMockSupervisor(handles);
    const monitor = createHeartbeatMonitor({ timeoutMs: 5000, checkIntervalMs: 1000 });
    monitor.start(bus, supervisor);
    monitor.recordActivity('h1');

    vi.advanceTimersByTime(6000);

    expect(supervisor.interrupt).not.toHaveBeenCalled();
    monitor.stop();
  });

  it('does not interrupt already-interrupted agents', () => {
    const handles = [
      { id: 'h1', agentId: 'main', state: 'interrupted', sessionId: 's1' },
    ];
    const bus = createMockEventBus();
    const supervisor = createMockSupervisor(handles);
    const monitor = createHeartbeatMonitor({ timeoutMs: 5000, checkIntervalMs: 1000 });
    monitor.start(bus, supervisor);
    monitor.recordActivity('h1');

    vi.advanceTimersByTime(6000);

    expect(supervisor.interrupt).not.toHaveBeenCalled();
    monitor.stop();
  });

  it('resets timeout on new activity', () => {
    const handles = [
      { id: 'h1', agentId: 'main', state: 'running', sessionId: 's1' },
    ];
    const bus = createMockEventBus();
    const supervisor = createMockSupervisor(handles);
    const monitor = createHeartbeatMonitor({ timeoutMs: 5000, checkIntervalMs: 1000 });
    monitor.start(bus, supervisor);
    monitor.recordActivity('h1');

    vi.advanceTimersByTime(4000);
    monitor.recordActivity('h1'); // Reset
    vi.advanceTimersByTime(4000); // 4s since reset, still within 5s timeout

    expect(supervisor.interrupt).not.toHaveBeenCalled();
    monitor.stop();
  });

  it('stop clears interval and unsubscribes', () => {
    const bus = createMockEventBus();
    const supervisor = createMockSupervisor();
    const monitor = createHeartbeatMonitor({ timeoutMs: 5000, checkIntervalMs: 1000 });
    monitor.start(bus, supervisor);

    expect(bus.captured).toHaveLength(1);
    monitor.stop();
    expect(bus.captured).toHaveLength(0);
  });
});
```

### Step 3: Run tests to verify they fail

Run: `npx vitest run tests/host/orchestration/heartbeat-monitor.test.ts`
Expected: FAIL — module `heartbeat-monitor.js` does not exist

### Step 4: Implement the heartbeat monitor

Create `src/host/orchestration/heartbeat-monitor.ts`:

```typescript
import { getLogger } from '../../logger.js';
import type { EventBus } from '../event-bus.js';
import type { AgentSupervisor } from './agent-supervisor.js';
import { TERMINAL_STATES } from './types.js';
import type { HeartbeatMonitorConfig } from './types.js';

const logger = getLogger('heartbeat-monitor');

const DEFAULT_TIMEOUT_MS = 120_000;       // 2 minutes
const DEFAULT_CHECK_INTERVAL_MS = 10_000; // 10 seconds

export interface HeartbeatMonitor {
  start(eventBus: EventBus, supervisor: AgentSupervisor): () => void;
  recordActivity(handleId: string): void;
  getLastActivity(handleId: string): number | null;
  isTimedOut(handleId: string): boolean;
  stop(): void;
}

export function createHeartbeatMonitor(config?: HeartbeatMonitorConfig): HeartbeatMonitor {
  const timeoutMs = config?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const checkIntervalMs = config?.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;

  const lastActivity = new Map<string, number>();
  let checkTimer: ReturnType<typeof setInterval> | null = null;
  let unsubscribe: (() => void) | null = null;

  function recordActivity(handleId: string): void {
    lastActivity.set(handleId, Date.now());
  }

  function getLastActivity(handleId: string): number | null {
    return lastActivity.get(handleId) ?? null;
  }

  function isTimedOut(handleId: string): boolean {
    const last = lastActivity.get(handleId);
    if (last == null) return false;
    return Date.now() - last > timeoutMs;
  }

  function start(eventBus: EventBus, supervisor: AgentSupervisor): () => void {
    // Subscribe to all agent events as proof of life
    unsubscribe = eventBus.subscribe((event) => {
      if (!event.type.startsWith('agent.')) return;
      const handleId = event.data.handleId as string | undefined;
      if (handleId) {
        recordActivity(handleId);
      }
    });

    // Periodic check for timed-out agents
    checkTimer = setInterval(() => {
      for (const [handleId, lastTime] of lastActivity) {
        if (Date.now() - lastTime <= timeoutMs) continue;

        const handle = supervisor.get(handleId);
        if (!handle) {
          lastActivity.delete(handleId);
          continue;
        }

        if (TERMINAL_STATES.has(handle.state)) {
          lastActivity.delete(handleId);
          continue;
        }

        if (handle.state === 'interrupted') continue;

        logger.warn('heartbeat_timeout', {
          handleId,
          agentId: handle.agentId,
          lastActivity: lastTime,
          timeoutMs,
        });

        supervisor.interrupt(handleId, `Heartbeat timeout: no activity for ${timeoutMs}ms`);
      }
    }, checkIntervalMs);
    checkTimer.unref?.();

    return () => stop();
  }

  function stop(): void {
    if (checkTimer) {
      clearInterval(checkTimer);
      checkTimer = null;
    }
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
  }

  return { start, recordActivity, getLastActivity, isTimedOut, stop };
}
```

### Step 5: Run tests to verify they pass

Run: `npx vitest run tests/host/orchestration/heartbeat-monitor.test.ts`
Expected: PASS

### Step 6: Wire heartbeat monitor into orchestrator

Modify `src/host/orchestration/orchestrator.ts`:

Add import:
```typescript
import { createHeartbeatMonitor, type HeartbeatMonitor } from './heartbeat-monitor.js';
import type { HeartbeatMonitorConfig } from './types.js';
```

Add to `OrchestratorConfig`:
```typescript
interface OrchestratorConfig {
  supervisor?: AgentSupervisorConfig;
  maxMailboxSize?: number;
  maxMessagePayloadBytes?: number;
  heartbeat?: HeartbeatMonitorConfig;  // NEW
}
```

Inside `createOrchestrator`, after creating supervisor:
```typescript
  const heartbeat = createHeartbeatMonitor(config?.heartbeat);
  const heartbeatUnsub = heartbeat.start(eventBus, supervisor);
```

Update `shutdown()`:
```typescript
  function shutdown(): void {
    // ... existing ...
    heartbeatUnsub();
    captureUnsub?.();
  }
```

Expose on Orchestrator interface:
```typescript
interface Orchestrator {
  // ... existing ...
  readonly heartbeat: HeartbeatMonitor;
}
```

### Step 7: Run all orchestration tests

Run: `npx vitest run tests/host/orchestration/`
Expected: All PASS

### Step 8: Commit

```bash
git add src/host/orchestration/heartbeat-monitor.ts \
  src/host/orchestration/types.ts \
  src/host/orchestration/orchestrator.ts \
  tests/host/orchestration/heartbeat-monitor.test.ts
git commit -m "feat: add heartbeat liveness monitor for stuck agent detection"
```

---

## Task 3: Policy Tags on Inter-Agent Messages

Extend `AgentMessage` with `policyTags` so taint metadata flows through inter-agent communication, aligning with AX's existing taint budget security model.

**Files:**
- Modify: `src/host/orchestration/types.ts` (add `policyTags` to `AgentMessage`)
- Modify: `src/host/orchestration/orchestrator.ts` (pass through tags)
- Modify: `src/ipc-schemas.ts` (add `policyTags` to message schema)
- Modify: `tests/host/orchestration/orchestrator.test.ts` (add tests)

### Step 1: Add `policyTags` to `AgentMessage` in `types.ts`

In `src/host/orchestration/types.ts`, update the `AgentMessage` interface:

```typescript
export interface AgentMessage {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly type: AgentMessageType;
  readonly payload: Record<string, unknown>;
  readonly timestamp: number;
  readonly correlationId?: string;
  readonly policyTags?: readonly string[];  // NEW — e.g., ['tainted', 'pii', 'external_content']
}
```

### Step 2: Update IPC schema

In `src/ipc-schemas.ts`, update `AgentOrchMessageSchema` to accept `policyTags`:

Add after the existing fields:
```typescript
policyTags: z.array(z.string().max(50)).max(10).optional(),
```

### Step 3: Update orchestrator `send()` to pass through tags

In `src/host/orchestration/orchestrator.ts`, in the `send()` function, ensure `policyTags` from the input message are included in the created `AgentMessage`:

The current code creates a message from `Omit<AgentMessage, 'id' | 'from' | 'to' | 'timestamp'>`. The `policyTags` field is already part of that type after the type change, so it will flow through automatically via spread. Verify the message construction uses `...message` spread to capture optional fields.

### Step 4: Write tests for policy tags

Add to `tests/host/orchestration/orchestrator.test.ts`:

```typescript
describe('policyTags', () => {
  it('send preserves policyTags on delivered message', () => {
    const handle1 = orchestrator.register({ agentId: 'a', agentType: 'pi-session', sessionId: 's', userId: 'u' });
    const handle2 = orchestrator.register({ agentId: 'b', agentType: 'pi-session', sessionId: 's', userId: 'u' });

    orchestrator.send(handle1.id, handle2.id, {
      type: 'notification',
      payload: { data: 'test' },
      policyTags: ['tainted', 'pii'],
    });

    const messages = orchestrator.pollMessages(handle2.id);
    expect(messages).toHaveLength(1);
    expect(messages[0].policyTags).toEqual(['tainted', 'pii']);
  });

  it('send works without policyTags (backward compatible)', () => {
    const handle1 = orchestrator.register({ agentId: 'a', agentType: 'pi-session', sessionId: 's', userId: 'u' });
    const handle2 = orchestrator.register({ agentId: 'b', agentType: 'pi-session', sessionId: 's', userId: 'u' });

    orchestrator.send(handle1.id, handle2.id, {
      type: 'notification',
      payload: { data: 'test' },
    });

    const messages = orchestrator.pollMessages(handle2.id);
    expect(messages).toHaveLength(1);
    expect(messages[0].policyTags).toBeUndefined();
  });

  it('broadcast preserves policyTags', () => {
    const handle1 = orchestrator.register({ agentId: 'a', agentType: 'pi-session', sessionId: 's', userId: 'u' });
    orchestrator.register({ agentId: 'b', agentType: 'pi-session', sessionId: 's', userId: 'u' });

    const msgs = orchestrator.broadcast(handle1.id, { type: 'session', sessionId: 's' }, {
      type: 'notification',
      payload: {},
      policyTags: ['external_content'],
    });

    expect(msgs[0].policyTags).toEqual(['external_content']);
  });
});
```

### Step 5: Run tests

Run: `npx vitest run tests/host/orchestration/orchestrator.test.ts`
Expected: PASS

### Step 6: Commit

```bash
git add src/host/orchestration/types.ts \
  src/host/orchestration/orchestrator.ts \
  src/ipc-schemas.ts \
  tests/host/orchestration/orchestrator.test.ts
git commit -m "feat: add policyTags to agent messages for taint tracking"
```

---

## Task 4: Wall-Clock Timeout for Agent Loops

Add `maxWallClockMs` to `AgentLoopConfig` so agent loops have a hard wall-clock deadline in addition to the iteration limit. Prevents infinite-length iterations from running forever within the iteration budget.

**Files:**
- Modify: `src/host/orchestration/agent-loop.ts` (add timeout)
- Modify: `tests/host/orchestration/agent-loop.test.ts` (add tests)

### Step 1: Add `maxWallClockMs` to config

In `src/host/orchestration/agent-loop.ts`, update `AgentLoopConfig`:

```typescript
export interface AgentLoopConfig {
  prompt: string;
  maxIterations: number;
  validate: ValidateFn;
  execute: ExecuteFn;
  registration: Omit<AgentRegistration, 'activity' | 'metadata'>;
  buildRetryPrompt?: (originalPrompt: string, validation: ValidationResult, iteration: number) => string;
  onProgress?: (progress: LoopProgress) => void;
  maxWallClockMs?: number;  // NEW — hard wall-clock deadline for the entire loop
}
```

Add `'wall_clock_timeout'` to the `LoopResult.reason` union:

```typescript
export interface LoopResult {
  passed: boolean;
  iterations: number;
  output: string;
  validation: ValidationResult;
  handles: string[];
  totalDurationMs: number;
  reason: 'validation_passed' | 'max_iterations' | 'interrupted' | 'execute_error' | 'wall_clock_timeout';  // UPDATED
}
```

Also add `'wall_clock_timeout'` to the `LoopProgress.status` union:
```typescript
status: 'running' | 'passed' | 'failed' | 'max_iterations' | 'interrupted' | 'wall_clock_timeout';
```

### Step 2: Write failing tests

Add to `tests/host/orchestration/agent-loop.test.ts`:

```typescript
describe('maxWallClockMs', () => {
  it('stops loop when wall clock exceeds deadline', async () => {
    let callCount = 0;
    const result = await runAgentLoop(orchestrator, {
      prompt: 'test',
      maxIterations: 10,
      maxWallClockMs: 100,
      validate: async () => ({ passed: false, summary: 'fail' }),
      execute: async () => {
        callCount++;
        // Simulate slow execution
        await new Promise((resolve) => setTimeout(resolve, 60));
        return 'output';
      },
      registration: { agentId: 'main', agentType: 'pi-session', sessionId: 's1', userId: 'u1' },
    });

    expect(result.passed).toBe(false);
    expect(result.reason).toBe('wall_clock_timeout');
    expect(callCount).toBeLessThan(10);
  });

  it('does not interfere when wall clock is not exceeded', async () => {
    const result = await runAgentLoop(orchestrator, {
      prompt: 'test',
      maxIterations: 3,
      maxWallClockMs: 60_000,
      validate: async (_output, iteration) => ({
        passed: iteration === 2,
        summary: iteration === 2 ? 'ok' : 'fail',
      }),
      execute: async () => 'output',
      registration: { agentId: 'main', agentType: 'pi-session', sessionId: 's1', userId: 'u1' },
    });

    expect(result.passed).toBe(true);
    expect(result.reason).toBe('validation_passed');
  });

  it('emits wall_clock_timeout reason in loop.end event', async () => {
    const events: any[] = [];
    eventBus.emit = vi.fn((e) => events.push(e));

    await runAgentLoop(orchestrator, {
      prompt: 'test',
      maxIterations: 10,
      maxWallClockMs: 50,
      validate: async () => ({ passed: false, summary: 'fail' }),
      execute: async () => {
        await new Promise((resolve) => setTimeout(resolve, 60));
        return 'output';
      },
      registration: { agentId: 'main', agentType: 'pi-session', sessionId: 's1', userId: 'u1' },
    });

    const endEvent = events.find((e) => e.type === 'agent.loop.end');
    expect(endEvent).toBeDefined();
    expect(endEvent.data.reason).toBe('wall_clock_timeout');
  });
});
```

### Step 3: Run tests to verify they fail

Run: `npx vitest run tests/host/orchestration/agent-loop.test.ts`
Expected: FAIL — `wall_clock_timeout` not returned

### Step 4: Implement wall-clock timeout

In `src/host/orchestration/agent-loop.ts`, inside `runAgentLoop()`:

Add deadline calculation at the start of the loop:
```typescript
  const deadline = config.maxWallClockMs
    ? loopStart + config.maxWallClockMs
    : null;
```

Add deadline check at the **top of each iteration** (before execute):
```typescript
    if (deadline && Date.now() >= deadline) {
      logger.warn('loop_wall_clock_timeout', { loopId, iteration, maxWallClockMs: config.maxWallClockMs });

      orchestrator.eventBus.emit({
        type: 'agent.loop.end',
        requestId: config.registration.sessionId,
        timestamp: Date.now(),
        data: { loopId, iteration: iteration - 1, maxIterations, reason: 'wall_clock_timeout', passed: false },
      });

      return {
        passed: false,
        iterations: iteration - 1,
        output: lastOutput,
        validation: lastValidation,
        handles: handleIds,
        totalDurationMs: Date.now() - loopStart,
        reason: 'wall_clock_timeout',
      };
    }
```

Also add deadline check **after execute returns** (before validate):
```typescript
    if (deadline && Date.now() >= deadline) {
      orchestrator.supervisor.complete(handle.id, 'Wall clock timeout');
      // ... same return as above, but with iteration = current iteration ...
    }
```

Note: `lastOutput` and `lastValidation` variables need to be tracked across iterations. Initialize them before the loop:
```typescript
  let lastOutput = '';
  let lastValidation: ValidationResult = { passed: false, summary: 'No iterations completed' };
```

### Step 5: Run tests to verify they pass

Run: `npx vitest run tests/host/orchestration/agent-loop.test.ts`
Expected: PASS

### Step 6: Run all orchestration tests

Run: `npx vitest run tests/host/orchestration/`
Expected: All PASS

### Step 7: Commit

```bash
git add src/host/orchestration/agent-loop.ts \
  tests/host/orchestration/agent-loop.test.ts
git commit -m "feat: add maxWallClockMs wall-clock timeout to agent loops"
```

---

## Final Verification

After all 4 tasks:

```bash
# Run all orchestration tests
npx vitest run tests/host/orchestration/

# Run full test suite to check for regressions
npm test

# Build to check for type errors
npm run build
```
