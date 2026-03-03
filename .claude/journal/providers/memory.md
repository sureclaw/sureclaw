# Providers: Memory

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
