# Providers: Memory

## [2026-04-04 20:15] — Fix pgvector dimension mismatch on config change

**Task:** PostgreSQL error "expected 1536 dimensions, not 1024" when embedding config changes after table creation
**What I did:** Added dimension mismatch detection to `initPostgresql()` in embedding-store.ts. Queries `pg_attribute.atttypmod` to get current vector column dimension, and if it differs from config, drops and re-adds the column.
**Files touched:** `src/providers/memory/cortex/embedding-store.ts`
**Outcome:** Success — TypeScript compiles, all 16 embedding-store tests pass. Backfill will regenerate cleared embeddings.
**Notes:** `CREATE TABLE IF NOT EXISTS` is a no-op on existing tables, so vector column dimensions were never updated when config changed. Embeddings are derivable data so dropping the column is safe.

## [2026-03-15 14:21] — Parallel LIKE + embedding search for memory queries

**Task:** When querying memory with a string (no pre-computed embedding), run both LIKE keyword search and embedding semantic search in parallel, merge and deduplicate results
**What I did:** Modified `query()` in cortex provider to run `store.searchContent()` and `embeddingClient.embed()` → `embeddingStore.findSimilar()` → `store.getByIds()` via `Promise.all`. Embedding results are merged first (with distance-based similarity), LIKE-only results follow (similarity=1.0). Deduplication by item ID. Added 4 tests covering merge, dedup, unavailable-client fallback, and embed-error graceful degradation. Used `vi.hoisted` + `vi.mock` for embedding client/store mocks.
**Files touched:** `src/providers/memory/cortex/provider.ts`, `tests/providers/memory/cortex/provider.test.ts`
**Outcome:** Success — 178 memory tests pass, 2400/2401 full suite (1 pre-existing macOS symlink test failure)
**Notes:** EmbeddingStore mock required a regular function (not arrow) to work as a constructor with `new`. `vi.fn().mockImplementation(() => inst)` doesn't work as constructor in vitest v4 — use `function EmbeddingStore() { return inst; }` instead.

## [2026-03-15 13:30] — Fix multi-term memory query bug

**Task:** Fix bug where querying multiple memory values (e.g. "foo and bar") returned no results even though individual queries worked
**What I did:** (1) Fixed `searchContent()` in `items-store.ts` to split space-separated queries into individual LIKE conditions (previously only split on literal ` OR `). (2) Fixed summary filtering in `provider.ts` to check individual terms against summary content instead of the full query string. (3) Added test for space-separated multi-term queries.
**Files touched:** `src/providers/memory/cortex/items-store.ts`, `src/providers/memory/cortex/provider.ts`, `tests/providers/memory/cortex/items-store.test.ts`
**Outcome:** Success — all 174 memory tests pass (13 files)
**Notes:** Root cause: two query paths exist — auto-recall (via `extractQueryTerms()` which joins with ` OR `) and direct agent tool calls (raw query string). The direct path sent space-separated terms which `searchContent()` treated as a single LIKE pattern, matching nothing.

## [2026-03-06 13:55] — Fix acceptance test issues: read/query reinforcement and write reinforcementCount

**Task:** Implement remaining fixes from tests/acceptance/cortex/fixes.md (FIX-3, FIX-4, FIX-5)
**What I did:** (1) FIX-5: Changed `reinforcementCount: 10` to `1` in `write()` per plan spec. (2) FIX-4: Added fire-and-forget `store.reinforce()` calls in `read()` and both query() paths (embedding + keyword). (3) FIX-3: Documented taint as intentionally system-managed — agents can't set taint via tool schema; it's only set during `memorize()` from conversation context. (4) FIX-2: Marked as deferred — k8s init infrastructure doesn't exist yet. (5) Added 2 new provider tests verifying salience boost from repeated read/query access. Updated test name for FIX-5.
**Files touched:** `src/providers/memory/cortex/provider.ts`, `tests/providers/memory/cortex/provider.test.ts`, `tests/acceptance/cortex/fixes.md`
**Outcome:** Success — all 145 cortex tests pass across 12 files
**Notes:** Read-path reinforcement was originally omitted from the implementation (journal entry from Task 8 notes: "Removed reinforce-on-read from the plan's spec to keep reads side-effect-free"). Now restored per plan intent — fire-and-forget `.catch(() => {})` keeps reads non-blocking while still incrementing counts.

## [2026-03-06 12:10] — Remove dead summary-io code and make tests storage-agnostic

