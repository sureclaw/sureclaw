# Embedding-Based Memory Recall — Implementation Plan

Replace LIKE keyword search with semantic vector search for MemoryFS memory
recall. Uses `@dao-xyz/sqlite3-vec` for vector storage and OpenAI embeddings API
(configurable model) for embedding generation. Falls back to keyword search when
no `OPENAI_API_KEY` is set.

## Architecture Overview

```
Write path (memorize / write):
  content → EmbeddingClient.embed() → Float32Array
                                          ↓
  ItemsStore.insert(item) ──────→ EmbeddingStore.upsert(itemId, vector)

Query path (recall / query):
  user message → EmbeddingClient.embed() → Float32Array
                                                ↓
  EmbeddingStore.findSimilar(vector, limit) → [{itemId, distance}]
                                                ↓
  ItemsStore.getByIds(itemIds) → MemoryEntry[] (ranked by distance × salience)

Fallback: When OPENAI_API_KEY is absent, degrade to existing LIKE search.
```

History assembly order remains:
`[memory recall] → [summaries] → [recent turns] → [current message]`

---

## Step 1: Add `@dao-xyz/sqlite3-vec` dependency

**File:** `package.json`

```bash
npm install @dao-xyz/sqlite3-vec
```

This brings sqlite-vec (the C extension) and a Node.js wrapper that auto-loads
the vec extension into better-sqlite3.

---

## Step 2: Create `EmbeddingClient` utility

**New file:** `src/utils/embedding-client.ts`

A standalone, stateless client for generating text embeddings. Wraps the OpenAI
SDK's `embeddings.create()` endpoint. Not an LLM provider — this is a utility.

```typescript
interface EmbeddingClientConfig {
  model: string;       // e.g. 'text-embedding-3-small'
  dimensions: number;  // e.g. 1536
  apiKey?: string;     // defaults to OPENAI_API_KEY env var
  baseUrl?: string;    // defaults to https://api.openai.com/v1
}

interface EmbeddingClient {
  embed(texts: string[]): Promise<Float32Array[]>;
  readonly dimensions: number;
  readonly available: boolean;  // false when no API key
}

function createEmbeddingClient(config: EmbeddingClientConfig): EmbeddingClient
```

Key behaviors:
- Returns `available: false` when no API key set (no throw — graceful degradation)
- Returns Float32Array for direct sqlite-vec consumption
- Uses `openai` SDK already in dependencies — no new HTTP client
- Logs via `getLogger().child({ component: 'embedding-client' })`

**New test file:** `tests/utils/embedding-client.test.ts`
- Test graceful degradation when no API key
- Test Float32Array output format
- Mock OpenAI SDK for unit tests

---

## Step 3: Create `EmbeddingStore` for sqlite-vec operations

**New file:** `src/providers/memory/memoryfs/embedding-store.ts`

A vector store backed by sqlite-vec's `vec0` virtual table. Separate from
`ItemsStore` — uses `@dao-xyz/sqlite3-vec`'s `createDatabase()` for automatic
extension loading.

```typescript
class EmbeddingStore {
  constructor(dbPath: string, dimensions: number);

  upsert(itemId: string, embedding: Float32Array): void;
  findSimilar(query: Float32Array, limit: number, scope?: string): Array<{
    itemId: string;
    distance: number;
  }>;
  delete(itemId: string): void;
  hasEmbedding(itemId: string): boolean;
  listUnembedded(limit: number): string[];  // for backfill
  close(): void;
}
```

Schema:
```sql
-- vec0 virtual table for vector similarity search
CREATE VIRTUAL TABLE IF NOT EXISTS item_embeddings USING vec0(
  item_id TEXT PRIMARY KEY,
  embedding float[{dimensions}]
);

-- Mapping table to join vectors with scope for filtering
CREATE TABLE IF NOT EXISTS embedding_meta (
  item_id    TEXT PRIMARY KEY,
  scope      TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_emeta_scope ON embedding_meta(scope);
```

Separate database file (`_vec.db`) to avoid extension compatibility issues with
the existing sync SQLite adapter used by `ItemsStore`.

