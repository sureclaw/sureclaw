# MemoryFS Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace AX's heuristic in-memory `memu` provider with a production-grade, filesystem-native, Markdown-based agent memory system backed by SQLite + sqlite-vec for vector search.

**Architecture:** MemoryFS is a new memory provider (`memoryfs`) that stores each fact as a Markdown file with YAML frontmatter, uses SQLite + sqlite-vec for embeddings and metadata, and implements two-phase writes with a reconciler for file↔DB consistency. It plugs into AX's existing provider contract (`MemoryProvider`) and IPC schema, adding semantic retrieval, LLM-powered extraction, tiered decay, and proactive anticipation across six composable modules.

**Tech Stack:** TypeScript, better-sqlite3, sqlite-vec, gray-matter (YAML frontmatter), nanoid, Kysely (migrations), vitest (tests)

---

## Source Documents

- `memory-proposal.md` — MemoryFS v1.0 architecture spec (Extractor, Categorizer, Retriever, Decayer, Monitor, Anticipator)
- `memory-feedback.md` — Consolidated review with Git integration, reconciler, tiered decay, idempotency recommendations

---

## Phase 1a: Storage Foundation

### Task 1: MemoryFS Directory Scaffold & Types

**Files:**
- Create: `src/providers/memory/memoryfs/types.ts`
- Create: `src/providers/memory/memoryfs/index.ts`
- Test: `tests/providers/memory/memoryfs/types.test.ts`

**Context:** Define all MemoryFS-specific types that extend the existing `MemoryProvider` interface. These types are used by every subsequent module.

**Step 1: Write the failing test**

```typescript
// tests/providers/memory/memoryfs/types.test.ts
import { describe, it, expect } from 'vitest';
import type { MemoryFSItem, MemoryFSConfig, ItemStatus, DecayTier } from '../../../src/providers/memory/memoryfs/types.js';

describe('MemoryFS types', () => {
  it('MemoryFSItem has required frontmatter fields', () => {
    const item: MemoryFSItem = {
      id: 'mem_abc123',
      sourceConversation: 'conv_xyz',
      sourceTenant: 'tenant_acme',
      schemaVersion: 1,
      writeVersion: 1,
      status: 'active',
      created: '2026-03-01T00:00:00Z',
      lastAccessed: '2026-03-01T00:00:00Z',
      accessCount: 0,
      priority: 0.8,
      tags: ['test'],
      sensitivity: 'low',
      factFingerprint: 'sha256:abc',
      content: 'Test fact.',
      decayTier: 'hot',
    };
    expect(item.schemaVersion).toBe(1);
    expect(item.status).toBe('active');
    expect(item.decayTier).toBe('hot');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/providers/memory/memoryfs/types.test.ts`
Expected: FAIL — module not found

**Step 3: Write the types**

```typescript
// src/providers/memory/memoryfs/types.ts
import type { LLMProvider } from '../../llm/types.js';

export type ItemStatus = 'active' | 'superseded' | 'archived';
export type DecayTier = 'hot' | 'warm' | 'cold';
export type Sensitivity = 'low' | 'internal' | 'restricted';

export interface MemoryFSItem {
  id: string;                        // mem_{nanoid}
  sourceConversation: string;
  sourceTenant: string;
  schemaVersion: number;             // Always 1 for v1
  writeVersion: number;              // Monotonic per item
  status: ItemStatus;
  created: string;                   // ISO 8601
  lastAccessed: string;              // ISO 8601
  accessCount: number;
  priority: number;                  // 0.0–1.0
  tags: string[];
  sensitivity: Sensitivity;
  factFingerprint: string;           // sha256 of normalized content
  content: string;                   // The actual fact (1-3 sentences)
  decayTier: DecayTier;
  relatedItems?: string[];
  supersedes?: string;               // ID of item this replaces
  supersededBy?: string;             // ID of item that replaced this
}

export interface MemoryFSConfig {
  memoryDir: string;                 // Root directory for all memory files
  embeddingsDbPath: string;          // Path to SQLite + sqlite-vec database
  llmProvider: LLMProvider;

  // Model selection (use cheapest available by default)
  extractionModel?: string;
  categorizationModel?: string;
  anticipationModel?: string;
  rerankModel?: string;
  embeddingModel?: string;

  // Tenant defaults
  defaults?: MemoryFSDefaults;
}

export interface MemoryFSDefaults {
  decayHalfLifeDays?: number;        // Default: 30
  decayMinPriority?: number;         // Default: 0.15
  maxItemsPerTenant?: number;        // Default: 5000
  monitorRelevanceThreshold?: number; // Default: 0.65
  triggerTTLHours?: number;          // Default: 4
  maxTriggersPerTenant?: number;     // Default: 5
  maxCategories?: number;            // Default: 20
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/providers/memory/memoryfs/types.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/providers/memory/memoryfs/types.ts tests/providers/memory/memoryfs/types.test.ts
git commit -m "feat(memoryfs): add core types with schema versioning and decay tiers"
```

---

### Task 2: Markdown File I/O (Item Read/Write with Frontmatter)

**Files:**
- Create: `src/providers/memory/memoryfs/item-io.ts`
- Test: `tests/providers/memory/memoryfs/item-io.test.ts`

**Context:** Every memory item is a `.md` file with YAML frontmatter. This module handles serialization/deserialization using `gray-matter`, two-phase writes (temp → rename), and `safePath` for security.

**Step 1: Write the failing tests**