**Task:** Tasks 5 and 6 of cortex summary storage plan: delete orphaned summary-io module and update provider tests to assert via query() instead of reading .md files from disk
**What I did:** (1) Verified no src/ files import summary-io.ts (only summary-io.ts itself). Deleted `src/providers/memory/cortex/summary-io.ts` and `tests/providers/memory/cortex/summary-io.test.ts`. (2) Updated two provider tests that used `readFile(join(memoryDir, 'knowledge.md'))` and `readFile(join(memoryDir, 'work_life.md'))` to instead use `memory.query()` and find results with `SUMMARY_ID_PREFIX`. (3) Removed unused `readFile` and `dataFile` imports from provider test. (4) Fixed pre-existing integration test failure where dedup assertion counted 2 instead of 1 — the summary-appending from Task 4 added a summary result. Fixed by filtering out summary IDs before the count assertion.
**Files touched:** `src/providers/memory/cortex/summary-io.ts` (deleted), `tests/providers/memory/cortex/summary-io.test.ts` (deleted), `tests/providers/memory/cortex/provider.test.ts` (modified), `tests/providers/memory/cortex/integration.test.ts` (modified)
**Outcome:** Success — all 143 tests pass across 12 cortex test files
**Notes:** The integration test failure was caused by Task 4's summary-appending behavior — query() now returns items + summaries, so tests that assert exact result counts need to filter by ID prefix.

## [2026-03-06 12:00] — Wire summaries into query() as trailing results

**Task:** Task 4 of cortex summary storage plan — make query() return summaries after item-level results when limit slots remain, and add guard clauses to read()/delete() for summary IDs
**What I did:** (1) Added `if (id.startsWith(SUMMARY_ID_PREFIX)) return null` guard to read(), (2) Added `if (id.startsWith(SUMMARY_ID_PREFIX)) return` guard to delete(), (3) Replaced keyword path's final return with summary-appending logic that uses `summaryStore.readAll()` to fill remaining limit slots with matching category summaries. Summaries are skipped for embedding queries (precision search), when limit is filled by items, when content is just the empty default (`# ${category}`), and when keyword query doesn't match summary content. User-scoped queries get user summaries first, then shared summaries. (4) Added 5 new tests covering: summary appending with LLM, limit-filled items, embedding query exclusion, read() guard, delete() guard.
**Files touched:** `src/providers/memory/cortex/provider.ts`, `tests/providers/memory/cortex/provider.test.ts`
**Outcome:** Success — all 26 tests pass
**Notes:** The embedding path's early return is kept as-is since we skip summaries for embedding queries anyway. Only the keyword path's final return was replaced with the summary-appending logic.

## [2026-03-06 11:50] — Wire SummaryStore into cortex provider

**Task:** Replace direct summary-io.ts imports in cortex provider.ts with the new SummaryStore abstraction, choosing DbSummaryStore for non-sqlite databases and FileSummaryStore otherwise (Task 3 of cortex summary storage plan)
**What I did:** Replaced `import { writeSummary, readSummary, initDefaultCategories } from './summary-io.js'` with `import { FileSummaryStore, DbSummaryStore, SUMMARY_ID_PREFIX, type SummaryStore } from './summary-store.js'`. Changed `updateCategorySummary` to accept `SummaryStore` instead of `memoryDir: string`. In `create()`, replaced `initDefaultCategories(memoryDir)` with conditional SummaryStore instantiation (`DbSummaryStore` when `database.type !== 'sqlite'`, `FileSummaryStore` otherwise) plus `initDefaults()`. Updated both call sites (write and memorize methods) to pass `summaryStore` instead of `memoryDir`.
**Files touched:** `src/providers/memory/cortex/provider.ts`
**Outcome:** Success — all 21 existing tests pass unchanged
**Notes:** `memoryDir` is still needed for standalone SQLite DB paths (`_store.db`, `_vec.db`). `mkdirSync` is still used for those paths. `SUMMARY_ID_PREFIX` imported for use in a later task (Task 4: wire summaries into query).

## [2026-03-06 11:42] — Add DbSummaryStore with cortex_summaries migration

**Task:** Implement Task 2 of cortex summary storage plan — add DbSummaryStore class and cortex_summaries migration
**What I did:** Added `memory_002_summaries` migration to `migrations.ts` creating `cortex_summaries` table with composite unique index on (category, user_id). Added `DbSummaryStore` class to `summary-store.ts` implementing the `SummaryStore` interface with Kysely queries, using `ON CONFLICT DO UPDATE` for upserts and `ON CONFLICT DO NOTHING` for idempotent initDefaults. Uses `__shared__` sentinel for NULL-free user_id (avoids NULL-in-unique-index issues). Added 10 tests for DbSummaryStore covering round-trip, upsert, list, initDefaults idempotency, user-scoped isolation, and readAll.
**Files touched:** `src/providers/memory/cortex/migrations.ts`, `src/providers/memory/cortex/summary-store.ts`, `tests/providers/memory/cortex/summary-store.test.ts`
**Outcome:** Success — all 20 tests pass (10 FileSummaryStore + 10 DbSummaryStore)
**Notes:** Follows job-store pattern for ON CONFLICT upserts. The `__shared__` sentinel avoids SQLite/PostgreSQL NULL behavior differences in unique indexes.

## [2026-03-06 11:40] — Add SummaryStore interface and FileSummaryStore implementation

