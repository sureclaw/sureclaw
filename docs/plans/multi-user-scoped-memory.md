# Multi-User Scoped Memory for MemoryFS

> **Plan location**: Save to `docs/plans/multi-user-scoped-memory.md` before implementation.

## Context

The memoryfs provider currently stores all memories in a shared pool — no per-user isolation.
The `user_id` column exists in SQLite but is never queried or filtered on.
This change adds multi-user scoping so that:

- **DMs/web chats**: memories are user-scoped by default; queries return the user's own + shared (agent-wide) memories
- **Channels/groups**: memories are agent-scoped; queries return only shared memories (never user-specific)
- **userId is enforced server-side** from `IPCContext` — agents cannot impersonate users or access other users' memories

Key design principle: `userId = NULL` means shared/agent-scoped. Existing data (all NULL) becomes shared — fully backward compatible.

---

## Step 1: Thread `sessionScope` through the IPC context pipeline

**Goal**: Make session scope (dm vs channel) available to IPC handlers.

### 1a. Add `sessionScope` to `IPCContext` (`src/host/ipc-server.ts:34-38`)

Add `sessionScope?: 'dm' | 'channel' | 'thread' | 'group'` to the interface. In `handleIPC()` (~line 154-166), extract `_sessionScope` metadata alongside existing `_sessionId`/`_userId`:

```typescript
const requestSessionScope = (parsed as Record<string, unknown>)._sessionScope;
if (requestSessionScope !== undefined) {
  delete (parsed as Record<string, unknown>)._sessionScope;
}
const effectiveCtx = {
  ...ctx,
  ...(typeof requestSessionId === 'string' ? { sessionId: requestSessionId } : {}),
  ...(typeof requestUserId === 'string' ? { userId: requestUserId } : {}),
  ...(typeof requestSessionScope === 'string' ? { sessionScope: requestSessionScope } : {}),
};
```

### 1b. Add `sessionScope` to stdin payload (`src/host/server-completions.ts`)

- Add `sessionScope?: SessionScope` parameter to `processCompletion()` (after `replyOptional`, line 168)
- Include it in the stdin JSON payload (~line 449-465): `sessionScope: sessionScope ?? 'dm'`
- HTTP API path already defaults to `'dm'` (line 211: `session: { provider: 'http', scope: 'dm', ... }`)

### 1c. Pass session scope from channel handler (`src/host/server-channels.ts`)

At the `processCompletion()` callsite (~line 241), pass `msg.session.scope`:

```typescript
await processCompletion(
  completionDeps, messageContent, requestId, [], sessionId,
  preProcessed, msg.sender, replyOptional, msg.session.scope,  // ← new
);
```

### 1d. Parse and propagate in agent runner (`src/agent/runner.ts`)

In `parseStdinPayload()`, extract `sessionScope` from the stdin JSON and pass it through to `IPCClient` constructor.

### 1e. Inject `_sessionScope` in IPC client (`src/agent/ipc-client.ts:113-117`)

Follow existing `_sessionId`/`_userId` pattern:

```typescript
const enriched = {
  ...request,
  ...(this.sessionId ? { _sessionId: this.sessionId } : {}),
  ...(this.userId ? { _userId: this.userId } : {}),
  ...(this.sessionScope ? { _sessionScope: this.sessionScope } : {}),
};
```

**Files**: `ipc-server.ts`, `server-completions.ts`, `server-channels.ts`, `runner.ts`, `ipc-client.ts`

---

## Step 2: Add `userId` to memory provider types

**File**: `src/providers/memory/types.ts`

```typescript
interface MemoryEntry {
  // ... existing ...
  userId?: string;  // owner of this memory; NULL = shared/agent-scoped
}

interface MemoryQuery {
  // ... existing ...
  userId?: string;  // when set: return user's own + shared; when absent: shared only
}

interface MemoryProvider {
  // Update list and memorize signatures:
  list(scope: string, limit?: number, userId?: string): Promise<MemoryEntry[]>;
  memorize?(conversation: ConversationTurn[], userId?: string): Promise<void>;
}
```

---

## Step 3: Update ItemsStore with userId filtering

**File**: `src/providers/memory/memoryfs/items-store.ts`

### 3a. Add userId index (line 32)

```sql
CREATE INDEX IF NOT EXISTS idx_items_user ON items(user_id, scope)
```

### 3b. Update `findByHash()` (line 67-74)

Add `userId?: string` parameter. When userId set, match `user_id = ?`; when absent, match `user_id IS NULL`:

```typescript
findByHash(contentHash: string, scope: string, agentId?: string, userId?: string): MemoryFSItem | null
```

### 3c. Update `listByScope()` (line 94-108)

Add `userId?: string` parameter. When userId set, use `(user_id = ? OR user_id IS NULL)` to return own + shared:

```typescript
listByScope(scope: string, limit?: number, agentId?: string, userId?: string): MemoryFSItem[]
```

### 3d. Update `searchContent()` (line 117-122)

Add `userId?: string` parameter with same `(user_id = ? OR user_id IS NULL)` pattern.

