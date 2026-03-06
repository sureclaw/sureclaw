# Cortex Summary Storage & Retrieval Fix

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix cortex memory provider so LLM-generated summaries are stored in the database (not local disk) and wired into the query path as designed — items first for precision, summaries as bonus context for breadth.

**Architecture:** Extract summary I/O into a `SummaryStore` interface with two implementations: `FileSummaryStore` (current `.md` file logic, used when database is SQLite or absent) and `DbSummaryStore` (new `cortex_summaries` table, used when database is PostgreSQL or other remote DB). Wire summaries into `query()` as trailing results that fill remaining `limit` slots after item-level search.

**Tech Stack:** TypeScript, Kysely (migrations + queries), vitest

---

## Source Documents

- Design conversation: identified that cortex writes summaries to local disk (broken on k8s) and never reads them during query (designed read path not implemented)
- Original design: `docs/plans/2026-03-02-memoryfs-v2-plan.md` — specifies summary-first read path
- Current implementation: `src/providers/memory/cortex/provider.ts`, `summary-io.ts`

---

## Task 1: SummaryStore Interface & FileSummaryStore

**Files:**
- Create: `src/providers/memory/cortex/summary-store.ts`
- Test: `tests/providers/memory/cortex/summary-store.test.ts`

**Context:** Define the `SummaryStore` interface and extract the existing file-based logic from `summary-io.ts` into `FileSummaryStore`. This is a pure refactor — behavior is identical to current code.

**Step 1: Write the failing test**

```typescript
// tests/providers/memory/cortex/summary-store.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileSummaryStore } from '../../../../src/providers/memory/cortex/summary-store.js';

describe('FileSummaryStore', () => {
  let memoryDir: string;
  let store: FileSummaryStore;

  beforeEach(async () => {
    memoryDir = await mkdtemp(join(tmpdir(), 'cortex-summary-'));
    store = new FileSummaryStore(memoryDir);
  });

  afterEach(async () => {
    await rm(memoryDir, { recursive: true, force: true });
  });

  it('writes and reads a summary round-trip', async () => {
    await store.write('preferences', '# preferences\n## Editor\n- Uses vim\n');
    const read = await store.read('preferences');
    expect(read).toBe('# preferences\n## Editor\n- Uses vim\n');
  });

  it('returns null for non-existent category', async () => {
    expect(await store.read('nonexistent')).toBeNull();
  });

  it('overwrites existing summary', async () => {
    await store.write('preferences', 'old');
    await store.write('preferences', 'new');
    expect(await store.read('preferences')).toBe('new');
  });

  it('lists category slugs', async () => {
    await store.write('preferences', 'content');
    await store.write('knowledge', 'content');
    const cats = await store.list();
    expect(cats.sort()).toEqual(['knowledge', 'preferences']);
  });

  it('initDefaults creates 10 default categories', async () => {
    await store.initDefaults();
    const cats = await store.list();
    expect(cats).toHaveLength(10);
    expect(cats).toContain('preferences');
    const content = await store.read('preferences');
    expect(content).toContain('# preferences');
  });

  it('user-scoped write is isolated from shared', async () => {
    await store.write('preferences', 'alice prefs', 'alice');
    await store.write('preferences', 'shared prefs');
    expect(await store.read('preferences', 'alice')).toBe('alice prefs');
    expect(await store.read('preferences')).toBe('shared prefs');
  });

  it('list with userId returns user categories', async () => {
    await store.write('preferences', 'alice prefs', 'alice');
    await store.write('knowledge', 'alice knowledge', 'alice');
    const cats = await store.list('alice');
    expect(cats.sort()).toEqual(['knowledge', 'preferences']);
  });

  it('sanitizes path traversal attempts', async () => {
    await store.write('../escape', 'safe content');
    const files = await readdir(memoryDir);
    expect(files.some(f => f.endsWith('.md'))).toBe(true);
    expect(files.every(f => !f.includes('..'))).toBe(true);
    const read = await store.read('../escape');
    expect(read).toBe('safe content');
  });

  it('writes atomically (no .tmp files left)', async () => {
    await store.write('preferences', 'content');
    const files = await readdir(memoryDir);
    expect(files.every(f => !f.endsWith('.tmp'))).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/providers/memory/cortex/summary-store.test.ts`