**Task:** Extract existing file-based summary logic from summary-io.ts into a pluggable SummaryStore interface with a FileSummaryStore implementation (Task 1 of cortex summary storage plan)
**What I did:** Created `summary-store.ts` with a `SummaryStore` interface (read/write/list/readAll/initDefaults) and `FileSummaryStore` class that encapsulates the same atomic-write, safePath-protected file operations from summary-io.ts but as instance methods on a class. Also created comprehensive test file with 10 tests covering round-trip, overwrite, listing, initDefaults, user-scoped isolation, path traversal sanitization, atomic writes, and readAll.
**Files touched:** `src/providers/memory/cortex/summary-store.ts` (new), `tests/providers/memory/cortex/summary-store.test.ts` (new)
**Outcome:** Success — all 10 tests pass
**Notes:** The interface is designed for a later DbSummaryStore implementation (Task 2). The FileSummaryStore uses the same patterns as summary-io.ts (safePath, atomic temp-rename, wx flag for initDefaults) but packages them as a class. The unused `import type { Kysely }` and `SUMMARY_ID_PREFIX` constant are included for the upcoming DbSummaryStore.

## [2026-03-06 09:45] — Fix memory recall: wildcard scope, synchronous embeddings, observable fallback

**Task:** Memory provider stores data correctly (visible in preferences.md) but agent can't retrieve it in new sessions
**What I did:** Fixed three issues: (1) `ItemsStore.listByScope()` and `searchContent()` treated scope `'*'` as a literal SQL match instead of a wildcard — added `scope !== '*'` guard to omit scope filter when wildcard. (2) Embedding generation in `write()` and `memorize()` was fire-and-forget (`.catch(() => {})`) meaning embeddings might not exist when the next session queries — made both paths `await` the embedding storage. (3) `recallMemoryForMessage()` now logs `logger.warn('memory_recall_embedding_empty')` when embedding search returns empty and falls back to keywords, so operators can diagnose missing embeddings instead of silent degradation.
**Files touched:** `src/providers/memory/cortex/items-store.ts`, `src/providers/memory/cortex/provider.ts`, `src/host/memory-recall.ts`, `tests/providers/memory/cortex/items-store.test.ts`, `tests/host/memory-recall.test.ts`
**Outcome:** Success — 2330 tests pass, 4 new tests added
**Notes:** Root cause was fire-and-forget embedding generation: `write()` had `.catch(() => {})` (zero logging), `memorize()` had a detached async IIFE. Embeddings were often missing when the next session queried. The wildcard scope bug compounded this by also breaking the keyword fallback path.

## [2026-03-05 00:00] — Rename MemoryFS types to Cortex in cortex provider

**Task:** Rename MemoryFSItem->CortexItem, MemoryFSConfig->CortexConfig, update header comments from memoryfs->cortex, update MemoryFS->Cortex in comments, and change logger component from 'memoryfs' to 'cortex'
**What I did:** Applied renames across 8 files in src/providers/memory/cortex/: types.ts (interface renames + JSDoc), items-store.ts (type refs + header), provider.ts (type refs + header + logger component), extractor.ts (type refs + header), summary-io.ts (header), migrations.ts (header), llm-helpers.ts (header), prompts.ts (header). Verified content-hash.ts, salience.ts, embedding-store.ts, and index.ts had no memoryfs references. Import paths (relative './types.js' etc.) left unchanged as instructed.
**Files touched:** `src/providers/memory/cortex/types.ts`, `src/providers/memory/cortex/items-store.ts`, `src/providers/memory/cortex/provider.ts`, `src/providers/memory/cortex/extractor.ts`, `src/providers/memory/cortex/summary-io.ts`, `src/providers/memory/cortex/migrations.ts`, `src/providers/memory/cortex/llm-helpers.ts`, `src/providers/memory/cortex/prompts.ts`
**Outcome:** Success — zero remaining MemoryFS/memoryfs references in cortex directory or anywhere in src/
**Notes:** test plan file tests/acceptance/cortex/test-plan.md still references old names but is outside the requested scope.

## [2026-03-04 02:55] — Multi-user scoped memory implementation