### 3e. Update `listByCategory()` (line 85-92)

Add `userId?: string` parameter with same pattern.

---

## Step 4: Update EmbeddingStore with userId filtering

**File**: `src/providers/memory/memoryfs/embedding-store.ts`

### 4a. Schema migration — add `user_id` column

Follow existing migration pattern (line 70-74):

```typescript
try {
  db.exec('ALTER TABLE embedding_meta ADD COLUMN user_id TEXT');
} catch { /* Column already exists */ }
db.exec('CREATE INDEX IF NOT EXISTS idx_emeta_user ON embedding_meta(user_id, scope)');
```

### 4b. Update `upsert()` (line 105-143)

Accept `userId?: string`. Store in `embedding_meta`:

```typescript
async upsert(itemId: string, scope: string, embedding: Float32Array, userId?: string): Promise<void>
```

### 4c. Update `findSimilar()` (line 150-191)

Accept `userId?: string`. For scoped queries, add userId filtering:

```sql
-- When userId set: return user's own + shared
WHERE scope = ? AND (user_id = ? OR user_id IS NULL) AND embedding IS NOT NULL
-- When userId absent: shared only
WHERE scope = ? AND user_id IS NULL AND embedding IS NOT NULL
```

---

## Step 5: Update MemoryFS provider to thread userId

**File**: `src/providers/memory/memoryfs/provider.ts`

### 5a. `write()` (line 139-207)

- Pass `entry.userId` to `store.findByHash(contentHash, scope, entry.agentId, entry.userId)`
- Pass `entry.userId` to `store.insert({ ..., userId: entry.userId })`
- Pass `entry.userId` to `embeddingStore.upsert(id, scope, vector, entry.userId)`

### 5b. `query()` (line 209-286)

- Pass `q.userId` to `embeddingStore.findSimilar(embedding, limit, scope, q.userId)`
- Pass `q.userId` to `store.searchContent(q.query, scope, limit, q.userId)` and `store.listByScope(scope, limit, q.agentId, q.userId)`
- Add userId post-filter for embedding path (like agentId filter on line 262-264)
- Include `userId: item.userId` in all MemoryFSItem → MemoryEntry mappings

### 5c. `list()` (line 306-316)

Accept `userId?: string` third parameter, pass to `store.listByScope()`.

### 5d. `memorize()` (line 318-363)

Accept `userId?: string` second parameter. Pass through to:
- `store.findByHash(candidate.contentHash, scope, undefined, userId)`
- `store.insert({ ...candidate, userId })`
- `embeddingStore.upsert(id, scope, vector, userId)`

### 5e. Return value mapping

Add `userId: item.userId` to ALL MemoryFSItem → MemoryEntry conversions (~lines 243-250, 278-285, 291-298, 308-315).

---

## Step 6: Server-side userId injection in IPC handler

**File**: `src/host/ipc-handlers/memory.ts`

This is the enforcement point. The handler reads `ctx.userId` and `ctx.sessionScope` to decide scoping:

```typescript
function isDmScope(ctx: IPCContext): boolean {
  return ctx.sessionScope === 'dm' || ctx.sessionScope === undefined;
}

memory_write: async (req, ctx) => {
  const entry = {
    ...req,
    userId: isDmScope(ctx) ? ctx.userId : undefined,  // channel writes are shared
    agentId: ctx.agentId !== 'system' ? ctx.agentId : undefined,
  };
  await providers.audit.log({ action: 'memory_write', args: { scope: req.scope } });
  return { id: await providers.memory.write(entry) };
},

memory_query: async (req, ctx) => {
  const query = {
    ...req,
    userId: isDmScope(ctx) ? ctx.userId : undefined,
  };
  return { results: await providers.memory.query(query) };
},

memory_list: async (req, ctx) => {
  const userId = isDmScope(ctx) ? ctx.userId : undefined;
  return { entries: await providers.memory.list(req.scope, req.limit, userId) };
},

memory_read: async (req) => {
  // read by ID — no userId filter needed (if you have the ID, you can read it)
  return { entry: await providers.memory.read(req.id) };
},

memory_delete: async (req, ctx) => {
  // Audit + delete — could add ownership check later
  await providers.audit.log({ action: 'memory_delete', sessionId: ctx.sessionId, args: { id: req.id } });
  await providers.memory.delete(req.id);
  return { ok: true };
},
```

No IPC schema changes — userId never appears in agent-facing schemas.

---

## Step 7: User-aware memory recall

**File**: `src/host/memory-recall.ts`

### 7a. Add userId and sessionScope to config

```typescript
interface MemoryRecallConfig {
  enabled: boolean;
  limit: number;
  scope: string;
  embeddingClient?: EmbeddingClient;
  userId?: string;               // NEW
  sessionScope?: SessionScope;   // NEW
}
```

### 7b. Update `recallMemoryForMessage()` (line 104-174)

Inject userId into queries based on session scope:

```typescript
const isDm = config.sessionScope === 'dm' || config.sessionScope === undefined;
const queryUserId = isDm ? config.userId : undefined;

const entries = await memory.query({
  scope: config.scope,
  embedding,
  limit: config.limit,
  userId: queryUserId,
});
```

Apply same pattern to keyword search fallback path (~line 151).

### 7c. Update callsite in `server-completions.ts` (~line 339-356)

Pass userId and sessionScope into the recall config:

```typescript
const recallConfig: MemoryRecallConfig = {
  enabled: config.history.memory_recall,
  limit: config.history.memory_recall_limit,
  scope: config.history.memory_recall_scope,
  embeddingClient,
  userId: currentUserId,
  sessionScope: sessionScope,  // from the new processCompletion param
};
```

### 7d. Update `memorize()` callsite in `server-completions.ts` (~line 670-682)

Pass userId based on session scope:

```typescript
const isDm = (sessionScope ?? 'dm') === 'dm';
await providers.memory.memorize(fullHistory, isDm ? currentUserId : undefined);
```

---

## Step 8: Tests

### 8a. ItemsStore tests (`tests/providers/memory/memoryfs/items-store.test.ts`)

Mirror existing agentId scoping tests:
- `findByHash` isolates by userId (user A's hash ≠ user B's hash lookup)
- `listByScope` with userId returns own + shared (user_id IS NULL)
- `listByScope` without userId returns shared only
- `searchContent` with userId filters correctly
- New index is created

### 8b. EmbeddingStore tests (`tests/providers/memory/memoryfs/embedding-store.test.ts`)

- `findSimilar` with userId returns user's own + shared embeddings
- `findSimilar` without userId returns shared only
- `upsert` stores userId in embedding_meta

### 8c. Provider tests (`tests/providers/memory/memoryfs/provider.test.ts`)

- `write()` with userId stores user-scoped entry
- `query()` with userId returns own + shared
- `query()` without userId returns shared only
- `list()` with userId returns own + shared
- Hash dedup scopes by userId (same content, different users = separate entries)
- Semantic dedup scopes by userId

### 8d. IPC handler tests (`tests/host/ipc-handlers/memory.test.ts` — new or extend existing)

- DM context (`sessionScope: 'dm'`): writes inject ctx.userId, queries include ctx.userId
- Channel context (`sessionScope: 'channel'`): writes set userId=undefined, queries set userId=undefined
- Undefined sessionScope defaults to DM behavior

### 8e. Memory recall tests (`tests/host/memory-recall.test.ts`)

- Recall with userId queries user's own + shared
- Recall without userId (channel) queries shared only
- Memorize with DM scope passes userId
- Memorize with channel scope passes undefined

---

## Step 9: Journal + Lessons update

Per CLAUDE.md protocol, update journal and lessons before committing.

---

## Files Modified (ordered by dependency)

| # | File | Change |
|---|------|--------|
| 1 | `src/host/ipc-server.ts` | Add `sessionScope` to `IPCContext`, extract `_sessionScope` in `handleIPC` |
| 2 | `src/providers/memory/types.ts` | Add `userId` to `MemoryEntry`/`MemoryQuery`, update `list`/`memorize` signatures |
| 3 | `src/providers/memory/memoryfs/items-store.ts` | Add userId index, update `findByHash`, `listByScope`, `searchContent`, `listByCategory` |
| 4 | `src/providers/memory/memoryfs/embedding-store.ts` | Add `user_id` column + migration, update `upsert`, `findSimilar` |
| 5 | `src/providers/memory/memoryfs/provider.ts` | Thread userId through write/query/list/memorize + return userId in mappings |
| 6 | `src/host/ipc-handlers/memory.ts` | Server-side userId injection + DM/channel scoping logic |
| 7 | `src/host/memory-recall.ts` | Add userId/sessionScope to config, inject into queries |
| 8 | `src/host/server-completions.ts` | Accept `sessionScope` param, pass to recall/memorize/stdin payload |
| 9 | `src/host/server-channels.ts` | Pass `msg.session.scope` to `processCompletion()` |
| 10 | `src/agent/ipc-client.ts` | Add `_sessionScope` metadata injection |
| 11 | `src/agent/runner.ts` | Parse `sessionScope` from stdin, pass to `IPCClient` |
| 12-16 | `tests/...` | New multi-user isolation tests per Step 8 |

## What Does NOT Change

- IPC schemas (`ipc-schemas.ts`) — no userId in agent-facing schemas
- Agent tool catalog — no `injectUserId` flag needed
- Category summary `.md` files — stay agent-wide
- Salience scoring, content hashing, extraction prompts — unchanged

## Verification

1. **Unit tests**: `npm test -- tests/providers/memory/memoryfs/items-store.test.ts tests/providers/memory/memoryfs/provider.test.ts tests/providers/memory/memoryfs/embedding-store.test.ts tests/host/memory-recall.test.ts`
2. **Build**: `npm run build` — verify no type errors
3. **All tests**: `npm test` — verify no regressions
4. **Manual smoke test**: Start AX, write memories as two different users in DM context, verify isolation; write in channel context, verify shared-only behavior