Expected: FAIL — module not found

**Step 3: Write the SummaryStore interface and FileSummaryStore**

```typescript
// src/providers/memory/cortex/summary-store.ts
import { readFile, writeFile, rename, readdir, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { safePath } from '../../../utils/safe-path.js';
import { DEFAULT_CATEGORIES } from './types.js';
import type { Kysely } from 'kysely';

/** Prefix for synthetic summary IDs returned from query(). */
export const SUMMARY_ID_PREFIX = 'summary:';

/**
 * Abstract interface for reading/writing category summary content.
 * Two implementations: FileSummaryStore (local dev) and DbSummaryStore (k8s/PostgreSQL).
 */
export interface SummaryStore {
  read(category: string, userId?: string): Promise<string | null>;
  write(category: string, content: string, userId?: string): Promise<void>;
  list(userId?: string): Promise<string[]>;
  readAll(userId?: string): Promise<Map<string, string>>;
  initDefaults(): Promise<void>;
}

// ── FileSummaryStore ─────────────────────────────────────────────

function summaryDir(memoryDir: string, userId?: string): string {
  if (!userId) return memoryDir;
  return safePath(safePath(memoryDir, 'users'), userId);
}

export class FileSummaryStore implements SummaryStore {
  constructor(private memoryDir: string) {}

  async read(category: string, userId?: string): Promise<string | null> {
    const filePath = safePath(summaryDir(this.memoryDir, userId), `${category}.md`);
    try {
      return await readFile(filePath, 'utf-8');
    } catch {
      return null;
    }
  }

  async write(category: string, content: string, userId?: string): Promise<void> {
    const dir = summaryDir(this.memoryDir, userId);
    const filePath = safePath(dir, `${category}.md`);
    await mkdir(dir, { recursive: true });
    const tmpPath = `${filePath}.${randomUUID()}.tmp`;
    await writeFile(tmpPath, content, 'utf-8');
    await rename(tmpPath, filePath);
  }

  async list(userId?: string): Promise<string[]> {
    const dir = summaryDir(this.memoryDir, userId);
    try {
      const files = await readdir(dir);
      return files
        .filter(f => f.endsWith('.md') && !f.startsWith('_'))
        .map(f => f.replace(/\.md$/, ''));
    } catch {
      return [];
    }
  }

  async readAll(userId?: string): Promise<Map<string, string>> {
    const categories = await this.list(userId);
    const result = new Map<string, string>();
    for (const cat of categories) {
      const content = await this.read(cat, userId);
      if (content) result.set(cat, content);
    }
    return result;
  }

  async initDefaults(): Promise<void> {
    await mkdir(this.memoryDir, { recursive: true });
    for (const cat of DEFAULT_CATEGORIES) {
      try {
        await writeFile(
          safePath(this.memoryDir, `${cat}.md`),
          `# ${cat}\n`,
          { flag: 'wx' }, // exclusive create — no-op if exists
        );
      } catch (err: any) {
        if (err?.code !== 'EEXIST') throw err;
      }
    }
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/providers/memory/cortex/summary-store.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/providers/memory/cortex/summary-store.ts tests/providers/memory/cortex/summary-store.test.ts
git commit -m "feat(memory): add SummaryStore interface and FileSummaryStore"
```

---

## Task 2: DbSummaryStore

**Files:**
- Modify: `src/providers/memory/cortex/summary-store.ts`
- Modify: `src/providers/memory/cortex/migrations.ts`
- Test: `tests/providers/memory/cortex/summary-store.test.ts` (add DbSummaryStore tests)

**Context:** Add `DbSummaryStore` that stores summaries in a `cortex_summaries` table, and add the migration. Uses the same `SummaryStore` interface so callers don't change. Uses `NOT NULL DEFAULT '__shared__'` for `user_id` to avoid NULL-in-unique-index issues across SQLite and PostgreSQL, and `ON CONFLICT DO UPDATE` for race-free upserts (matching `job-store.ts` / `file-store.ts` patterns).

**Step 1: Write the failing test**

Add to `tests/providers/memory/cortex/summary-store.test.ts`:

```typescript
import { DbSummaryStore } from '../../../../src/providers/memory/cortex/summary-store.js';
import { createKyselyDb } from '../../../../src/utils/database.js';
import { runMigrations } from '../../../../src/utils/migrator.js';
import { memoryMigrations } from '../../../../src/providers/memory/cortex/migrations.js';