**Task:** Add per-user memory isolation to MemoryFS so DMs are user-scoped and channels are agent-scoped
**What I did:** Implemented full multi-user memory scoping across 16 files: (1) threaded `sessionScope` through IPC pipeline (ipc-server → server-completions → server-channels → runner → ipc-client → runners), (2) added `userId` to memory provider types, (3) updated ItemsStore with userId filtering (findByHash, listByScope, searchContent, listByCategory), (4) updated EmbeddingStore with user_id column migration and userId filtering in upsert/findSimilar, (5) threaded userId through MemoryFS provider write/query/list/memorize, (6) added server-side userId injection in IPC memory handlers with isDmScope() helper, (7) updated memory recall with userId/sessionScope config, (8) wrote comprehensive tests across 5 test files (items-store, embedding-store, provider, memory-recall, IPC handler).
**Files touched:** `src/host/ipc-server.ts`, `src/host/server-completions.ts`, `src/host/server-channels.ts`, `src/agent/runner.ts`, `src/agent/ipc-client.ts`, `src/agent/runners/claude-code.ts`, `src/agent/runners/pi-session.ts`, `src/providers/memory/types.ts`, `src/providers/memory/memoryfs/items-store.ts`, `src/providers/memory/memoryfs/embedding-store.ts`, `src/providers/memory/memoryfs/provider.ts`, `src/host/ipc-handlers/memory.ts`, `src/host/memory-recall.ts`, `tests/providers/memory/memoryfs/items-store.test.ts`, `tests/providers/memory/memoryfs/embedding-store.test.ts`, `tests/providers/memory/memoryfs/provider.test.ts`, `tests/host/memory-recall.test.ts`, `tests/host/ipc-handlers/memory.test.ts`, `docs/plans/multi-user-scoped-memory.md`
**Outcome:** Success — 209 test files, 2327 tests pass, 0 failures
**Notes:** Key design: `userId = NULL` = shared/agent-scoped. DMs inject ctx.userId, channels set userId=undefined. Existing data (all NULL) becomes shared — fully backward compatible. SQL pattern: `(user_id = ? OR user_id IS NULL)` for "own + shared" semantics.

## [2026-03-03 21:00] — Run remaining acceptance tests: BT-9, IT-7, IT-8

**Task:** Run the 3 skipped acceptance tests that required embedding support (BT-9, IT-7, IT-8)
**What I did:** Set up isolated test home, started AX server with DeepInfra embeddings (Qwen/Qwen3-Embedding-0.6B). Ran BT-9 (memory recall in new session), IT-7 (cross-session semantic recall with Rust/AWS facts), IT-8 (backfill of directly-inserted items). All 3 passed. Updated results.md (37/37 PASS, 0 SKIP), fixes.md (removed "Not Tested" section), and .env.test.example (DEEPINFRA_API_KEY instead of OPENAI_API_KEY).
**Files touched:** `tests/acceptance/memoryfs-v2/results.md`, `tests/acceptance/memoryfs-v2/fixes.md`, `tests/acceptance/fixtures/.env.test.example`
**Outcome:** Success — all 37 acceptance tests now PASS
**Notes:** The "Requires OPENAI_API_KEY" skip reason was outdated — embeddings now use DeepInfra. Unrelated queries still trigger recall (no distance threshold in `findSimilar()`), same observation as BT-8. Agent correctly ignores irrelevant recalled context.

## [2026-03-03 14:10] — Fix FIX-6: Make content hash type-agnostic for dedup

**Task:** Fix BT-2 acceptance test failure — dedup failing when LLM assigns different memory types to the same fact across conversations
**What I did:** Removed `memoryType` from the content hash computation. Hash was `sha256("{type}:{normalized}")[:16]`, now it's `sha256(normalized)[:16]`. Updated all call sites (provider.ts `write()`, extractor.ts `extractByLLM()`) and tests. Ran BT-2 acceptance test end-to-end: 1 item with reinforcement_count=2 after two identical messages.
**Files touched:** `src/providers/memory/memoryfs/content-hash.ts` (removed type param), `src/providers/memory/memoryfs/provider.ts` (updated call), `src/providers/memory/memoryfs/extractor.ts` (updated call), `tests/providers/memory/memoryfs/content-hash.test.ts` (updated assertions), `tests/acceptance/memoryfs-v2/results.md`, `tests/acceptance/memoryfs-v2/fixes.md`
**Outcome:** Success — 29 unit tests pass, BT-2 acceptance test PASS (was PARTIAL PASS)
**Notes:** The risk of false collisions from removing type is negligible — if two genuinely different facts have identical normalized text, they'd be the same fact anyway. The LLM's memory type assignment is too inconsistent to rely on for dedup.

Memory provider implementations, MemoryFS planning.

## [2026-03-03 14:01] — Add embedding-based semantic dedup to write()

**Task:** Implement semantic dedup in `write()` to catch paraphrased duplicates that hash-based dedup misses (BT-2 acceptance test fix)
**What I did:** Added `SEMANTIC_DEDUP_THRESHOLD = 0.8` constant and a semantic dedup check between hash-based fast path and insert in `write()`. When hash misses but embeddings are available, embeds the content, finds nearest neighbor in same scope, and reinforces if similarity >= 0.8. Precomputed vector is reused for the embedding store upsert to avoid double API calls. Created separate test file for semantic dedup (6 tests) and added 1 hash dedup integration test.
**Files touched:** `src/providers/memory/memoryfs/provider.ts` (modified write()), `tests/providers/memory/memoryfs/semantic-dedup.test.ts` (new), `tests/providers/memory/memoryfs/integration.test.ts` (added 1 test)
**Outcome:** Success — all 2239 tests pass, 0 regressions
**Notes:** Mock vectors must match the EmbeddingStore's configured dimensions (default 1536). Tests use `config.history.embedding_dimensions: 3` with 3-element Float32Arrays. Fire-and-forget upsert after first write needs ~50ms settle time before second write can find it via `findSimilar`.