```typescript
// tests/providers/memory/memoryfs/item-io.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeItem, readItem, deleteItem, listItems } from '../../../../src/providers/memory/memoryfs/item-io.js';
import type { MemoryFSItem } from '../../../../src/providers/memory/memoryfs/types.js';

describe('item-io', () => {
  let baseDir: string;
  const tenantId = 'tenant_test';

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), 'memfs-test-'));
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  const sampleItem: MemoryFSItem = {
    id: 'mem_abc123',
    sourceConversation: 'conv_xyz',
    sourceTenant: 'tenant_test',
    schemaVersion: 1,
    writeVersion: 1,
    status: 'active',
    created: '2026-03-01T00:00:00Z',
    lastAccessed: '2026-03-01T00:00:00Z',
    accessCount: 0,
    priority: 0.82,
    tags: ['deployment', 'gke'],
    sensitivity: 'low',
    factFingerprint: 'sha256:abc123',
    content: 'FalkorDB runs on GKE using a StatefulSet.',
    decayTier: 'hot',
  };

  it('writes and reads an item round-trip', async () => {
    await writeItem(baseDir, tenantId, sampleItem);
    const read = await readItem(baseDir, tenantId, sampleItem.id);
    expect(read).not.toBeNull();
    expect(read!.content).toBe(sampleItem.content);
    expect(read!.priority).toBe(0.82);
    expect(read!.tags).toEqual(['deployment', 'gke']);
  });

  it('writes atomically (temp file then rename)', async () => {
    // Write should not leave .tmp files on success
    await writeItem(baseDir, tenantId, sampleItem);
    const { readdir } = await import('node:fs/promises');
    const files = await readdir(join(baseDir, tenantId, 'items'));
    expect(files.every(f => !f.endsWith('.tmp'))).toBe(true);
  });

  it('deletes an item', async () => {
    await writeItem(baseDir, tenantId, sampleItem);
    await deleteItem(baseDir, tenantId, sampleItem.id);
    const read = await readItem(baseDir, tenantId, sampleItem.id);
    expect(read).toBeNull();
  });

  it('lists items for a tenant', async () => {
    await writeItem(baseDir, tenantId, sampleItem);
    const second = { ...sampleItem, id: 'mem_def456', content: 'Second fact.' };
    await writeItem(baseDir, tenantId, second);
    const items = await listItems(baseDir, tenantId);
    expect(items).toHaveLength(2);
  });

  it('rejects path traversal in tenantId', async () => {
    await expect(writeItem(baseDir, '../escape', sampleItem)).rejects.toThrow();
  });

  it('rejects path traversal in item id', async () => {
    const bad = { ...sampleItem, id: '../../etc/passwd' };
    await expect(writeItem(baseDir, tenantId, bad)).rejects.toThrow();
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/providers/memory/memoryfs/item-io.test.ts`
Expected: FAIL — module not found

**Step 3: Implement item-io**

Write `src/providers/memory/memoryfs/item-io.ts`:
- Use `gray-matter` to serialize/deserialize YAML frontmatter + Markdown content
- Use `safePath()` from `src/utils/safe-path.ts` for all path construction
- Two-phase write: write to `.tmp` file, then `rename()` atomically
- Use `mkdir({ recursive: true })` for tenant directory creation
- `readItem` returns `null` for missing files (no throw)

**Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/providers/memory/memoryfs/item-io.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/providers/memory/memoryfs/item-io.ts tests/providers/memory/memoryfs/item-io.test.ts
git commit -m "feat(memoryfs): add markdown item I/O with two-phase atomic writes"
```

---

### Task 3: SQLite + sqlite-vec Embeddings Database

**Files:**
- Create: `src/providers/memory/memoryfs/embeddings-db.ts`
- Create: `src/migrations/memoryfs.ts`
- Test: `tests/providers/memory/memoryfs/embeddings-db.test.ts`

**Context:** Single SQLite database at `memory/_embeddings.db` with a `vec_items` virtual table (sqlite-vec) for ANN search and an `item_meta` table for fast lookups without reading files. Uses AX's existing `openDatabase()` utility and Kysely migrations.

**Step 1: Write the failing tests**

```typescript
// tests/providers/memory/memoryfs/embeddings-db.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EmbeddingsDB } from '../../../../src/providers/memory/memoryfs/embeddings-db.js';