describe('DbSummaryStore', () => {
  let db: ReturnType<typeof createKyselyDb>;
  let store: DbSummaryStore;

  beforeEach(async () => {
    db = createKyselyDb({ type: 'sqlite', path: ':memory:' });
    const result = await runMigrations(db, memoryMigrations('sqlite'), 'cortex_migration');
    if (result.error) throw result.error;
    store = new DbSummaryStore(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('writes and reads a summary round-trip', async () => {
    await store.write('preferences', '# preferences\n## Editor\n- Uses vim\n');
    const read = await store.read('preferences');
    expect(read).toBe('# preferences\n## Editor\n- Uses vim\n');
  });

  it('returns null for non-existent category', async () => {
    expect(await store.read('nonexistent')).toBeNull();
  });

  it('overwrites existing summary (upsert)', async () => {
    await store.write('preferences', 'old');
    await store.write('preferences', 'new');
    expect(await store.read('preferences')).toBe('new');
  });

  it('lists category slugs', async () => {
    await store.write('preferences', 'content');
    await store.write('knowledge', 'content');
    const cats = await store.list();
    expect(cats.sort()).toEqual(['knowledge', 'preferences']);
  });

  it('initDefaults creates 10 default categories in one batch', async () => {
    await store.initDefaults();
    const cats = await store.list();
    expect(cats).toHaveLength(10);
    expect(cats).toContain('preferences');
    const content = await store.read('preferences');
    expect(content).toContain('# preferences');
  });

  it('initDefaults is idempotent (does not overwrite existing)', async () => {
    await store.write('preferences', 'custom content');
    await store.initDefaults();
    expect(await store.read('preferences')).toBe('custom content');
  });

  it('user-scoped write is isolated from shared', async () => {
    await store.write('preferences', 'alice prefs', 'alice');
    await store.write('preferences', 'shared prefs');
    expect(await store.read('preferences', 'alice')).toBe('alice prefs');
    expect(await store.read('preferences')).toBe('shared prefs');
  });

  it('list with userId returns user categories only', async () => {
    await store.write('preferences', 'alice prefs', 'alice');
    await store.write('knowledge', 'alice knowledge', 'alice');
    await store.write('habits', 'shared habits');
    const cats = await store.list('alice');
    expect(cats.sort()).toEqual(['knowledge', 'preferences']);
  });

  it('readAll returns all summaries for scope in one call', async () => {
    await store.write('preferences', 'prefs content');
    await store.write('knowledge', 'knowledge content');
    const all = await store.readAll();
    expect(all.size).toBe(2);
    expect(all.get('preferences')).toBe('prefs content');
    expect(all.get('knowledge')).toBe('knowledge content');
  });

  it('readAll with userId returns user + nothing from shared', async () => {
    await store.write('preferences', 'alice prefs', 'alice');
    await store.write('knowledge', 'shared knowledge');
    const all = await store.readAll('alice');
    expect(all.size).toBe(1);
    expect(all.get('preferences')).toBe('alice prefs');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/providers/memory/cortex/summary-store.test.ts`
Expected: FAIL — `DbSummaryStore` not exported

**Step 3: Add the migration**

In `src/providers/memory/cortex/migrations.ts`, add after `memory_001_items`:

```typescript
memory_002_summaries: {
  async up(db: Kysely<any>) {
    await db.schema
      .createTable('cortex_summaries')
      .ifNotExists()
      .addColumn('category', 'text', col => col.notNull())
      .addColumn('user_id', 'text', col => col.notNull().defaultTo('__shared__'))
      .addColumn('content', 'text', col => col.notNull())
      .addColumn('updated_at', 'text', col => col.notNull())
      .execute();

    await db.schema.createIndex('idx_summaries_pk').ifNotExists()
      .on('cortex_summaries').columns(['category', 'user_id']).unique().execute();
  },
  async down(db: Kysely<any>) {
    await db.schema.dropTable('cortex_summaries').ifExists().execute();
  },
},
```

**Step 4: Write DbSummaryStore**

Add to `src/providers/memory/cortex/summary-store.ts`:

```typescript
// ── DbSummaryStore ───────────────────────────────────────────────

/** Sentinel value for shared (non-user-scoped) summaries. NOT NULL so
 *  the composite unique index (category, user_id) works with ON CONFLICT. */
const SHARED_USER_ID = '__shared__';

export class DbSummaryStore implements SummaryStore {
  constructor(private db: Kysely<any>) {}

  private userIdToDb(userId?: string): string {
    return userId ?? SHARED_USER_ID;
  }

  async read(category: string, userId?: string): Promise<string | null> {
    const row = await this.db.selectFrom('cortex_summaries')
      .select('content')
      .where('category', '=', category)
      .where('user_id', '=', this.userIdToDb(userId))
      .executeTakeFirst();
    return row?.content ?? null;
  }

  async write(category: string, content: string, userId?: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db.insertInto('cortex_summaries')
      .values({
        category,
        user_id: this.userIdToDb(userId),
        content,
        updated_at: now,
      })
      .onConflict(oc => oc
        .columns(['category', 'user_id'])
        .doUpdateSet({ content, updated_at: now }),
      )
      .execute();
  }

  async list(userId?: string): Promise<string[]> {
    const rows = await this.db.selectFrom('cortex_summaries')
      .select('category')
      .where('user_id', '=', this.userIdToDb(userId))
      .execute();
    return rows.map(r => r.category);
  }

  async readAll(userId?: string): Promise<Map<string, string>> {
    const rows = await this.db.selectFrom('cortex_summaries')
      .select(['category', 'content'])
      .where('user_id', '=', this.userIdToDb(userId))
      .execute();
    return new Map(rows.map(r => [r.category, r.content]));
  }

  async initDefaults(): Promise<void> {
    const now = new Date().toISOString();
    for (const cat of DEFAULT_CATEGORIES) {
      await this.db.insertInto('cortex_summaries')
        .values({
          category: cat,
          user_id: SHARED_USER_ID,
          content: `# ${cat}\n`,
          updated_at: now,
        })
        .onConflict(oc => oc
          .columns(['category', 'user_id'])
          .doNothing(),
        )
        .execute();
    }
  }
}
```

**Step 5: Run test to verify it passes**

Run: `npx vitest run tests/providers/memory/cortex/summary-store.test.ts`
Expected: PASS (all FileSummaryStore + DbSummaryStore tests)

**Step 6: Commit**

```bash
git add src/providers/memory/cortex/summary-store.ts src/providers/memory/cortex/migrations.ts tests/providers/memory/cortex/summary-store.test.ts
git commit -m "feat(memory): add DbSummaryStore with cortex_summaries migration"
```

---

## Task 3: Wire SummaryStore into Provider

**Files:**
- Modify: `src/providers/memory/cortex/provider.ts`
- Modify: `tests/providers/memory/cortex/provider.test.ts`

**Context:** Replace direct `summary-io.ts` imports with `SummaryStore`. Choose `DbSummaryStore` when `database.type !== 'sqlite'`, otherwise `FileSummaryStore`. The `updateCategorySummary` helper and `initDefaultCategories` call switch to the store instance.

**Step 1: Write the failing test**

Add to `tests/providers/memory/cortex/provider.test.ts` — a new describe block:

```typescript
describe('cortex provider with database (DbSummaryStore path)', () => {
  let memory: MemoryProvider;
  let testHome: string;
  let llm: LLMProvider;

  beforeEach(async () => {
    testHome = await mkdtemp(join(tmpdir(), `memfs-db-${randomUUID()}-`));
    process.env.AX_HOME = testHome;
  });

  afterEach(async () => {
    try { await rm(testHome, { recursive: true, force: true }); } catch {}
    delete process.env.AX_HOME;
  });

  it('uses DbSummaryStore when database type is not sqlite', async () => {
    const { createKyselyDb } = await import('../../../../src/utils/database.js');
    const { runMigrations } = await import('../../../../src/utils/migrator.js');
    const { memoryMigrations } = await import('../../../../src/providers/memory/cortex/migrations.js');

    const db = createKyselyDb({ type: 'sqlite', path: ':memory:' });
    const database = { db, type: 'postgresql' as const, vectorsAvailable: false, close: () => db.destroy() };

    await runMigrations(db, memoryMigrations('postgresql'), 'cortex_migration');

    const extractionResponse = JSON.stringify([
      { content: 'Prefers dark mode', memoryType: 'profile', category: 'preferences' },
    ]);
    const summaryResponse = '# preferences\n## UI\n- Prefers dark mode';
    llm = mockLLM([extractionResponse, summaryResponse]);

    memory = await create(config, undefined, { llm, database });

    await memory.memorize!([
      { role: 'user', content: 'I prefer dark mode' },
    ]);

    // The item should be in the store and queryable
    const results = await memory.query({ scope: 'default', query: 'dark mode' });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].content).toBe('Prefers dark mode');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/providers/memory/cortex/provider.test.ts`
Expected: FAIL — provider still uses file-based summary-io

**Step 3: Modify provider.ts**

Key changes to `src/providers/memory/cortex/provider.ts`:

1. Replace `summary-io.ts` imports with `SummaryStore` imports:

```typescript
// Remove:
import { writeSummary, readSummary, initDefaultCategories } from './summary-io.js';

// Add:
import { FileSummaryStore, DbSummaryStore, SUMMARY_ID_PREFIX, type SummaryStore } from './summary-store.js';
```

2. In `create()`, choose the store implementation:

```typescript
// Replace: await initDefaultCategories(memoryDir);
// With:
const summaryStore: SummaryStore = database && database.type !== 'sqlite'
  ? new DbSummaryStore(database.db)
  : new FileSummaryStore(memoryDir);
await summaryStore.initDefaults();
```

3. Update `updateCategorySummary` to accept `SummaryStore` instead of `memoryDir`:

```typescript
async function updateCategorySummary(
  llm: LLMProvider,
  summaryStore: SummaryStore,
  category: string,
  newItems: string[],
  userId?: string,
): Promise<void> {
  const existing = await summaryStore.read(category, userId) || `# ${category}\n`;
  const prompt = buildSummaryPrompt({
    category,
    originalContent: existing,
    newItems,
    targetLength: 400,
  });
  const raw = await llmComplete(llm, prompt);
  const updated = stripCodeFences(raw);
  await summaryStore.write(category, updated, userId);
}
```

4. Update call sites in `write()` and `memorize()` to pass `summaryStore` instead of `memoryDir`.

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/providers/memory/cortex/provider.test.ts`
Expected: PASS (all existing + new test)

**Step 5: Commit**

```bash
git add src/providers/memory/cortex/provider.ts tests/providers/memory/cortex/provider.test.ts
git commit -m "feat(memory): wire SummaryStore into cortex provider, use DB for non-sqlite"
```

---

## Task 4: Wire Summaries into query()

**Files:**
- Modify: `src/providers/memory/cortex/provider.ts`
- Modify: `tests/providers/memory/cortex/provider.test.ts`

**Context:** After item-level search, fill remaining `limit` slots with matching summaries. Summaries are appended only when the query does NOT use embeddings (embedding search is for precise item lookup). User-scoped queries get user summaries + shared summaries. Use `readAll()` for single-query retrieval instead of N+1 list-then-read. Use separate arrays for items vs summaries to avoid type casts. Guard `read()` and `delete()` against summary IDs.

**Step 1: Write the failing tests**

Add to the main `describe('cortex provider')` block in `tests/providers/memory/cortex/provider.test.ts`:

```typescript
import { SUMMARY_ID_PREFIX } from '../../../../src/providers/memory/cortex/summary-store.js';

it('query() appends summaries after items when slots remain', async () => {
  const llm = mockLLM(['# knowledge\n## Facts\n- REST API']);
  const mem = await create(config, undefined, { llm });

  await mem.write({ scope: 'default', content: 'Uses REST API' });
  await new Promise(r => setTimeout(r, 50));

  const results = await mem.query({ scope: 'default', query: 'REST', limit: 10 });
  expect(results.length).toBeGreaterThan(1);
  expect(results[0].content).toBe('Uses REST API');

  const summaryResult = results.find(r => r.id?.startsWith(SUMMARY_ID_PREFIX));
  expect(summaryResult).toBeDefined();
  expect(summaryResult!.content).toContain('REST');
});

it('query() does not append summaries when limit is filled by items', async () => {
  const mem = await create(config);

  for (let i = 0; i < 5; i++) {
    await mem.write({ scope: 'default', content: `Fact ${i} about TypeScript` });
  }

  const results = await mem.query({ scope: 'default', query: 'TypeScript', limit: 5 });
  expect(results).toHaveLength(5);
  expect(results.every(r => !r.id?.startsWith(SUMMARY_ID_PREFIX))).toBe(true);
});

it('query() does not append summaries for embedding queries', async () => {
  const mem = await create(config);
  await mem.write({ scope: 'default', content: 'Some fact' });

  const fakeEmbedding = new Float32Array([0.1, 0.2, 0.3]);
  const results = await mem.query({
    scope: 'default',
    embedding: fakeEmbedding,
    limit: 10,
  });
  expect(results.every(r => !r.id?.startsWith(SUMMARY_ID_PREFIX))).toBe(true);
});

it('read() returns null for summary IDs', async () => {
  const mem = await create(config);
  const entry = await mem.read(`${SUMMARY_ID_PREFIX}preferences`);
  expect(entry).toBeNull();
});

it('delete() is a no-op for summary IDs', async () => {
  const mem = await create(config);
  // Should not throw
  await mem.delete(`${SUMMARY_ID_PREFIX}preferences`);
});
```

**Step 2: Run test to verify they fail**

Run: `npx vitest run tests/providers/memory/cortex/provider.test.ts`
Expected: FAIL — query() doesn't return summaries yet

**Step 3: Add summary retrieval to query() and guards to read()/delete()**

In `provider.ts`, add guards to `read()` and `delete()`:

```typescript
async read(id: string): Promise<MemoryEntry | null> {
  if (id.startsWith(SUMMARY_ID_PREFIX)) return null;
  const item = await store.getById(id);
  if (!item) return null;
  return toEntry(item);
},

async delete(id: string): Promise<void> {
  if (id.startsWith(SUMMARY_ID_PREFIX)) return;
  await store.deleteById(id);
  await embeddingStore.delete(id).catch(() => {});
},
```

At the end of `query()`, after both item search paths build the `ranked` array, add summary filling using separate arrays:

```typescript
// ── Append summaries to fill remaining limit slots ──
// Skip for embedding queries (precision search — summaries too broad).
const itemResults = ranked.slice(0, limit).map(({ item }) => toEntry(item));

if (q.embedding) return itemResults;

const remaining = limit - itemResults.length;
if (remaining <= 0) return itemResults;

const summaryEntries: MemoryEntry[] = [];
const seen = new Set<string>();

// Collect matching summaries: user-scoped first (if userId), then shared
const scopes: Array<string | undefined> = q.userId ? [q.userId, undefined] : [undefined];

for (const scopeUserId of scopes) {
  if (summaryEntries.length >= remaining) break;
  const allSummaries = await summaryStore.readAll(scopeUserId);

  for (const [cat, content] of allSummaries) {
    if (summaryEntries.length >= remaining) break;
    const key = `${cat}:${scopeUserId ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (content.trim() === `# ${cat}`) continue; // skip empty defaults

    // For keyword queries, only include summaries that match
    if (q.query && !content.toLowerCase().includes(q.query.toLowerCase())) continue;

    summaryEntries.push({
      id: `${SUMMARY_ID_PREFIX}${cat}`,
      scope: q.scope || 'default',
      content,
      createdAt: new Date(),
      userId: scopeUserId,
    });
  }
}

return [...itemResults, ...summaryEntries];
```

**Step 4: Run test to verify they pass**

Run: `npx vitest run tests/providers/memory/cortex/provider.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/providers/memory/cortex/provider.ts tests/providers/memory/cortex/provider.test.ts
git commit -m "feat(memory): wire summaries into query() as trailing results"
```

---

## Task 5: Update Existing Tests & Remove Dead Code

**Files:**
- Delete: `src/providers/memory/cortex/summary-io.ts`
- Delete: `tests/providers/memory/cortex/summary-io.test.ts`

**Context:** The old `summary-io.ts` exports are no longer used by `provider.ts`. The `FileSummaryStore` tests in Task 1 and the `DbSummaryStore` tests in Task 2 cover all the same behavior plus path-traversal and atomicity tests.

**Step 1: Check for external imports of summary-io**

Run: `grep -r "summary-io" src/ --include="*.ts" -l`

If only `provider.ts` imported it (and now uses `summary-store.ts`), the old module is dead code.

**Step 2: Delete summary-io.ts and its test**

Delete `src/providers/memory/cortex/summary-io.ts` and `tests/providers/memory/cortex/summary-io.test.ts`.

**Step 3: Run full test suite**

Run: `npx vitest run tests/providers/memory/cortex/`
Expected: PASS (all cortex tests)

**Step 4: Commit**

```bash
git add -A src/providers/memory/cortex/ tests/providers/memory/cortex/
git commit -m "refactor(memory): remove dead summary-io module, tests covered by summary-store"
```

---

## Task 6: Update Provider Test for Summary File Assertions

**Files:**
- Modify: `tests/providers/memory/cortex/provider.test.ts`

**Context:** Two existing tests (`write() triggers LLM summary update` and `memorize() updates summary via LLM when available`) assert that summary content was written to disk by reading `.md` files directly. These should be updated to verify summary content via `query()` instead, since the storage backend is now abstracted.

**Step 1: Update the tests**

Replace file-read assertions:

```typescript
// OLD:
const memoryDir = dataFile('memory');
const summary = await readFile(join(memoryDir, 'knowledge.md'), 'utf-8');
expect(summary).toContain('REST');

// NEW:
// Verify summary is accessible through query (storage-agnostic)
const results = await memory.query({ scope: 'default', query: 'REST', limit: 20 });
const summaryResult = results.find(r => r.id?.startsWith(SUMMARY_ID_PREFIX));
expect(summaryResult).toBeDefined();
expect(summaryResult!.content).toContain('REST');
```

Apply the same pattern to the `memorize() updates summary` test.

Remove the `readFile` import if no longer used in the test file.

**Step 2: Run tests**

Run: `npx vitest run tests/providers/memory/cortex/provider.test.ts`
Expected: PASS

**Step 3: Commit**

```bash
git add tests/providers/memory/cortex/provider.test.ts
git commit -m "test(memory): make summary assertions storage-agnostic"
```

---

## Task 7: Run Full Suite & Final Verification

**Step 1: Run all cortex tests**

Run: `npx vitest run tests/providers/memory/cortex/`
Expected: PASS

**Step 2: Run full project tests**

Run: `npm test`
Expected: PASS

**Step 3: Build**

Run: `npm run build`
Expected: No errors

**Step 4: Final commit (if any fixups needed)**

```bash
git add -A
git commit -m "fix(memory): fixups from full suite run"
```