## [2026-03-03 06:04] — Wire LLM into MemoryFS for extraction and summary generation

**Task:** Connect LLM provider to MemoryFS so both `memorize()` and `write()` use LLM-powered extraction and summary generation instead of regex/bullet-append.
**What I did:**
- Created `llm-helpers.ts` with `collectLLMText()` (stream collector) and `llmComplete()` (text-in/text-out wrapper)
- Added `extractByLLM()` to `extractor.ts` alongside existing `extractByRegex()` — LLM extracts structured JSON items; throws on parse failure so caller can fall back to regex
- Modified `provider.ts`: accepts optional LLM via `CreateOptions`, `write()` now gives explicit entries `reinforcementCount: 10` (was 1) and fires LLM summary update, `memorize()` uses LLM extraction with regex fallback and LLM summary generation with bullet-append fallback
- Added `updateCategorySummary()` helper using `buildSummaryPrompt()` from prompts.ts
- Modified `registry.ts` to pass `tracedLlm` to memory provider (follows skills provider pattern)
- Wrote 7 new tests for llm-helpers, 7 new tests for extractByLLM, 6 new tests for LLM-wired provider
**Files touched:** `src/providers/memory/memoryfs/llm-helpers.ts` (new), `src/providers/memory/memoryfs/extractor.ts` (mod), `src/providers/memory/memoryfs/provider.ts` (mod), `src/host/registry.ts` (mod), `tests/providers/memory/memoryfs/llm-helpers.test.ts` (new), `tests/providers/memory/memoryfs/extractor.test.ts` (mod), `tests/providers/memory/memoryfs/provider.test.ts` (mod)
**Outcome:** Success — 101 memoryfs tests pass, 2231 total tests pass (1 pre-existing failure in phase1.test.ts unrelated)
**Notes:** LLM is optional — all behavior gracefully degrades to regex + bullet-append when no LLM provided. extractByLLM throws on invalid JSON (not just returns empty) so `.catch()` fallback in memorize works correctly.

## [2026-03-02 23:22] — Replace @dao-xyz/sqlite3-vec with official sqlite-vec

**Task:** Replace `@dao-xyz/sqlite3-vec` (Linux-only) with official `sqlite-vec` (cross-platform)
**What I did:** Removed `@dao-xyz/sqlite3-vec` from package.json, added `sqlite-vec`. Rewrote embedding-store.ts to use `better-sqlite3` + `sqlite-vec` directly: sync `new Database()` + `sqliteVec.load(db)` instead of async `sqliteVec.createDatabase()`. Converted all internal DB operations from async to sync (spread params, use `result.lastInsertRowid` instead of `SELECT last_insert_rowid()`). Updated degradation tests to use `vi.hoisted` + `vi.mock('sqlite-vec')` pattern since ESM module namespaces are non-configurable for `vi.spyOn`.
**Files touched:** package.json, src/providers/memory/memoryfs/embedding-store.ts, tests/providers/memory/memoryfs/embedding-store.test.ts
**Outcome:** Success — build passes, all 14 embedding-store tests pass (including degradation), full memoryfs suite (81 tests) passes
**Notes:** Public async API preserved — no changes needed to callers.

## [2026-03-03 03:25] — Fix TS build errors in embedding-store.ts