describe('EmbeddingsDB', () => {
  let db: EmbeddingsDB;

  beforeEach(() => {
    db = new EmbeddingsDB(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('upserts and retrieves item metadata', () => {
    db.upsertMeta({
      tenantId: 'tenant_test',
      itemId: 'mem_abc',
      contentHash: 'sha256:abc',
      tags: ['test'],
      category: null,
      priority: 0.8,
      lastAccessed: '2026-03-01T00:00:00Z',
      accessCount: 0,
      created: '2026-03-01T00:00:00Z',
      status: 'active',
      decayTier: 'hot',
    });

    const meta = db.getMeta('tenant_test', 'mem_abc');
    expect(meta).not.toBeNull();
    expect(meta!.priority).toBe(0.8);
    expect(meta!.tags).toEqual(['test']);
  });

  it('deletes item metadata', () => {
    db.upsertMeta({
      tenantId: 'tenant_test', itemId: 'mem_abc', contentHash: 'sha256:abc',
      tags: [], category: null, priority: 0.5, lastAccessed: '2026-03-01T00:00:00Z',
      accessCount: 0, created: '2026-03-01T00:00:00Z', status: 'active', decayTier: 'hot',
    });
    db.deleteMeta('tenant_test', 'mem_abc');
    expect(db.getMeta('tenant_test', 'mem_abc')).toBeNull();
  });

  it('lists all metadata for a tenant', () => {
    db.upsertMeta({
      tenantId: 'tenant_test', itemId: 'mem_1', contentHash: 'sha256:1',
      tags: [], category: null, priority: 0.5, lastAccessed: '2026-03-01T00:00:00Z',
      accessCount: 0, created: '2026-03-01T00:00:00Z', status: 'active', decayTier: 'hot',
    });
    db.upsertMeta({
      tenantId: 'tenant_test', itemId: 'mem_2', contentHash: 'sha256:2',
      tags: [], category: null, priority: 0.9, lastAccessed: '2026-03-01T00:00:00Z',
      accessCount: 0, created: '2026-03-01T00:00:00Z', status: 'active', decayTier: 'hot',
    });
    db.upsertMeta({
      tenantId: 'other', itemId: 'mem_3', contentHash: 'sha256:3',
      tags: [], category: null, priority: 0.5, lastAccessed: '2026-03-01T00:00:00Z',
      accessCount: 0, created: '2026-03-01T00:00:00Z', status: 'active', decayTier: 'hot',
    });

    const items = db.listMeta('tenant_test');
    expect(items).toHaveLength(2);
  });

  it('bumps access count and last_accessed', () => {
    db.upsertMeta({
      tenantId: 'tenant_test', itemId: 'mem_abc', contentHash: 'sha256:abc',
      tags: [], category: null, priority: 0.5, lastAccessed: '2026-01-01T00:00:00Z',
      accessCount: 0, created: '2026-01-01T00:00:00Z', status: 'active', decayTier: 'hot',
    });
    db.recordAccess('tenant_test', 'mem_abc');
    const meta = db.getMeta('tenant_test', 'mem_abc');
    expect(meta!.accessCount).toBe(1);
    expect(meta!.lastAccessed).not.toBe('2026-01-01T00:00:00Z');
  });
});
```

**Note:** sqlite-vec vector tests (upsertEmbedding, search) should be in a separate describe block gated on sqlite-vec availability, since sqlite-vec may not be installed in all CI environments. Test the metadata layer independently.

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/providers/memory/memoryfs/embeddings-db.test.ts`
Expected: FAIL — module not found

**Step 3: Implement EmbeddingsDB**

Write `src/providers/memory/memoryfs/embeddings-db.ts`:
- Use `openDatabase()` from `src/utils/sqlite.ts`
- Create `item_meta` table (tenant_id, item_id, content_hash, tags JSON, category, priority, last_accessed, access_count, created, status, decay_tier)
- Create indexes: `(tenant_id)`, `(tenant_id, category)`, `(tenant_id, status)`
- If sqlite-vec is available, create `vec_items` virtual table for embeddings
- Methods: `upsertMeta`, `getMeta`, `deleteMeta`, `listMeta`, `recordAccess`
- Embedding methods (graceful degradation if sqlite-vec unavailable): `upsertEmbedding`, `searchSimilar`
- All operations scoped by `tenant_id`

Write `src/migrations/memoryfs.ts`:
- Migration `memoryfs_001_initial`: create `item_meta` table and indexes
- Follow existing Kysely migration pattern from `src/migrations/memory.ts`

**Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/providers/memory/memoryfs/embeddings-db.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/providers/memory/memoryfs/embeddings-db.ts src/migrations/memoryfs.ts tests/providers/memory/memoryfs/embeddings-db.test.ts
git commit -m "feat(memoryfs): add SQLite embeddings DB with metadata and vector search"
```

---

### Task 4: Reconciler (File ↔ DB Consistency)

**Files:**
- Create: `src/providers/memory/memoryfs/reconciler.ts`
- Test: `tests/providers/memory/memoryfs/reconciler.test.ts`

**Context:** The reconciler runs at startup and periodically to ensure file↔DB consistency. Three cases: file exists but DB missing → rebuild metadata; DB exists but file missing → tombstone DB row; hash mismatch → recompute from canonical file.

**Step 1: Write the failing tests**

Test cases:
- File exists, DB missing → reconciler inserts metadata row from file frontmatter
- DB exists, file missing → reconciler marks DB row as tombstoned (status: 'archived')
- Content hash mismatch → reconciler recomputes metadata from file
- Reconciler is idempotent (running twice produces same result)
- Reconciler reports stats (items_added, items_tombstoned, items_refreshed)

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/providers/memory/memoryfs/reconciler.test.ts`
Expected: FAIL

**Step 3: Implement reconciler**

```typescript
// src/providers/memory/memoryfs/reconciler.ts
export interface ReconcileResult {
  itemsAdded: number;
  itemsTombstoned: number;
  itemsRefreshed: number;
  errors: Array<{ itemId: string; error: string }>;
}

export async function reconcile(
  memoryDir: string,
  tenantId: string,
  db: EmbeddingsDB,
): Promise<ReconcileResult>
```

- Scan `{memoryDir}/{tenantId}/items/*.md` for all files
- Compare against `db.listMeta(tenantId)`
- Handle the three drift cases
- Log errors but don't throw (partial reconciliation is better than none)

**Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/providers/memory/memoryfs/reconciler.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/providers/memory/memoryfs/reconciler.ts tests/providers/memory/memoryfs/reconciler.test.ts
git commit -m "feat(memoryfs): add startup/periodic reconciler for file-DB consistency"
```

---

### Task 5: Fact Fingerprinting & Deduplication

**Files:**
- Create: `src/providers/memory/memoryfs/fingerprint.ts`
- Test: `tests/providers/memory/memoryfs/fingerprint.test.ts`

**Context:** Generate deterministic fingerprints for memory content to enable idempotent writes and deduplication. Stage A: content hash. Stage B: embedding similarity (deferred to retriever). Stage C: LLM tie-break (deferred to extractor).

**Step 1: Write the failing tests**

Test cases:
- Same content produces same fingerprint
- Whitespace normalization (leading/trailing trimmed, multiple spaces collapsed)
- Case normalization (lowercase before hashing)
- `isDuplicate()` returns true for exact match in DB
- Different content produces different fingerprint

**Step 2: Implement fingerprint.ts**

- Normalize content: trim, collapse whitespace, lowercase
- SHA-256 hash of normalized content
- Prefix with `sha256:` for future extensibility
- `isDuplicate(db, tenantId, fingerprint)` → check `content_hash` column

**Step 3: Commit**

```bash
git add src/providers/memory/memoryfs/fingerprint.ts tests/providers/memory/memoryfs/fingerprint.test.ts
git commit -m "feat(memoryfs): add content fingerprinting for idempotent deduplication"
```

---

## Phase 1b: Core Memory Path

### Task 6: Extractor Module

**Files:**
- Create: `src/providers/memory/memoryfs/extractor.ts`
- Test: `tests/providers/memory/memoryfs/extractor.test.ts`

**Context:** After each conversation, extract discrete facts using an LLM call. Each fact becomes a `MemoryFSItem`. The extractor deduplicates against existing items using fingerprints, handles contradictions (supersede old items), and performs two-phase writes.

**Step 1: Write the failing tests**

Test with a mock LLM provider that returns structured JSON:
- Extracts facts from a sample conversation → creates item files
- Deduplicates: same fact in new conversation → updates `lastAccessed`, does not create new file
- Contradiction: new fact supersedes old → old item gets `status: superseded`, new item has `supersedes` field
- Respects `maxItemsPerExtraction` cap
- Writes embeddings to DB alongside item files

**Step 2: Implement extractor.ts**

```typescript
export interface ExtractorConfig {
  memoryDir: string;
  db: EmbeddingsDB;
  llmProvider: LLMProvider;
  extractionModel?: string;
  embeddingModel?: string;
  maxItemsPerExtraction?: number; // Default: 10
}

export interface ExtractionInput {
  tenantId: string;
  conversationId: string;
  messages: ConversationTurn[];
  existingContext?: string[];
}

export async function extract(
  config: ExtractorConfig,
  input: ExtractionInput,
): Promise<MemoryFSItem[]>
```

- Build extraction prompt with existing memory summaries for dedup
- Parse LLM JSON response into `MemoryFSItem[]`
- For each item: compute fingerprint → check duplicate → two-phase write → upsert DB
- On contradiction: archive old item (set `status: superseded`, `supersededBy`), write new item with `supersedes`

**Step 3: Commit**

```bash
git add src/providers/memory/memoryfs/extractor.ts tests/providers/memory/memoryfs/extractor.test.ts
git commit -m "feat(memoryfs): add LLM-powered fact extractor with deduplication"
```

---

### Task 7: Retriever Module (Fast Mode)

**Files:**
- Create: `src/providers/memory/memoryfs/retriever.ts`
- Test: `tests/providers/memory/memoryfs/retriever.test.ts`

**Context:** Given a query, find the most relevant memory items. Fast mode uses embedding similarity (sqlite-vec ANN search). Falls back to keyword/tag search if sqlite-vec is unavailable.

**Step 1: Write the failing tests**

Test cases:
- Fast mode: embed query → ANN search → returns scored items
- Tag filter: only return items matching specified tags
- Decay tier filter: fast mode excludes `cold` items by default
- Access tracking: retrieved items get `accessCount` bumped
- Keyword fallback: if no embeddings available, search content text
- Token budget: results trimmed to `maxContextTokens`

**Step 2: Implement retriever.ts**

```typescript
export interface RetrieverConfig {
  memoryDir: string;
  db: EmbeddingsDB;
  llmProvider: LLMProvider;
  defaultTopK?: number;          // Default: 10
  rerankThreshold?: number;      // Default: 0.6
  maxContextTokens?: number;     // Default: 2000
}

export interface RetrievalQuery {
  tenantId: string;
  query: string;
  tags?: string[];
  maxResults?: number;
  mode?: 'fast' | 'deep' | 'auto';
  excludeTiers?: DecayTier[];    // Default: ['cold']
}

export interface RetrievalResult {
  items: ScoredItem[];
  mode: 'fast' | 'deep';
  contextTokens: number;
}

export interface ScoredItem extends MemoryFSItem {
  score: number;
  matchReason: string;
}

export async function retrieve(
  config: RetrieverConfig,
  query: RetrievalQuery,
): Promise<RetrievalResult>
```

- Embed query → sqlite-vec ANN search scoped to tenant
- Filter by tags, decay tier, status (active only)
- Blend scores: `final = α*vector + β*priority + γ*recency + δ*access`
- Apply MMR for diversity (avoid near-duplicates in results)
- Trim to token budget
- Bump `accessCount` and `lastAccessed` for returned items

**Step 3: Commit**

```bash
git add src/providers/memory/memoryfs/retriever.ts tests/providers/memory/memoryfs/retriever.test.ts
git commit -m "feat(memoryfs): add fast-mode retriever with embedding search and score blending"
```

---

### Task 8: MemoryFS Provider (Wire into AX's MemoryProvider Interface)

**Files:**
- Create: `src/providers/memory/memoryfs/provider.ts`
- Modify: `src/host/provider-map.ts` — add `memoryfs` entry
- Modify: `src/providers/memory/types.ts` — extend if needed
- Test: `tests/providers/memory/memoryfs/provider.test.ts`

**Context:** The provider is the public entry point. It implements `MemoryProvider` (write, query, read, delete, list, memorize) by delegating to the Extractor, Retriever, and item-io modules. Registered in the provider map as `memoryfs`.

**Step 1: Write the failing tests**

Test the full provider through `MemoryProvider` interface:
- `write()` → creates item file + DB metadata
- `query()` → delegates to retriever
- `read()` → reads item by ID
- `delete()` → removes file + DB metadata
- `list()` → lists items for scope (scope maps to tenant)
- `memorize()` → delegates to extractor
- Provider registered and loadable via provider map

**Step 2: Implement provider.ts**

```typescript
// src/providers/memory/memoryfs/provider.ts
import type { MemoryProvider, MemoryEntry, MemoryQuery } from '../types.js';
import type { Config } from '../../../types.js';

export async function create(config: Config): Promise<MemoryProvider> {
  // Initialize memoryDir from config paths
  // Initialize EmbeddingsDB
  // Run reconciler on startup
  // Return MemoryProvider implementation
}
```

- Map AX's `MemoryEntry` ↔ `MemoryFSItem` (scope → tenantId, etc.)
- `write()`: generate ID, compute fingerprint, two-phase write file + DB
- `query()`: delegate to `retrieve()` with fast mode
- `memorize()`: delegate to `extract()`
- On startup: run `reconcile()` for all known tenants

**Step 3: Register in provider-map.ts**

Add to the memory section of `PROVIDER_MAP`:
```typescript
memoryfs: '../providers/memory/memoryfs/provider.js',
```

**Step 4: Commit**

```bash
git add src/providers/memory/memoryfs/provider.ts src/host/provider-map.ts tests/providers/memory/memoryfs/provider.test.ts
git commit -m "feat(memoryfs): wire provider into AX's MemoryProvider contract and provider map"
```

---

## Phase 1c: Git Integration

### Task 9: Git History Worker

**Files:**
- Create: `src/providers/memory/memoryfs/git-worker.ts`
- Test: `tests/providers/memory/memoryfs/git-worker.test.ts`

**Context:** Background batch process that commits memory file mutations to git. Not on the hot path — batches commits on a timer or after N mutations. Structured commit messages with trailers for queryability.

**Step 1: Write the failing tests**

Test cases:
- Commits staged files with structured message format
- Includes trailers: `Tenant:`, `Memory-Id:`, `Op:`
- Batches multiple mutations into one commit
- No-ops when nothing has changed
- Works when git is not initialized (graceful no-op)

**Step 2: Implement git-worker.ts**

```typescript
export interface GitWorkerConfig {
  memoryDir: string;
  batchIntervalMs?: number;   // Default: 30_000 (30 seconds)
  maxBatchSize?: number;      // Default: 50
}

export class GitHistoryWorker {
  constructor(config: GitWorkerConfig);
  recordMutation(op: 'upsert' | 'supersede' | 'archive', tenantId: string, itemId: string): void;
  flush(): Promise<void>;     // Force commit pending mutations
  start(): void;              // Start batch timer
  stop(): Promise<void>;      // Flush and stop
}
```

- Queue mutations in memory
- On flush: `git add` changed files, `git commit` with structured message
- Use `child_process.execFile` for git commands (no shell injection)
- Gracefully handle: no git repo, git not installed, nothing to commit

**Step 3: Commit**

```bash
git add src/providers/memory/memoryfs/git-worker.ts tests/providers/memory/memoryfs/git-worker.test.ts
git commit -m "feat(memoryfs): add batched git history worker for memory audit trail"
```

---

## Phase 2: Organization & Lifecycle

### Task 10: Categorizer Module

**Files:**
- Create: `src/providers/memory/memoryfs/categorizer.ts`
- Test: `tests/providers/memory/memoryfs/categorizer.test.ts`

**Context:** Organize items into thematic categories. Categories are directories with `_index.md` summaries and `manifest.jsonl` for membership (append-friendly, avoids large rewrites). LLM assigns items to categories or proposes new ones.

**Step 1: Write the failing tests**

Test cases:
- Assigns item to existing category when confidence > 0.7
- Creates new category when no existing one fits
- Category `_index.md` contains LLM-generated summary
- `manifest.jsonl` is append-only (new assignments don't rewrite existing lines)
- Item reassignment updates both old and new manifests
- `listCategories()` returns all categories with item counts
- `reindex()` regenerates all `_index.md` summaries

**Step 2: Implement categorizer.ts**

```typescript
export interface CategorizerConfig {
  memoryDir: string;
  db: EmbeddingsDB;
  llmProvider: LLMProvider;
  categorizationModel?: string;
  maxCategories?: number;            // Default: 20
  recategorizeThreshold?: number;    // Default: 50 new items
}

export interface CategoryAssignment {
  itemId: string;
  category: string;       // Slug: lowercase, hyphenated
  confidence: number;
  isNewCategory: boolean;
}

export async function categorize(
  config: CategorizerConfig,
  tenantId: string,
  itemIds: string[],
): Promise<CategoryAssignment[]>

export async function reindex(
  config: CategorizerConfig,
  tenantId: string,
): Promise<void>

export async function listCategories(
  memoryDir: string,
  tenantId: string,
): Promise<Array<{ slug: string; itemCount: number; summary: string }>>
```

**Step 3: Commit**

```bash
git add src/providers/memory/memoryfs/categorizer.ts tests/providers/memory/memoryfs/categorizer.test.ts
git commit -m "feat(memoryfs): add LLM categorizer with manifest-backed membership"
```

---

### Task 11: Decayer Module (Tiered Decay)

**Files:**
- Create: `src/providers/memory/memoryfs/decayer.ts`
- Test: `tests/providers/memory/memoryfs/decayer.test.ts`

**Context:** Periodically score and tier items. Uses three tiers (hot/warm/cold) instead of binary delete. Hot = default retrieval, warm = deep mode only, cold = archived. Scoring formula blends base priority, recency, and access frequency.

**Step 1: Write the failing tests — decay math first**

```typescript
describe('decay scoring', () => {
  it('fresh high-priority item scores near 1.0', () => {
    const score = computeDecayScore({ priority: 0.9, daysSinceAccess: 0, accessCount: 5 });
    expect(score).toBeGreaterThan(0.85);
  });

  it('score halves at halfLifeDays', () => {
    const fresh = computeDecayScore({ priority: 0.8, daysSinceAccess: 0, accessCount: 0 });
    const halfLife = computeDecayScore({ priority: 0.8, daysSinceAccess: 30, accessCount: 0 });
    expect(halfLife).toBeCloseTo(fresh * 0.5, 1);
  });

  it('frequently accessed items resist decay', () => {
    const unused = computeDecayScore({ priority: 0.5, daysSinceAccess: 60, accessCount: 0 });
    const used = computeDecayScore({ priority: 0.5, daysSinceAccess: 60, accessCount: 20 });
    expect(used).toBeGreaterThan(unused);
  });

  it('assigns correct tiers', () => {
    expect(assignTier(0.8)).toBe('hot');
    expect(assignTier(0.3)).toBe('warm');
    expect(assignTier(0.1)).toBe('cold');
  });
});
```

**Step 2: Implement decayer.ts**

```typescript
export interface DecayerConfig {
  memoryDir: string;
  db: EmbeddingsDB;
  halfLifeDays?: number;          // Default: 30
  hotThreshold?: number;          // Default: 0.4
  coldThreshold?: number;         // Default: 0.15
  maxItemsPerTenant?: number;     // Default: 5000
  dryRun?: boolean;
}

export function computeDecayScore(params: {
  priority: number;
  daysSinceAccess: number;
  accessCount: number;
  halfLifeDays?: number;
}): number

export function assignTier(score: number, hotThreshold?: number, coldThreshold?: number): DecayTier

export async function decay(
  config: DecayerConfig,
  tenantId: string,
): Promise<DecayResult>
```

Scoring formula:
```
decayScore = basePriority * recencyWeight * accessWeight
recencyWeight = 2^(-(daysSinceLastAccess / halfLifeDays))
accessWeight = min(1.0, 0.3 + (0.7 * (accessCount / 20)))
```

Tier thresholds:
- `score >= hotThreshold` → hot
- `coldThreshold <= score < hotThreshold` → warm
- `score < coldThreshold` → cold

Update `decayTier` in both file frontmatter and DB metadata. Write run metadata to `state/decay-log.md`.

**Step 3: Commit**

```bash
git add src/providers/memory/memoryfs/decayer.ts tests/providers/memory/memoryfs/decayer.test.ts
git commit -m "feat(memoryfs): add tiered decay with hot/warm/cold scoring"
```

---

## Phase 3: Deep Retrieval

### Task 12: LLM Reranker & Category-Aware Retrieval

**Files:**
- Modify: `src/providers/memory/memoryfs/retriever.ts`
- Test: `tests/providers/memory/memoryfs/retriever-deep.test.ts`

**Context:** Add deep retrieval mode: LLM reranks candidates from fast mode. Auto-escalation when fast mode scores are below threshold. Category-aware: read `_index.md` summaries first to narrow search.

**Step 1: Write the failing tests**

Test cases:
- Deep mode: sends candidates to LLM for reranking → returns reordered list with match reasons
- Auto mode: escalates from fast to deep when top score < `rerankThreshold`
- Auto mode: stays in fast mode when top score > `rerankThreshold`
- Category awareness: reads `_index.md` to narrow candidate set
- MMR diversity: results don't contain near-duplicate items
- Token budget: context packing with utility-per-token scoring

**Step 2: Implement deep mode in retriever.ts**

- Add `deep` mode branch: run fast mode for 3x candidates, then LLM rerank
- Build rerank prompt: include query, candidates, category summaries
- Parse LLM response into reordered `ScoredItem[]` with `matchReason`
- Auto mode: try fast first, check top score, escalate if needed
- MMR: iteratively select items that maximize `λ*relevance - (1-λ)*max_similarity_to_selected`
- Utility-per-token packing: estimate tokens per item, fill budget by utility/token ratio

**Step 3: Commit**

```bash
git add src/providers/memory/memoryfs/retriever.ts tests/providers/memory/memoryfs/retriever-deep.test.ts
git commit -m "feat(memoryfs): add deep rerank, MMR diversity, and category-aware retrieval"
```

---

## Phase 4: Proactive Intelligence

### Task 13: Monitor Module

**Files:**
- Create: `src/providers/memory/memoryfs/monitor.ts`
- Test: `tests/providers/memory/memoryfs/monitor.test.ts`

**Context:** Lightweight event processor that watches incoming messages for relevance to stored memories. Zero LLM calls — embedding-only. Emits signals when relevance exceeds threshold. Tracks activity patterns in `state/monitor.md`.

**Step 1: Write the failing tests**

Test cases:
- Embedding similarity above threshold → emits `relevance_match` signal
- Below threshold → returns null
- Pattern detection: recurring topic at expected time → emits `pattern_match`
- Topic shift: dramatic change from recent activity → emits `topic_shift`
- State file updated with activity log after each event
- Activity patterns tracked over configurable window (default 14 days)

**Step 2: Implement monitor.ts**

```typescript
export interface MonitorConfig {
  memoryDir: string;
  db: EmbeddingsDB;
  llmProvider: LLMProvider;          // Only for embed(), no chat()
  embeddingModel?: string;
  relevanceThreshold?: number;       // Default: 0.65
  patternWindow?: number;            // Default: 14 days
}

export interface MonitorEvent {
  tenantId: string;
  content: string;
  source: { type: string; id: string };
  timestamp: string;
}

export type SignalType = 'relevance_match' | 'pattern_match' | 'topic_shift';

export interface MonitorSignal {
  type: SignalType;
  tenantId: string;
  event: MonitorEvent;
  matchedItems: string[];
  score: number;
}

export async function processEvent(
  config: MonitorConfig,
  event: MonitorEvent,
): Promise<MonitorSignal | null>

export async function updateState(
  memoryDir: string,
  tenantId: string,
  event: MonitorEvent,
  topics: string[],
): Promise<void>
```

**Step 3: Commit**

```bash
git add src/providers/memory/memoryfs/monitor.ts tests/providers/memory/memoryfs/monitor.test.ts
git commit -m "feat(memoryfs): add embedding-only monitor with pattern detection"
```

---

### Task 14: Anticipator Module

**Files:**
- Create: `src/providers/memory/memoryfs/anticipator.ts`
- Test: `tests/providers/memory/memoryfs/anticipator.test.ts`

**Context:** When Monitor emits a signal, the Anticipator uses an LLM call to predict what the user needs next. Creates proactive trigger files with TTL. Triggers are injected into the next retrieval.

**Step 1: Write the failing tests**

Test cases:
- Creates trigger file from monitor signal with matching memories
- Trigger file has correct YAML frontmatter and content
- No trigger created when LLM confidence < 0.6
- `getActiveTriggers()` returns non-expired triggers
- `expireTriggers()` removes expired trigger files
- Trigger cap: respects `maxTriggersPerTenant` (oldest dropped first)

**Step 2: Implement anticipator.ts**

```typescript
export interface AnticipatorConfig {
  memoryDir: string;
  db: EmbeddingsDB;
  llmProvider: LLMProvider;
  anticipationModel?: string;
  maxTriggersPerTenant?: number;    // Default: 5
  triggerTTLHours?: number;         // Default: 4
}

export interface ProactiveTrigger {
  id: string;
  tenantId: string;
  created: string;
  expires: string;
  confidence: number;
  triggeredBy: string;
  prediction: string;
  surfaceItems: string[];
  suggestedAction?: string;
}

export async function anticipate(
  config: AnticipatorConfig,
  signal: MonitorSignal,
  recentMessages: ConversationTurn[],
): Promise<ProactiveTrigger | null>

export async function getActiveTriggers(
  memoryDir: string,
  tenantId: string,
): Promise<ProactiveTrigger[]>

export async function expireTriggers(
  memoryDir: string,
  tenantId: string,
): Promise<string[]>
```

**Step 3: Commit**

```bash
git add src/providers/memory/memoryfs/anticipator.ts tests/providers/memory/memoryfs/anticipator.test.ts
git commit -m "feat(memoryfs): add LLM anticipator with proactive trigger lifecycle"
```

---

## Phase 5: Orchestrator & Integration

### Task 15: Top-Level Orchestrator

**Files:**
- Create: `src/providers/memory/memoryfs/orchestrator.ts`
- Modify: `src/providers/memory/memoryfs/provider.ts`
- Test: `tests/providers/memory/memoryfs/orchestrator.test.ts`

**Context:** Ties all modules together for high-level workflows: `memorize()`, `recall()`, `observe()`, `maintain()`.

**Step 1: Write the failing tests**

Test the four orchestrator workflows:
- `memorize()`: extract → categorize → update embeddings
- `recall()`: retrieve + inject active triggers
- `observe()`: monitor → anticipate if triggered
- `maintain()`: decay all tenants → expire triggers → reindex categories

**Step 2: Implement orchestrator.ts**

```typescript
export interface MemoryFSOrchestrator {
  memorize(tenantId: string, conversation: ConversationTurn[]): Promise<MemoryFSItem[]>;
  recall(tenantId: string, query: string, opts?: Partial<RetrievalQuery>): Promise<RetrievalResult>;
  observe(event: MonitorEvent): Promise<MonitorSignal | null>;
  maintain(tenantId?: string): Promise<void>;
}

export function createOrchestrator(config: MemoryFSConfig): MemoryFSOrchestrator
```

Wire orchestrator into the provider's `memorize()` and `query()` methods.

**Step 3: Commit**

```bash
git add src/providers/memory/memoryfs/orchestrator.ts tests/providers/memory/memoryfs/orchestrator.test.ts
git commit -m "feat(memoryfs): add top-level orchestrator with memorize/recall/observe/maintain"
```

---

### Task 16: Integration Test — Full Memory Lifecycle

**Files:**
- Create: `tests/providers/memory/memoryfs/integration.test.ts`

**Context:** End-to-end test that exercises the complete pipeline: write → extract → categorize → retrieve → decay → monitor → anticipate. Uses mock LLM provider.

**Step 1: Write the integration test**

```typescript
describe('MemoryFS integration', () => {
  it('full lifecycle: write → retrieve → decay', async () => {
    // Create provider
    // Write several items via memorize()
    // Recall items by query
    // Run decay
    // Verify hot items still retrievable, cold items excluded from fast mode
  });

  it('proactive flow: monitor → anticipate → inject triggers', async () => {
    // Seed memory items
    // Process monitor event that matches stored memories
    // Verify trigger created
    // Recall → verify trigger injected in results
    // Expire trigger → verify removed
  });

  it('reconciler repairs drift', async () => {
    // Write items normally
    // Manually delete DB rows (simulate corruption)
    // Run reconciler
    // Verify DB repaired from files
  });
});
```

**Step 2: Run integration tests**

Run: `npx vitest run tests/providers/memory/memoryfs/integration.test.ts`
Expected: PASS

**Step 3: Commit**

```bash
git add tests/providers/memory/memoryfs/integration.test.ts
git commit -m "test(memoryfs): add full lifecycle integration tests"
```

---

## Dependencies to Add

```bash
npm install gray-matter sqlite-vec nanoid
npm install -D @types/better-sqlite3  # if not already present
```

Note: `better-sqlite3` and `fast-glob` are already project dependencies. `sqlite-vec` is the only truly new native dependency.

---

## File Summary

### New Files (16 source + 10 test)

| File | Purpose |
|------|---------|
| `src/providers/memory/memoryfs/types.ts` | Core types (MemoryFSItem, config, enums) |
| `src/providers/memory/memoryfs/index.ts` | Module re-exports |
| `src/providers/memory/memoryfs/item-io.ts` | Markdown file read/write with frontmatter |
| `src/providers/memory/memoryfs/embeddings-db.ts` | SQLite + sqlite-vec database layer |
| `src/providers/memory/memoryfs/reconciler.ts` | File ↔ DB consistency repair |
| `src/providers/memory/memoryfs/fingerprint.ts` | Content hashing for deduplication |
| `src/providers/memory/memoryfs/extractor.ts` | LLM fact extraction from conversations |
| `src/providers/memory/memoryfs/retriever.ts` | Semantic retrieval (fast + deep + auto) |
| `src/providers/memory/memoryfs/categorizer.ts` | LLM-powered thematic categorization |
| `src/providers/memory/memoryfs/decayer.ts` | Tiered priority decay (hot/warm/cold) |
| `src/providers/memory/memoryfs/monitor.ts` | Embedding-only relevance monitoring |
| `src/providers/memory/memoryfs/anticipator.ts` | LLM proactive trigger prediction |
| `src/providers/memory/memoryfs/orchestrator.ts` | High-level workflow coordinator |
| `src/providers/memory/memoryfs/provider.ts` | MemoryProvider implementation |
| `src/providers/memory/memoryfs/git-worker.ts` | Batched git commit worker |
| `src/migrations/memoryfs.ts` | Kysely database migrations |

### Modified Files (2)

| File | Change |
|------|--------|
| `src/host/provider-map.ts` | Add `memoryfs` to memory provider allowlist |
| `src/providers/memory/types.ts` | Extend if needed for orchestrator methods |

### Test Files (10)

Mirror structure under `tests/providers/memory/memoryfs/`:
- `types.test.ts`, `item-io.test.ts`, `embeddings-db.test.ts`, `reconciler.test.ts`
- `fingerprint.test.ts`, `extractor.test.ts`, `retriever.test.ts`, `retriever-deep.test.ts`
- `provider.test.ts`, `integration.test.ts`
- `decayer.test.ts`, `categorizer.test.ts`, `monitor.test.ts`, `anticipator.test.ts`, `orchestrator.test.ts`

---

## Security Checklist

- [ ] All file paths use `safePath()` — no raw `path.join()` with user input
- [ ] Tenant isolation: every query scoped by `tenantId`, no cross-tenant leaks
- [ ] IPC schemas: add Zod schemas for any new IPC actions
- [ ] No dynamic imports: `memoryfs` added to static `PROVIDER_MAP`
- [ ] Content from LLM extraction gets taint-tagged
- [ ] Sensitivity field enables retrieval-time filtering
- [ ] Git worker uses `execFile` not `exec` (no shell injection)
- [ ] UUID validation on item IDs before file operations

---

## Build Order Summary

```
Phase 1a: Storage Foundation
  Task 1:  Types                          ← start here
  Task 2:  Item I/O (Markdown files)
  Task 3:  Embeddings DB (SQLite)
  Task 4:  Reconciler
  Task 5:  Fingerprinting

Phase 1b: Core Memory Path
  Task 6:  Extractor (LLM)               ← depends on Tasks 1-5
  Task 7:  Retriever (fast mode)
  Task 8:  Provider (wire into AX)

Phase 1c: Git Integration
  Task 9:  Git History Worker             ← independent of Phase 1b

Phase 2: Organization & Lifecycle
  Task 10: Categorizer                    ← depends on Phase 1b
  Task 11: Decayer

Phase 3: Deep Retrieval
  Task 12: LLM Reranker                  ← depends on Tasks 7, 10

Phase 4: Proactive Intelligence
  Task 13: Monitor                        ← depends on Phase 1b
  Task 14: Anticipator                    ← depends on Task 13

Phase 5: Integration
  Task 15: Orchestrator                   ← depends on all above
  Task 16: Integration Tests
```