Query pattern:
```sql
SELECT em.item_id, v.distance
FROM item_embeddings v
JOIN embedding_meta em ON em.item_id = v.item_id
WHERE em.scope = ?
  AND v.embedding MATCH ?
ORDER BY v.distance
LIMIT ?
```

**New test file:** `tests/providers/memory/memoryfs/embedding-store.test.ts`
- Test CRUD operations (upsert, find, delete)
- Test similarity search returns correct ordering
- Test scope filtering
- Test `listUnembedded()` for backfill
- Uses temp file for database

---

## Step 4: Extend `MemoryQuery` with optional embedding field

**Modified file:** `src/providers/memory/types.ts`

```typescript
export interface MemoryQuery {
  scope: string;
  query?: string;
  limit?: number;
  tags?: string[];
  agentId?: string;
  /** Pre-computed embedding vector for semantic search (optional). */
  embedding?: Float32Array;
}
```

Backward-compatible — existing providers ignore the field.

---

## Step 5: Integrate embeddings into MemoryFS provider

**Modified file:** `src/providers/memory/memoryfs/provider.ts`

Changes to `create(config)`:

1. Initialize `EmbeddingClient` from config/env vars
2. Initialize `EmbeddingStore` alongside `ItemsStore`
3. On `write()`: generate embedding → `embeddingStore.upsert()`
4. On `memorize()`: batch-generate embeddings for all new items
5. On `query()`:
   - If `q.embedding` provided → `embeddingStore.findSimilar()` → join with salience
   - Else if `q.query` provided → existing LIKE search (fallback)
   - Rank: combine `similarity = 1 / (1 + distance)` with existing `salienceScore()`
6. On `delete()`: also delete from embedding store

The salience formula in `salience.ts` already accepts a `similarity` parameter —
pass computed similarity instead of the hardcoded `1.0` currently used.

**Modified file:** `src/providers/memory/memoryfs/items-store.ts`

Add `getByIds(ids: string[]): MemoryFSItem[]` — batch lookup by ID list
(needed to hydrate vector search results into full items).

---

## Step 6: Update memory recall to use embeddings

**Modified file:** `src/host/memory-recall.ts`

```typescript
export interface MemoryRecallConfig {
  enabled: boolean;
  limit: number;
  scope: string;
  /** Embedding client for semantic search (falls back to keywords if absent). */
  embeddingClient?: EmbeddingClient;
}
```

Changes to `recallMemoryForMessage()`:
1. If `embeddingClient?.available` → embed user message → pass `{ embedding }` in query
2. Else → fall back to existing `extractQueryTerms()` + keyword search
3. Logging: add `strategy: 'embedding' | 'keyword'` to recall log events

**Modified file:** `src/host/server-completions.ts`

Create `EmbeddingClient` instance from config and pass to memory recall:

```typescript
import { createEmbeddingClient } from '../utils/embedding-client.js';

const embeddingClient = createEmbeddingClient({
  model: config.history.embedding_model,
  dimensions: config.history.embedding_dimensions,
});

const recallConfig: MemoryRecallConfig = {
  enabled: config.history.memory_recall,
  limit: config.history.memory_recall_limit,
  scope: config.history.memory_recall_scope,
  embeddingClient,
};
```

---

## Step 7: Add config fields for embeddings

**Modified file:** `src/config.ts`

Add to the `history` strict object:
```typescript
embedding_model: z.string().default('text-embedding-3-small'),
embedding_dimensions: z.number().int().min(64).max(4096).default(1536),
```

**Modified file:** `src/types.ts`

Add to `Config.history`:
```typescript
embedding_model: string;
embedding_dimensions: number;
```

---

## Step 8: Background backfill for existing memories

**Modified file:** `src/providers/memory/memoryfs/provider.ts`

After initialization, kick off a fire-and-forget backfill:

```typescript
async function backfillEmbeddings(
  store: ItemsStore,
  embeddingStore: EmbeddingStore,
  client: EmbeddingClient,
  batchSize = 50,
) {
  if (!client.available) return;
  const unembedded = embeddingStore.listUnembedded(batchSize);
  if (unembedded.length === 0) return;

  const items = store.getByIds(unembedded);
  const vectors = await client.embed(items.map(i => i.content));
  for (let i = 0; i < items.length; i++) {
    embeddingStore.upsert(items[i].id, vectors[i]);
  }
}
```

- Runs once on provider creation (non-blocking)
- Processes in batches of 50
- Logs progress and errors
- Subsequent queries will have embeddings available

---

## Step 9: Tests

**New test files:**
- `tests/utils/embedding-client.test.ts` — Client unit tests
- `tests/providers/memory/memoryfs/embedding-store.test.ts` — Vector store tests

**Modified test files:**
- `tests/host/memory-recall.test.ts` — Add embedding-based recall tests:
  - Embedding available → uses semantic search
  - Embedding unavailable → falls back to keywords
  - Mock embedding client
- `tests/config-history.test.ts` — Update default config assertion with new fields
- `tests/providers/memory/memoryfs/` — Update provider tests:
  - Test write generates embedding when client available
  - Test query with embedding field uses vector search
  - Test graceful fallback when no embedding client

---

## Step 10: Journal and lessons

Update `.claude/journal/` and `.claude/lessons/` per protocol before committing.

---

## File Change Summary

| File | Action | Description |
|------|--------|-------------|
| `package.json` | modify | Add `@dao-xyz/sqlite3-vec` |
| `src/utils/embedding-client.ts` | **new** | Standalone OpenAI embedding client |
| `src/providers/memory/memoryfs/embedding-store.ts` | **new** | sqlite-vec vector store |
| `src/providers/memory/types.ts` | modify | Add optional `embedding` to MemoryQuery |
| `src/providers/memory/memoryfs/provider.ts` | modify | Integrate embedding on write/query |
| `src/providers/memory/memoryfs/items-store.ts` | modify | Add `getByIds()` batch method |
| `src/host/memory-recall.ts` | modify | Embed user message, pass to query, fallback |
| `src/host/server-completions.ts` | modify | Create embedding client, pass to recall |
| `src/config.ts` | modify | Add `embedding_model`, `embedding_dimensions` |
| `src/types.ts` | modify | Add embedding config to `Config.history` |
| `tests/utils/embedding-client.test.ts` | **new** | Embedding client unit tests |
| `tests/providers/memory/memoryfs/embedding-store.test.ts` | **new** | Vector store tests |
| `tests/host/memory-recall.test.ts` | modify | Add embedding recall tests |
| `tests/config-history.test.ts` | modify | Update default config assertion |

---

## Key Design Decisions

1. **Separate `EmbeddingClient` utility** (not extending LLMProvider) — embeddings are request/response, not streaming chat. Different API shape entirely.

2. **Separate `_vec.db` file** — avoids compatibility issues between the vec extension and the existing sync SQLite adapter. The vec extension needs to be loaded via `@dao-xyz/sqlite3-vec`, not the generic `openDatabase()`.

3. **`MemoryQuery.embedding` optional field** (not new interface method) — backward compatible, all existing providers and callers continue to work unchanged.

4. **FTS5/LIKE fallback** — when `OPENAI_API_KEY` is absent, the system degrades to keyword search silently. No errors, no broken functionality.

5. **Configurable model + dimensions** — defaulting to `text-embedding-3-small` (1536 dims, $0.02/1M tokens). Can set to any OpenAI-compatible embedding endpoint via config.

6. **Background backfill** — existing memories get embeddings generated lazily after startup. Non-blocking, non-critical.

7. **Similarity × salience scoring** — vector distance maps to `similarity = 1 / (1 + distance)`, then feeds into the existing `salienceScore()` formula. Combines semantic relevance with reinforcement frequency and recency.

8. **EmbeddingClient created in two places** — MemoryFS provider (for write-time embedding) and server-completions (for query-time embedding). Both are stateless OpenAI HTTP clients reading from the same env vars. This avoids threading the embedding client through the provider registry.