**Task:** Fix 8 TypeScript compilation errors in embedding-store.ts after merging origin/main
**What I did:** Fixed import of `createDatabase` from `@dao-xyz/sqlite3-vec` — the package's `exports["."].types` resolves to `dist/unified.d.ts` which doesn't declare `createDatabase` as a named export (it's only in `dist/unified-node.d.ts`). Switched to default import (`import sqliteVec from ...`) and used `sqliteVec.createDatabase()`. Fixed 7 "Object is possibly null" errors in `init()` by using a local `db` variable instead of `this.db` (which is typed `Database | null`).
**Files touched:** src/providers/memory/memoryfs/embedding-store.ts
**Outcome:** Success — build passes clean, all 2216 tests pass
**Notes:** The `@dao-xyz/sqlite3-vec` package has a type declaration mismatch: runtime entry is `dist/unified-node.js` (exports `createDatabase`) but types resolve to `dist/unified.d.ts` (doesn't export it). The default export is typed as `any`, so `sqliteVec.createDatabase()` works but loses type safety on the function signature — mitigated by annotating the result as `Database`.

## [2026-03-03 03:00] — Fix 3 PR review issues in embedding search

**Task:** Address codex review comments on PR #57: (P1) embedding query falls through to unfiltered listing, (P2) backfill only covers 'default' scope, (P2) scoped similarity search uses incorrect global-MATCH-then-filter
**What I did:**
- Fixed P1: `query()` now returns `[]` when embedding search yields empty results instead of falling through to unfiltered keyword/listing search. Error fallthrough preserved for graceful degradation.
- Fixed P2 (backfill): Changed `backfillEmbeddings()` to iterate all scopes via new `ItemsStore.listAllScopes()` method instead of hardcoded 'default'.
- Fixed P2 (scoped search): Added `embedding BLOB` column to `embedding_meta` table, storing raw vectors on upsert. Scoped `findSimilar()` now uses `vec_distance_l2()` scalar function with `WHERE scope = ?` for correct within-scope brute-force search instead of the broken global MATCH + post-filter approach. Unscoped queries still use fast vec0 MATCH.
- Added 4 new tests: scoped nearest-neighbor correctness, empty scope returns empty, `listAllScopes`, and embedding query empty result behavior.
**Files touched:** `src/providers/memory/memoryfs/provider.ts`, `src/providers/memory/memoryfs/embedding-store.ts`, `src/providers/memory/memoryfs/items-store.ts`, `tests/providers/memory/memoryfs/embedding-store.test.ts`, `tests/providers/memory/memoryfs/items-store.test.ts`, `tests/providers/memory/memoryfs/provider.test.ts`
**Outcome:** Success — all 2149 tests pass (201 files)
**Notes:** The `vec_distance_l2()` approach trades ANN speed for correctness on scoped queries. For memory store sizes (hundreds to low thousands per scope), brute-force is fine.

## [2026-03-03 02:26] — Add embedding-based semantic search to MemoryFS

**Task:** Replace keyword (LIKE) search with vector embedding similarity search for MemoryFS memory recall, using @dao-xyz/sqlite3-vec for vector storage and OpenAI embeddings API for embedding generation.

**What I did:**
- Added `@dao-xyz/sqlite3-vec` dependency for sqlite-vec virtual table support
- Created `src/utils/embedding-client.ts` — standalone OpenAI embedding client with graceful degradation when no API key
- Created `src/providers/memory/memoryfs/embedding-store.ts` — vec0-backed vector store with similarity search, scope filtering, backfill support
- Extended `MemoryQuery` with optional `embedding: Float32Array` field (backward compatible)
- Added `getByIds()` and `listIdsByScope()` to `ItemsStore` for batch lookups
- Integrated embeddings into MemoryFS provider: write→embed, query→vector search with salience, memorize→batch embed
- Updated `memory-recall.ts` to use embedding-based search with keyword fallback
- Wired `EmbeddingClient` in `server-completions.ts` from config
- Added `embedding_model` and `embedding_dimensions` config fields (defaults: text-embedding-3-small, 1536)
- Background backfill of existing memories on provider startup
- Wrote 31 new tests across 3 test files + updated 2 existing test files
- Fixed pre-existing provider-map path regex that didn't support nested provider directories

**Files touched:**
- `package.json` — added @dao-xyz/sqlite3-vec
- `src/utils/embedding-client.ts` — new
- `src/providers/memory/memoryfs/embedding-store.ts` — new
- `src/providers/memory/types.ts` — added embedding field to MemoryQuery
- `src/providers/memory/memoryfs/provider.ts` — integrated embeddings
- `src/providers/memory/memoryfs/items-store.ts` — added getByIds, listIdsByScope
- `src/host/memory-recall.ts` — embedding search with keyword fallback
- `src/host/server-completions.ts` — create and pass embedding client
- `src/config.ts` — added embedding config fields
- `src/types.ts` — added embedding config types
- `tests/utils/embedding-client.test.ts` — new (6 tests)
- `tests/providers/memory/memoryfs/embedding-store.test.ts` — new (10 tests)
- `tests/host/memory-recall.test.ts` — added 5 embedding tests (15 total)
- `tests/config-history.test.ts` — updated default assertion
- `tests/integration/phase2.test.ts` — fixed path regex
- `tests/host/provider-map.test.ts` — fixed path regex

**Outcome:** Success. All 2144 tests pass. Memory recall now uses semantic vector search when OPENAI_API_KEY is available, with automatic fallback to keyword search when it's not.

**Notes:**
- Separate _vec.db file for vector data avoids extension compat issues with the generic SQLite adapter
- `@dao-xyz/sqlite3-vec` wraps better-sqlite3 and auto-loads the native vec extension
- Embedding generation is non-blocking (fire-and-forget) on write to avoid latency
- Similarity score feeds into existing salience formula: similarity × log(reinforcement+1) × recencyDecay
- Config is opt-in: embedding_model defaults to text-embedding-3-small, dimensions to 1536

## [2026-03-02 16:34] — Add full lifecycle integration test (Task 10 of 10)

**Task:** Create end-to-end integration test exercising the complete MemoryFS pipeline through the public MemoryProvider interface.
**What I did:** Wrote integration.test.ts with 5 tests: full lifecycle (memorize -> query -> reinforcement), dedup (same fact twice -> one entry reinforced), write+read+delete round-trip, scope isolation, and summary file creation verification. All tests exercise the provider through its public interface with a real temp directory and SQLite database.
**Files touched:** tests/providers/memory/memoryfs/integration.test.ts (new)
**Outcome:** Success -- all 5 tests pass in 32ms
**Notes:** This completes all 10 tasks in the MemoryFS v2 plan. Total: 54 tests across 8 test files. The integration test validates that extractor, content-hash, items-store, summary-io, and salience all work together correctly through the provider facade.

## [2026-03-02 16:31] — Wire MemoryFS provider with items store, memorize pipeline, and salience ranking (Tasks 2+8 of 10)

**Task:** Implement the MemoryFS provider (Task 8) which wires together items store, summary I/O, extractor, content hash, and salience scoring. Also implemented the missing ItemsStore (Task 2) as a prerequisite dependency.
**What I did:** Created items-store.ts (SQLite CRUD class with dedup, reinforcement, scoped queries), provider.ts (MemoryProvider implementation with write/query/read/delete/list/memorize), index.ts (barrel export), and provider.test.ts (11 tests). The provider's memorize() runs the full inline pipeline: extractByRegex -> dedup/reinforce -> insert to SQLite -> update category summaries. query() searches items via LIKE and ranks by salience score. write() deduplicates via content hash.
**Files touched:** src/providers/memory/memoryfs/items-store.ts (new), src/providers/memory/memoryfs/provider.ts (new), src/providers/memory/memoryfs/index.ts (new), tests/providers/memory/memoryfs/provider.test.ts (new)
**Outcome:** Success -- all 11 provider tests pass, all 49 memoryfs tests pass
**Notes:** Removed reinforce-on-read from the plan's spec to keep reads side-effect-free. The plan called for reinforce on every query() and read() access -- kept reinforce out of read() for cleaner semantics. ItemsStore uses openDatabase() from src/utils/sqlite.ts for runtime-agnostic SQLite (bun:sqlite / node:sqlite / better-sqlite3). dataFile('memory') resolves to $AX_HOME/data/memory which initDefaultCategories creates recursively.

## [2026-03-02 16:25] — Add LLM prompt templates for summary generation and patching (Task 7 of 10)

**Task:** Implement LLM prompt templates for generating/updating category summaries and incremental CRUD patches. Adapted from memU's category_summary prompts. Pure string manipulation, no I/O.
**What I did:** Wrote test file first (TDD) with 7 tests covering buildSummaryPrompt (category/length/items inclusion, original content passthrough), buildSummaryPromptWithRefs (ref ID formatting with [refId] and [ref: instructions), buildPatchPrompt (category/content/update formatting), and parsePatchResponse (true case, false case, malformed JSON graceful fallback). Verified failure, then implemented all four exported functions.
**Files touched:** src/providers/memory/memoryfs/prompts.ts (new), tests/providers/memory/memoryfs/prompts.test.ts (new)
**Outcome:** Success -- all 7 tests pass
**Notes:** Three prompt builders: buildSummaryPrompt (merge without refs), buildSummaryPromptWithRefs (merge with [ref:ITEM_ID] citation tracking), buildPatchPrompt (incremental CRUD deciding need_update true/false). parsePatchResponse uses regex to extract JSON from LLM output and gracefully handles malformed responses by returning needUpdate: false.

## [2026-03-02 16:22] — Add regex extractor with six memory types (Task 6 of 10)

**Task:** Implement regex-based memory extraction from conversation turns. Fast path (no LLM call) that outputs structured MemoryFSItem candidates with the six memory types.
**What I did:** Wrote test file first (TDD) with 6 tests covering explicit memory requests (profile), preferences (profile), action items (behavior), assistant turn filtering, 20-item cap, and field population (contentHash, scope, timestamps). Verified failure, then implemented extractByRegex function with three regex patterns and defaultCategoryForType mapping.
**Files touched:** src/providers/memory/memoryfs/extractor.ts (new), tests/providers/memory/memoryfs/extractor.test.ts (new)
**Outcome:** Success -- all 6 tests pass
**Notes:** Three regex patterns: explicit memory requests (confidence 0.95), preferences (0.7), and TODO/action items (0.8). Preference regex skipped if remember regex already matched to avoid duplicates. Max 20 items per conversation. Returns Omit<MemoryFSItem, 'id'> since IDs are assigned by the store layer.

## [2026-03-02 16:19] — Add salience scoring with memU formula (Task 5 of 10)

**Task:** Implement memU's salience scoring formula: similarity * log(reinforcement + 1) * exp(-0.693 * days / half_life). Pure math, no I/O.
**What I did:** Wrote test file first (TDD) with 7 tests covering positive scores, reinforcement ordering, recency ordering, half-life decay verification, null recency fallback, zero reinforcement edge case, and similarity ordering. Verified failure, then implemented salienceScore function. Had to fix two tests from the task spec that used reinforcementCount: 0 for ratio comparisons — log(0+1) = 0 makes the score 0, producing NaN ratios. Changed to reinforcementCount: 1 and added a dedicated zero-reinforcement test.
**Files touched:** src/providers/memory/memoryfs/salience.ts (new), tests/providers/memory/memoryfs/salience.test.ts (new)
**Outcome:** Success — all 7 tests pass
**Notes:** Formula uses ln(2) = 0.693 for proper half-life decay. Null lastReinforcedAt gets a fixed 0.5 recency factor. Zero reinforcement correctly produces 0 score since log(1) = 0.

## [2026-03-02 16:15] — Add summary file I/O with atomic writes (Task 4 of 10)

**Task:** Implement read/write for category summary .md files with safePath() for path safety and atomic writes via temp-then-rename.
**What I did:** Wrote test file first (TDD) with 9 tests covering round-trip, null for missing, overwrite, listing, underscore exclusion, categoryExists, initDefaultCategories (10 defaults), path traversal sanitization, and atomic write verification. Verified failure, then implemented writeSummary, readSummary, listCategories, categoryExists, initDefaultCategories.
**Files touched:** src/providers/memory/memoryfs/summary-io.ts (new), tests/providers/memory/memoryfs/summary-io.test.ts (new)
**Outcome:** Success — all 9 tests pass
**Notes:** safePath() sanitizes traversal attempts (replaces .. and / with _) rather than throwing, so the path traversal test verifies files stay inside memoryDir rather than expecting an exception. Atomic writes use randomUUID for temp file suffix.

## [2026-03-02 16:12] — Add content hashing with type-scoped dedup and ref IDs (Task 3 of 10)

**Task:** Create deterministic content hashing for deduplication matching memU's compute_content_hash, plus short ref ID builder.
**What I did:** Wrote test file first (TDD) with 6 tests covering determinism, type-scoping, whitespace normalization, case normalization, uniqueness, and ref ID slicing. Verified failure, then implemented computeContentHash (sha256 of "{type}:{normalized}" truncated to 16 hex chars) and buildRefId (first 6 chars).
**Files touched:** src/providers/memory/memoryfs/content-hash.ts (new), tests/providers/memory/memoryfs/content-hash.test.ts (new)
**Outcome:** Success — all 6 tests pass
**Notes:** Pure function module with no I/O. Uses node:crypto createHash. Normalization: lowercase + collapse whitespace + trim.

## [2026-03-02 16:09] — Add SQLite items store (Task 2 of 10)

**Task:** Create the SQLite-backed items store for CRUD on MemoryFSItem rows
**What I did:** Wrote test file first (TDD) with 10 tests covering insert/read, findByHash with scope isolation, reinforce (increment + timestamp), listByCategory, listByScope with limit, deleteById, searchContent with LIKE, agentId scoping, and getAllForCategory. Then implemented ItemsStore class using openDatabase() from src/utils/sqlite.ts with snake_case SQL columns mapped to camelCase MemoryFSItem via rowToItem().
**Files touched:** src/providers/memory/memoryfs/items-store.ts (new), tests/providers/memory/memoryfs/items-store.test.ts (new)
**Outcome:** Success — all 10 tests pass
**Notes:** Uses CREATE TABLE IF NOT EXISTS + 4 indexes (scope, category+scope, hash+scope, agent_id+scope). findByHash uses IS NULL for agent_id when no agentId provided, ensuring scope isolation. reinforce() updates both reinforcement_count and last_reinforced_at atomically.

## [2026-03-02 16:04] — Add MemoryFS v2 core types (Task 1 of 10)

**Task:** Create the core types module for the MemoryFS provider
**What I did:** Created types.ts with six memory types (profile, event, knowledge, behavior, skill, tool), MemoryFSItem interface, MemoryFSConfig interface, RefId type alias, and DEFAULT_CATEGORIES constant. Wrote test file first (TDD), verified failure, then implemented.
**Files touched:** src/providers/memory/memoryfs/types.ts (new), tests/providers/memory/memoryfs/types.test.ts (new)
**Outcome:** Success — all 3 tests pass
**Notes:** LLMProvider imported from ../../llm/types.js. This is the foundation for the remaining 9 tasks in the MemoryFS v2 plan.

## [2026-03-01 19:30] — Create MemoryFS implementation plan

**Task:** Review memory-proposal.md and memory-feedback.md, create a detailed implementation plan
**What I did:** Explored the full codebase to understand provider patterns, existing memory providers, IPC schemas, SQLite utilities, and test conventions. Synthesized both source documents into a 16-task, 5-phase implementation plan covering storage foundation, core memory path, git integration, organization/lifecycle, deep retrieval, proactive intelligence, and integration testing.
**Files touched:** docs/plans/2026-03-01-memoryfs-implementation.md (new)
**Outcome:** Success — plan created, committed, and pushed
**Notes:** Plan follows the writing-plans skill format with TDD steps per task. Incorporated all feedback recommendations: two-phase writes, reconciler, tiered decay (hot/warm/cold), manifest-backed categories, git history worker, fact fingerprinting, idempotency, sensitivity fields.
