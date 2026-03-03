# Providers: Memory

Memory provider implementations, MemoryFS planning.

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
