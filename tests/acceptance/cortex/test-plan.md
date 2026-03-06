# Acceptance Tests: Cortex Memory Provider

**Plan document(s):** `docs/plans/2026-03-02-memoryfs-v2-plan.md`, `docs/plans/2026-03-06-cortex-summary-storage.md`
**Date designed:** 2026-03-03 (updated 2026-03-06 with summary storage tests)
**Total tests:** 51 (ST: 28, BT: 12, IT: 11)

## Summary of Acceptance Criteria

Extracted from the v2 plan's design decisions, data flow diagrams, security checklist, task specifications, and the implemented embedding/recall system:

### Architecture & Data Model
1. Two complementary stores: pluggable SummaryStore for category summaries, SQLite/PostgreSQL for atomic items
2. Six memory types: profile, event, knowledge, behavior, skill, tool
3. Ten default categories matching memU: personal_info, preferences, relationships, activities, goals, experiences, knowledge, opinions, habits, work_life
4. Items stored as SQLite rows with 15 columns matching the plan's schema
5. **Summary storage is pluggable:** FileSummaryStore (local dev / SQLite) writes `.md` files; DbSummaryStore (k8s / PostgreSQL) writes to `cortex_summaries` table
6. On-disk layout (local): `memory/` directory with `.md` files + `_store.db` + `_vec.db`; (k8s): summaries in database, items in shared database

### Write Path
7. Conversation -> Extract -> Dedup/Reinforce -> Categorize -> Write items to SQLite -> Update category summary .md files
8. Content-hash deduplication: `sha256("{type}:{normalized}")[:16]`
9. Reinforcement counting: duplicate items increment `reinforcement_count` instead of creating new rows
10. Max 20 items extracted per conversation
11. **Embeddings generated for every new item** -- stored in `_vec.db` via EmbeddingStore for later semantic search

### Read Path
12. Retrieval uses memU's salience formula: `similarity * log(reinforcement + 1) * recency_decay`
13. Recency factor: `exp(-0.693 * days / half_life)` with 30-day default half-life
14. Query results ranked by salience score
15. **Embedding-based semantic search** when `q.embedding` is provided -- preferred path (summaries NOT appended for embedding queries)
16. **Keyword fallback** when no embedding available -- graceful degradation
16a. **Summaries appended after items** in keyword/listing queries to fill remaining `limit` slots
16b. **Summary IDs** use `summary:` prefix -- `read()` and `delete()` reject them gracefully
16c. **User-scoped summaries** appear before shared summaries; empty defaults (content = `# category`) are skipped

### Context Injection (Long-Term Memory Recall)
17. **On every user message**, the host process embeds the user's prompt and queries memory for semantically similar entries
18. **Recalled memories prepended to conversation history** as the oldest context turns, before the agent starts
19. Two-strategy recall: embedding-based semantic search (preferred), keyword extraction (fallback)
20. Recall is configurable: `memory_recall` (enabled/disabled), `memory_recall_limit`, `memory_recall_scope`
21. Format: `[Long-term memory recall -- N relevant memories from past sessions]` with numbered entries

### Extraction
22. **LLM extraction only** -- no regex fallback. Extraction requires an LLM provider.
23. LLM extractor outputs JSON array with validated types/categories
24. If LLM extraction fails (including any fallback models), `memorize()` returns an error (not silently swallowed)

### Memorization Trigger
25. **`memorize()` called automatically** at end of every completion in `server-completions.ts`
26. Full conversation (client messages + agent response) passed to memorize

### Provider Contract
27. Implements `MemoryProvider` interface: write, query, read, delete, list, memorize
28. `write()` deduplicates via content hash before inserting
29. `memorize()` runs full pipeline: extract -> dedup/reinforce -> store -> update summaries -> embed
30. Scope isolation: every query filtered by `scope`
31. Agent isolation: `agentId` filtering in queries

### Security
32. All file paths constructed via `safePath()` -- no raw `path.join()` with user input
33. Path traversal attacks rejected (e.g., `../escape` as category name)
34. Provider registered in static `PROVIDER_MAP` allowlist (SC-SEC-002)
35. No dynamic imports from config values
36. SQLite uses WAL mode
37. Content hashing is deterministic and type-scoped
38. Taint tags preserved through write/read round-trip

### Infrastructure
39. Graceful degradation: all CRUD works without OPENAI_API_KEY or sqlite-vec
40. Embedding backfill: items created before embedding client was available get backfilled on startup

---

## Structural Tests

### ST-1: Six memory types defined as const tuple

**Criterion:** "Six memory types (profile, event, knowledge, behavior, skill, tool) with per-type extraction prompts" (Plan, line 7)
**Plan reference:** `2026-03-02-memoryfs-v2-plan.md`, Design Decisions / Types

**Verification steps:**
1. Read `src/providers/memory/memoryfs/types.ts`
2. Check that `MEMORY_TYPES` is exported as a `const` array containing exactly `['profile', 'event', 'knowledge', 'behavior', 'skill', 'tool']`
3. Check that `MemoryType` is a union type derived from `MEMORY_TYPES`

**Expected outcome:**
- [ ] `MEMORY_TYPES` contains exactly 6 types in the specified order
- [ ] `MemoryType` is derived via `typeof MEMORY_TYPES[number]`

**Pass/Fail:** _pending_

---

### ST-2: MemoryFSItem interface matches plan schema

**Criterion:** "Item record (SQLite row)" with 15 columns (Plan, lines 95-112)
**Plan reference:** `2026-03-02-memoryfs-v2-plan.md`, Item record

**Verification steps:**
1. Read `src/providers/memory/memoryfs/types.ts`
2. Check `MemoryFSItem` interface has all 15 fields: id, content, memoryType, category, contentHash, source, confidence, reinforcementCount, lastReinforcedAt, createdAt, updatedAt, scope, agentId, userId, taint, extra

**Expected outcome:**
- [ ] All 15 fields present with correct types
- [ ] `memoryType` uses `MemoryType` (not raw string)
- [ ] Optional fields: source, agentId, userId, taint, extra

**Pass/Fail:** _pending_

---

### ST-3: Ten default categories matching memU

**Criterion:** "Default categories matching memU's defaults" (Plan, lines 237-248)
**Plan reference:** `2026-03-02-memoryfs-v2-plan.md`, On-disk layout

**Verification steps:**
1. Read `src/providers/memory/memoryfs/types.ts`
2. Check `DEFAULT_CATEGORIES` contains exactly: personal_info, preferences, relationships, activities, goals, experiences, knowledge, opinions, habits, work_life

**Expected outcome:**
- [ ] `DEFAULT_CATEGORIES` has exactly 10 entries
- [ ] All 10 names match the plan exactly

**Pass/Fail:** _pending_

---

### ST-4: SQLite table schema matches plan

**Criterion:** "CREATE TABLE items (...)" with 15 columns (Plan, lines 400-419)
**Plan reference:** `2026-03-02-memoryfs-v2-plan.md`, Task 2: Items Store

**Verification steps:**
1. Read `src/providers/memory/memoryfs/items-store.ts`
2. Check CREATE_TABLE SQL contains all 15 columns with correct types and constraints
3. Check indexes are created: idx_items_scope, idx_items_category, idx_items_hash, idx_items_agent

**Expected outcome:**
- [ ] Table has columns: id (TEXT PK), content (TEXT NOT NULL), memory_type (TEXT NOT NULL), category (TEXT NOT NULL), content_hash (TEXT NOT NULL), source (TEXT), confidence (REAL DEFAULT 0.5), reinforcement_count (INTEGER DEFAULT 1), last_reinforced_at (TEXT), created_at (TEXT NOT NULL), updated_at (TEXT NOT NULL), scope (TEXT NOT NULL DEFAULT 'default'), agent_id (TEXT), user_id (TEXT), taint (TEXT), extra (TEXT)
- [ ] Four indexes created on scope, (category,scope), (content_hash,scope), (agent_id,scope)

**Pass/Fail:** _pending_

---

### ST-5: Content hash uses sha256 with type prefix

**Criterion:** "sha256('{type}:{normalized}')[:16]" (Plan, line 637-641)
**Plan reference:** `2026-03-02-memoryfs-v2-plan.md`, Task 3: Content Hashing

**Verification steps:**
1. Read `src/providers/memory/memoryfs/content-hash.ts`
2. Check that `computeContentHash` normalizes whitespace (collapse to single spaces, trim) and lowercases
3. Check that it prefixes with `{memoryType}:` before hashing
4. Check that it uses `createHash('sha256')` and slices to 16 hex chars
5. Check `buildRefId` returns first 6 chars of content hash

**Expected outcome:**
- [ ] Hash input format: `"{memoryType}:{normalized_lowercase_content}"`
- [ ] Output is 16-character hex string (sha256[:16])
- [ ] `buildRefId` returns `contentHash.slice(0, 6)`

**Pass/Fail:** _pending_

---

### ST-6: Salience formula matches memU

**Criterion:** "similarity * log(reinforcement + 1) * exp(-0.693 * days / half_life)" (Plan, lines 956-977)
**Plan reference:** `2026-03-02-memoryfs-v2-plan.md`, Task 5: Salience Scoring

**Verification steps:**
1. Read `src/providers/memory/memoryfs/salience.ts`
2. Verify formula: `similarity * Math.log(reinforcementCount + 1) * recencyFactor`
3. Verify recency: `Math.exp(-0.693 * daysAgo / recencyDecayDays)`
4. Verify null lastReinforcedAt gives 0.5 recency factor

**Expected outcome:**
- [ ] Reinforcement factor: `Math.log(reinforcementCount + 1)` (logarithmic)
- [ ] Recency factor: exponential decay with `0.693 * days / halfLife`
- [ ] Null recency defaults to 0.5
- [ ] Return value is product of all three factors

**Pass/Fail:** _pending_

---

### ST-7: Summary store uses safePath for all path construction

**Criterion:** "All file paths use safePath() -- no raw path.join() with user input" (Plan, Security Checklist)
**Plan reference:** `2026-03-02-memoryfs-v2-plan.md`, Security Checklist

**Verification steps:**
1. Read `src/providers/memory/cortex/summary-store.ts`
2. Grep for `safePath` usage -- every function that takes a `category` parameter must use `safePath(memoryDir, ...)`
3. Grep for raw `path.join` with user-controlled input (should be none)
4. Verify `FileSummaryStore.read`, `FileSummaryStore.write`, `FileSummaryStore.initDefaults` all call `safePath`

**Expected outcome:**
- [ ] `FileSummaryStore.read()` uses `safePath(memoryDir, ...)` for file path
- [ ] `FileSummaryStore.write()` uses `safePath(memoryDir, ...)` for file path
- [ ] `FileSummaryStore.initDefaults()` uses `safePath(memoryDir, ...)` for file path
- [ ] No raw `join()` with user-controlled `category` parameter

**Pass/Fail:** _pending_

---

### ST-8: Atomic file writes (temp-then-rename)

**Criterion:** "Atomic writes via temp-then-rename" (Plan, line 672)
**Plan reference:** `2026-03-02-memoryfs-v2-plan.md`, Task 4: Summary File I/O

**Verification steps:**
1. Read `src/providers/memory/memoryfs/summary-io.ts`
2. Check `writeSummary` creates a temp file (`.tmp` extension) then renames

**Expected outcome:**
- [ ] `writeSummary` writes to `${filePath}.${uuid}.tmp` first
- [ ] Then renames temp to final path via `rename()`

**Pass/Fail:** _pending_

---

### ST-9: Provider registered in static PROVIDER_MAP

**Criterion:** "No dynamic imports: memoryfs added to static PROVIDER_MAP" (Plan, Security Checklist)
**Plan reference:** `2026-03-02-memoryfs-v2-plan.md`, Task 9: Provider Registration

**Verification steps:**
1. Read `src/host/provider-map.ts`
2. Check `memory` section contains `memoryfs: '../providers/memory/memoryfs/index.js'`

**Expected outcome:**
- [ ] `memoryfs` key exists in `memory` section of `_PROVIDER_MAP`
- [ ] Value is `'../providers/memory/memoryfs/index.js'`

**Pass/Fail:** _pending_

---

### ST-10: Provider exports create() factory function

**Criterion:** "Each provider exports create(config: Config) function" (CLAUDE.md, Key Patterns)
**Plan reference:** `2026-03-02-memoryfs-v2-plan.md`, Task 8

**Verification steps:**
1. Read `src/providers/memory/memoryfs/index.ts`
2. Verify it re-exports `create` from `./provider.js`
3. Read `src/providers/memory/memoryfs/provider.ts`
4. Verify `create` accepts `(config: Config, _name?, opts?)` and returns `Promise<MemoryProvider>`

**Expected outcome:**
- [ ] `index.ts` re-exports `create`
- [ ] `create` function signature matches provider contract
- [ ] Returns all 6 MemoryProvider methods: write, query, read, delete, list, memorize

**Pass/Fail:** _pending_

---

### ST-11: LLM-only extraction with no regex fallback

**Criterion:** Extraction is LLM-only. `extractByRegex` must not exist. If the LLM call fails, the error propagates.
**Plan reference:** Updated design decision -- regex fallback removed

**Verification steps:**
1. Read `src/providers/memory/memoryfs/extractor.ts`
2. Check that `extractByRegex` is **not exported** (function removed entirely)
3. Check that `extractByLLM` is the sole extraction entry point
4. Check that `extractByLLM` throws on LLM failure (no silent fallback, no try/catch returning empty array)
5. Verify MAX_ITEMS_PER_CONVERSATION = 20
6. Verify validation: response items checked against MEMORY_TYPES and VALID_CATEGORIES

**Expected outcome:**
- [ ] No `extractByRegex` function exists
- [ ] `extractByLLM` is the only exported extraction function
- [ ] LLM errors propagate (throw) -- caller must handle
- [ ] Invalid JSON from LLM throws an error
- [ ] Cap at 20 items per conversation
- [ ] Invalid memoryType defaults to 'knowledge'; invalid category defaults via `defaultCategoryForType`

**Pass/Fail:** _pending_

---

### ST-12: Summary prompt templates match memU format

**Criterion:** "LLM prompt templates for generating and updating category summaries, adapted from memU's category_summary/category.py" (Plan, lines 1192-1195)
**Plan reference:** `2026-03-02-memoryfs-v2-plan.md`, Task 7: Summary Generator Prompts

**Verification steps:**
1. Read `src/providers/memory/memoryfs/prompts.ts`
2. Check exports: `buildSummaryPrompt`, `buildSummaryPromptWithRefs`, `buildPatchPrompt`, `parsePatchResponse`
3. Verify `buildSummaryPrompt` includes category name, target length, original content, new items
4. Verify `buildSummaryPromptWithRefs` includes `[ref:ITEM_ID]` instructions
5. Verify `parsePatchResponse` handles malformed JSON gracefully

**Expected outcome:**
- [ ] All four functions exported
- [ ] Summary prompt includes workflow steps and output format
- [ ] Ref prompt instructs model to use `[ref:ITEM_ID]` format
- [ ] Patch response parser returns `{ needUpdate: false }` for invalid JSON

**Pass/Fail:** _pending_

---

### ST-13: Default category mapping covers all six memory types

**Criterion:** "Default category mapping by memory type" (Plan, lines 1161-1170)
**Plan reference:** `2026-03-02-memoryfs-v2-plan.md`, Task 6

**Verification steps:**
1. Read `src/providers/memory/memoryfs/extractor.ts`
2. Find `defaultCategoryForType` function
3. Check all 6 types map to valid categories:
   - profile -> personal_info
   - event -> experiences
   - knowledge -> knowledge
   - behavior -> habits
   - skill -> knowledge
   - tool -> work_life

**Expected outcome:**
- [ ] All 6 memory types have a mapping
- [ ] All mapped categories are in DEFAULT_CATEGORIES
- [ ] Switch is exhaustive (no default case needed)

**Pass/Fail:** _pending_

---

### ST-14: Write path deduplicates via content hash

**Criterion:** "Dedup: reinforce if same content exists" (Plan, lines 1647-1651)
**Plan reference:** `2026-03-02-memoryfs-v2-plan.md`, Task 8: Provider

**Verification steps:**
1. Read `src/providers/memory/memoryfs/provider.ts`
2. In `write()`, check that it calls `computeContentHash()` then `store.findByHash()`
3. If hash exists: calls `store.reinforce()` and returns existing ID
4. If hash doesn't exist: calls `store.insert()` with new item

**Expected outcome:**
- [ ] `write()` computes content hash before insert
- [ ] Existing hash match -> reinforce + return existing ID
- [ ] No duplicate rows created for identical content

**Pass/Fail:** _pending_

---

### ST-15: Memorize pipeline follows plan's data flow

**Criterion:** "conversation --> Extract --> Dedup/Reinforce --> Categorize --> Write items to SQLite --> Update category summary .md files" (Plan, lines 39-46)
**Plan reference:** `2026-03-02-memoryfs-v2-plan.md`, Data flow

**Verification steps:**
1. Read `src/providers/memory/memoryfs/provider.ts`, `memorize()` function
2. Verify step 1: extraction via `extractByLLM()` (no regex fallback)
3. Verify step 2: for each candidate, findByHash -> reinforce or insert
4. Verify step 3: update category summaries (LLM or bullet-append fallback)
5. Verify step 4: generate embeddings for new items (non-blocking batch)
6. Verify that LLM extraction failure propagates as an error (not silently swallowed)

**Expected outcome:**
- [ ] Step 1: Calls `extractByLLM()` only -- no `extractByRegex` import or fallback
- [ ] Step 2: Dedup loop checks `findByHash`, reinforces or inserts
- [ ] Step 3: Updates summary files grouped by category
- [ ] Step 4: Embeds new items via `embeddingClient.embed()` and stores in `embeddingStore`
- [ ] Empty conversations short-circuit (early return)
- [ ] LLM extraction errors propagate -- `memorize()` rejects with the extraction error

**Pass/Fail:** _pending_

---

### ST-16: Embeddings generated on write()

**Criterion:** New entries must be embedded for fast semantic retrieval
**Plan reference:** Implementation requirement -- embeddings are the primary retrieval mechanism

**Verification steps:**
1. Read `src/providers/memory/cortex/provider.ts`, `write()` function
2. Check that after inserting a new item, embedding is generated and stored
3. Verify `embedItem()` or `embeddingStore.upsert()` is awaited (not fire-and-forget)
4. Verify embedding errors propagate to the caller

**Expected outcome:**
- [ ] `write()` awaits `embedItem()` or `embeddingStore.upsert()` after insert
- [ ] `embedItem` generates a vector via `embeddingClient.embed()`
- [ ] Vector stored via `embeddingStore.upsert(itemId, scope, vector)`
- [ ] Embedding storage is synchronous — completes before `write()` returns

**Pass/Fail:** _pending_

---

### ST-17: Embeddings generated on memorize()

**Criterion:** Extracted items from conversations must be embedded for later recall
**Plan reference:** Implementation requirement -- memorize path must create searchable embeddings

**Verification steps:**
1. Read `src/providers/memory/cortex/provider.ts`, `memorize()` function (Step 4)
2. Check that new items (not deduped) are batch-embedded
3. Verify `embeddingClient.embed(newItems.map(i => i.content))` is awaited
4. Verify each vector stored via awaited `embeddingStore.upsert()`

**Expected outcome:**
- [ ] New items collected during dedup loop into `newItems` array
- [ ] Batch embedding: `embeddingClient.embed()` called with all new item contents
- [ ] Each embedding stored: `embeddingStore.upsert(id, scope, vector)`
- [ ] Embedding storage is awaited — completes before `memorize()` returns
- [ ] Skipped if `embeddingClient.available` is false

**Pass/Fail:** _pending_

---

### ST-18: EmbeddingStore schema and vector search

**Criterion:** Vector storage must support scoped nearest-neighbor search for memory recall
**Plan reference:** Implementation requirement -- the foundation for semantic retrieval

**Verification steps:**
1. Read `src/providers/memory/memoryfs/embedding-store.ts`
2. Check three tables created: `embedding_meta`, `item_embeddings` (vec0), `embedding_rowmap`
3. Check `findSimilar()` supports scoped search (brute-force L2 on `embedding_meta` filtered by scope)
4. Check unscoped search uses vec0 `MATCH` operator
5. Check `upsert()` stores vector in both vec0 table and `embedding_meta.embedding` BLOB

**Expected outcome:**
- [ ] `embedding_meta` table: item_id (PK), scope, created_at, embedding (BLOB)
- [ ] `item_embeddings` table: vec0 virtual table with `float[N]` column
- [ ] `embedding_rowmap` table: maps vec0 rowid to item_id
- [ ] Scoped search: `vec_distance_l2(embedding, ?) ... WHERE scope = ?` on embedding_meta
- [ ] Unscoped search: `WHERE embedding MATCH ? ORDER BY distance` on vec0
- [ ] Graceful degradation: `_available = false` if sqlite-vec fails to load

**Pass/Fail:** _pending_

---

### ST-19: Query supports embedding-based semantic search path

**Criterion:** `query()` must use embedding vectors for semantic retrieval when provided
**Plan reference:** Implementation requirement -- semantic search is the preferred retrieval path

**Verification steps:**
1. Read `src/providers/memory/memoryfs/provider.ts`, `query()` function
2. Check for `if (q.embedding)` branch that uses `embeddingStore.findSimilar()`
3. Check that similarity is computed as `1 / (1 + distance)` from L2 distance
4. Check that results are ranked by salience score incorporating similarity
5. Check fallback to keyword search when embedding path fails or no embedding provided

**Expected outcome:**
- [ ] `q.embedding` triggers embedding-based search path
- [ ] Calls `embeddingStore.findSimilar(q.embedding, limit, scope)`
- [ ] Retrieves full items from `store.getByIds()`
- [ ] Similarity = `1 / (1 + distance)` fed into `salienceScore()`
- [ ] Salience combines similarity, reinforcement, and recency
- [ ] Falls through to keyword search on error (graceful degradation)

**Pass/Fail:** _pending_

---

### ST-20: MemoryQuery interface accepts embedding vector

**Criterion:** The provider contract must support passing pre-computed embeddings for semantic search
**Plan reference:** `src/providers/memory/types.ts`

**Verification steps:**
1. Read `src/providers/memory/types.ts`
2. Check `MemoryQuery` interface has an `embedding?: Float32Array` field

**Expected outcome:**
- [ ] `MemoryQuery.embedding` field exists with type `Float32Array`
- [ ] Field is optional (providers that don't support it can ignore it)

**Pass/Fail:** _pending_

---

### ST-21: Memory recall module exists and embeds user prompt

**Criterion:** Host process must embed the user's message and query memory before the agent starts
**Plan reference:** `src/host/memory-recall.ts`, `src/host/server-completions.ts`

**Verification steps:**
1. Read `src/host/memory-recall.ts`
2. Check `recallMemoryForMessage()` function exists
3. Check Strategy 1: embeds user message via `config.embeddingClient.embed([userMessage])`
4. Check query passes `embedding` field: `memory.query({ scope, embedding, limit })`
5. Check Strategy 2 fallback: `extractQueryTerms()` for keyword search
6. Check formatting: `formatMemoryTurns()` produces user/assistant turn pair
7. Read `src/host/server-completions.ts` around line 332
8. Check recall result is prepended: `history.unshift(...recallTurns)`
9. Check that empty embedding results fall through to keyword search with a `logger.warn`

**Expected outcome:**
- [ ] `recallMemoryForMessage()` embeds user message when `embeddingClient.available`
- [ ] Passes `Float32Array` embedding to `memory.query()` for semantic search
- [ ] Falls back to keyword extraction when no embedding client
- [ ] Falls back to keyword extraction when embedding search returns empty (with `logger.warn('memory_recall_embedding_empty')`)
- [ ] Formats results as `[Long-term memory recall -- N relevant memories...]`
- [ ] Returns user/assistant turn pair for context injection
- [ ] `server-completions.ts` calls recall and does `history.unshift(...)` to prepend

**Pass/Fail:** _pending_

---

### ST-22: Memory recall is configurable and wildcard scope works

**Criterion:** Recall behavior must be configurable (enable/disable, limit, scope), and wildcard scope must match all scopes
**Plan reference:** `src/host/memory-recall.ts`, `src/providers/memory/cortex/items-store.ts`

**Verification steps:**
1. Read `src/host/memory-recall.ts`
2. Check `MemoryRecallConfig` interface has: `enabled`, `limit`, `scope`, `embeddingClient?`
3. Check defaults: `enabled: false`, `limit: 5`, `scope: '*'`
4. Read `src/host/server-completions.ts`
5. Check config wired from `config.history.memory_recall`, `memory_recall_limit`, `memory_recall_scope`
6. Read `src/providers/memory/cortex/items-store.ts`
7. Check `listByScope()` and `searchContent()` treat `'*'` as a wildcard (omit scope filter) not a literal string match

**Expected outcome:**
- [ ] `enabled: false` by default (opt-in)
- [ ] `limit: 5` default max entries
- [ ] `scope: '*'` default searches all scopes
- [ ] Short-circuits with empty array when `!config.enabled`
- [ ] Config sourced from `config.history.*` fields
- [ ] `listByScope('*', ...)` returns items from all scopes (no `WHERE scope = '*'` literal match)
- [ ] `searchContent(query, '*', ...)` searches across all scopes

**Pass/Fail:** _pending_

---

### ST-23: Embedding backfill on startup

**Criterion:** Items created before embedding client was available must be backfilled
**Plan reference:** `src/providers/memory/memoryfs/provider.ts`

**Verification steps:**
1. Read `src/providers/memory/memoryfs/provider.ts`, `create()` function
2. Check `backfillEmbeddings()` called after store initialization
3. Check it's non-blocking: `.catch(err => logger.warn(...))`
4. Read `backfillEmbeddings()` function
5. Check it iterates all scopes, finds unembedded items, processes in batches

**Expected outcome:**
- [ ] `backfillEmbeddings(store, embeddingStore, embeddingClient)` called in `create()`
- [ ] Non-blocking: called with `.catch()`, doesn't block provider readiness
- [ ] Iterates `store.listAllScopes()` to find all scopes
- [ ] Uses `embeddingStore.listUnembedded(allIds)` to find gaps
- [ ] Processes in batches of 50 (configurable)
- [ ] Skipped if `!client.available`

**Pass/Fail:** _pending_

---

### ST-24: Memorize called automatically after every completion

**Criterion:** Conversations must be automatically memorized, not just on explicit "remember" requests
**Plan reference:** `src/host/server-completions.ts`

**Verification steps:**
1. Read `src/host/server-completions.ts`
2. Search for `providers.memory.memorize` call
3. Check it passes the full conversation: client messages + agent response
4. Check it runs after the completion finishes (not blocking the response)

**Expected outcome:**
- [ ] `providers.memory.memorize` called if `memorize` method exists
- [ ] Passes full conversation history including agent's response
- [ ] Wrapped in try/catch (failure doesn't crash the server)
- [ ] Runs after completion, not blocking the response stream

**Pass/Fail:** _pending_

---

### ST-25: SummaryStore interface and dual implementations

**Criterion:** Pluggable summary storage — FileSummaryStore for local/SQLite, DbSummaryStore for PostgreSQL/k8s
**Plan reference:** `docs/plans/2026-03-06-cortex-summary-storage.md`

**Verification steps:**
1. Read `src/providers/memory/cortex/summary-store.ts`
2. Check `SummaryStore` interface exports: `read`, `write`, `list`, `readAll`, `initDefaults`
3. Check `SUMMARY_ID_PREFIX` is exported as `'summary:'`
4. Check `FileSummaryStore` implements `SummaryStore` using `safePath` for all paths
5. Check `DbSummaryStore` implements `SummaryStore` using `cortex_summaries` table
6. Check `DbSummaryStore` uses `'__shared__'` sentinel for non-user-scoped summaries (avoids NULL in unique index)
7. Check `DbSummaryStore.write()` uses `ON CONFLICT DO UPDATE` (race-free upsert)
8. Check `DbSummaryStore.initDefaults()` uses `ON CONFLICT DO NOTHING` (idempotent)

**Expected outcome:**
- [ ] `SummaryStore` interface has 5 methods
- [ ] `SUMMARY_ID_PREFIX = 'summary:'` exported
- [ ] `FileSummaryStore` uses `safePath` for all file operations
- [ ] `DbSummaryStore` uses `__shared__` default, not NULL
- [ ] `DbSummaryStore.write()` is upsert (ON CONFLICT DO UPDATE)
- [ ] `DbSummaryStore.initDefaults()` is idempotent (ON CONFLICT DO NOTHING)

**Pass/Fail:** _pending_

---

### ST-26: cortex_summaries migration creates table with correct schema

**Criterion:** Database migration creates `cortex_summaries` table for k8s summary persistence
**Plan reference:** `docs/plans/2026-03-06-cortex-summary-storage.md`

**Verification steps:**
1. Read `src/providers/memory/cortex/migrations.ts`
2. Check `memory_002_summaries` migration exists
3. Check table has columns: `category` (TEXT NOT NULL), `user_id` (TEXT NOT NULL DEFAULT '__shared__'), `content` (TEXT NOT NULL), `updated_at` (TEXT NOT NULL)
4. Check unique index `idx_summaries_pk` on `(category, user_id)`

**Expected outcome:**
- [ ] `memory_002_summaries` migration exists
- [ ] Table name is `cortex_summaries`
- [ ] `user_id` defaults to `'__shared__'` (NOT NULL)
- [ ] Unique composite index on `(category, user_id)` exists

**Pass/Fail:** _pending_

---

### ST-27: Provider selects SummaryStore based on database type

**Criterion:** Provider uses DbSummaryStore for non-SQLite databases, FileSummaryStore for SQLite/standalone
**Plan reference:** `docs/plans/2026-03-06-cortex-summary-storage.md`

**Verification steps:**
1. Read `src/providers/memory/cortex/provider.ts`
2. Check `create()` function: `database && database.type !== 'sqlite' ? new DbSummaryStore(database.db) : new FileSummaryStore(memoryDir)`
3. Check `updateCategorySummary()` takes `SummaryStore` (not `memoryDir: string`)
4. Verify no remaining imports from `summary-io.ts` (file was deleted)

**Expected outcome:**
- [ ] Provider uses `DbSummaryStore` when `database.type !== 'sqlite'`
- [ ] Provider uses `FileSummaryStore` when database is SQLite or absent
- [ ] `updateCategorySummary` uses `SummaryStore` interface
- [ ] No references to deleted `summary-io.ts`

**Pass/Fail:** _pending_

---

### ST-28: query() appends summaries after items and guards summary IDs

**Criterion:** Summaries appear as trailing results in keyword/listing queries; embedding queries skip summaries; read()/delete() reject summary IDs
**Plan reference:** `docs/plans/2026-03-06-cortex-summary-storage.md`

**Verification steps:**
1. Read `src/providers/memory/cortex/provider.ts`, `query()` function
2. Check keyword path: items ranked by salience first, then summaries appended filling remaining `limit` slots
3. Check embedding path: returns items only, no summaries
4. Check summary entries use `SUMMARY_ID_PREFIX + category` as ID
5. Check summaries with content matching `# ${category}` (empty defaults) are skipped
6. Check `read()`: returns `null` for IDs starting with `SUMMARY_ID_PREFIX`
7. Check `delete()`: returns early (no-op) for IDs starting with `SUMMARY_ID_PREFIX`

**Expected outcome:**
- [ ] Keyword queries return `[...itemResults, ...summaryEntries]` (items first)
- [ ] Embedding queries return items only (no summary append)
- [ ] Summary entries have `id: 'summary:<category>'`
- [ ] Empty default summaries (`# category`) are skipped
- [ ] `read('summary:knowledge')` returns `null`
- [ ] `delete('summary:knowledge')` is a no-op

**Pass/Fail:** _pending_

---

### ST-16-old: Query results ranked by salience score

**Criterion:** "Rank by salience --> Reinforce accessed items --> return" (Plan, lines 56-58)
**Plan reference:** `2026-03-02-memoryfs-v2-plan.md`, Read path data flow

(Renumbered from original ST-16; moved after embedding tests)

**Verification steps:**
1. Read `src/providers/memory/memoryfs/provider.ts`, `query()` function
2. Check that results (both embedding and keyword paths) are mapped through `salienceScore()`
3. Check that results are sorted by score descending
4. Check whether accessed items are reinforced (plan says they should be)

**Expected outcome:**
- [ ] Each item gets a salience score computed via `salienceScore()`
- [ ] Results sorted by `b.score - a.score` (descending)
- [ ] Results sliced to `limit`

**Deviation check:**
- [ ] Plan specifies "Reinforce accessed items" in read path -- verify if `query()` calls `store.reinforce()` on returned items

**Pass/Fail:** _pending_

---

### ST-17-old: Taint tags preserved through write/read round-trip

**Criterion:** "Content from extraction gets taint-tagged when source is external" (Plan, Security Checklist)
**Plan reference:** `2026-03-02-memoryfs-v2-plan.md`, Security Checklist

**Verification steps:**
1. Read `src/providers/memory/memoryfs/provider.ts`
2. Check `write()` serializes taint: `JSON.stringify(entry.taint)`
3. Check `read()`, `query()`, `list()` deserialize taint: `JSON.parse(item.taint)`

**Expected outcome:**
- [ ] `write()` stores taint as JSON string
- [ ] `read()` parses taint back to object
- [ ] `query()` parses taint back to object
- [ ] `list()` parses taint back to object

**Pass/Fail:** _pending_

---

### ST-18-old: Zero new npm dependencies

**Criterion:** "Zero new dependencies" (Plan, line 2020)
**Plan reference:** `2026-03-02-memoryfs-v2-plan.md`, Dependencies section

**Verification steps:**
1. Read `src/providers/memory/memoryfs/provider.ts` imports
2. Verify all imports resolve to existing modules:
   - `src/utils/sqlite.ts` (existing)
   - `src/utils/safe-path.ts` (existing)
   - `src/paths.ts` (existing)
   - `node:crypto` (built-in)
   - `node:fs/promises` (built-in)
3. Check that `better-sqlite3`, `sqlite-vec`, and `openai` were already in `package.json` before memoryfs

**Expected outcome:**
- [ ] No new npm packages added specifically for memoryfs
- [ ] `better-sqlite3`, `sqlite-vec` were pre-existing dependencies (used by embedding-store)
- [ ] `openai` was pre-existing (used by embedding-client)

**Pass/Fail:** _pending_

---

## Behavioral Tests

### BT-1: Explicit memory request via LLM extraction

**Criterion:** LLM extractor identifies user preferences and stores them as memory items
**Plan reference:** `2026-03-02-memoryfs-v2-plan.md`, Task 6

**Setup:**
- AX server running with `memory: cortex` configured
- LLM provider available (required for extraction)
- Fresh session ID

**Chat script:**
1. Send: `Remember that I prefer dark mode in all my editors`
   Expected behavior: Agent acknowledges and stores the preference
   Structural check: Query memory for "dark mode" returns at least 1 result

2. Send: `What do you know about my editor preferences?`
   Expected behavior: Agent recalls the dark mode preference
   Structural check: Memory was queried (visible in audit log)

**Expected outcome:**
- [ ] Agent response in step 1 acknowledges remembering
- [ ] Agent response in step 2 references dark mode preference
- [ ] Memory store contains item with content about dark mode
- [ ] LLM was used for extraction (not regex patterns)
- [ ] Summary file updated with dark mode preference

**Pass/Fail:** _pending_

---

### BT-2: Deduplication on repeated facts

**Criterion:** "Dedup/Reinforce" -- duplicate content increments reinforcement instead of creating new row
**Plan reference:** `2026-03-02-memoryfs-v2-plan.md`, Data flow

**Setup:**
- AX server running with `memory: cortex`
- Fresh session ID

**Chat script:**
1. Send: `Remember that I use TypeScript for all my projects`
   Expected behavior: Agent stores the fact
   Structural check: One item in memory matching "TypeScript"

2. Send: `Remember that I use TypeScript for all my projects`
   Expected behavior: Agent acknowledges (may say "already noted")
   Structural check: Still only one item matching "TypeScript", but reinforcement_count > 1

**Expected outcome:**
- [ ] After step 1: exactly 1 item with "TypeScript" content
- [ ] After step 2: still exactly 1 item (no duplicate)
- [ ] Reinforcement count increased
- [ ] `last_reinforced_at` timestamp updated

**Pass/Fail:** _pending_

---

### BT-3: Scope isolation between projects

**Criterion:** "Scope isolation: every query scoped by scope, no cross-scope leaks" (Plan, Security Checklist)
**Plan reference:** `2026-03-02-memoryfs-v2-plan.md`, Security Checklist

**Setup:**
- AX server running with `memory: cortex`
- Two different scope values

**Chat script:**
1. Write to scope "project-alpha": `"Uses React with Next.js"`
   Structural check: Item exists in scope "project-alpha"

2. Write to scope "project-beta": `"Uses Vue with Nuxt"`
   Structural check: Item exists in scope "project-beta"

3. Query scope "project-alpha" for all items
   Expected: Only "React" item returned, not "Vue"

4. Query scope "project-beta" for all items
   Expected: Only "Vue" item returned, not "React"

**Expected outcome:**
- [ ] Each scope contains only its own items
- [ ] Cross-scope queries return no results from other scopes
- [ ] No data leakage between scopes

**Pass/Fail:** _pending_

---

### BT-4: Summary creation on memorize

**Criterion:** Memorize pipeline must update category summaries via LLM
**Plan reference:** `2026-03-02-memoryfs-v2-plan.md`, Data flow; updated by `2026-03-06-cortex-summary-storage.md`

**Setup:**
- AX server running with `memory: cortex`
- Fresh memory directory

**Chat script:**
1. Send: `Remember that I prefer VS Code with vim keybindings`
   Expected behavior: Agent stores the preference
   Structural check (local): A summary `.md` file in the memory directory contains the preference
   Structural check (k8s): `cortex_summaries` table has a row with content about vim keybindings
   Structural check (either): Query `{ scope: "default" }` returns a summary entry (ID starts with `summary:`) with relevant content

**Expected outcome:**
- [ ] Summary contains content about vim keybindings or VS Code
- [ ] Summary follows memU format: `# category_name` heading with bullet items
- [ ] Summary visible in query results (see BT-10 for full verification)

**Pass/Fail:** _pending_

---

### BT-5: Direct write/read/delete API round-trip

**Criterion:** "MemoryProvider interface: write, query, read, delete, list" (Plan, Task 8)
**Plan reference:** `2026-03-02-memoryfs-v2-plan.md`, Task 8

**Setup:**
- AX server running with `memory: cortex`

**Chat script:**
1. Write via API: `{ scope: "test", content: "Test fact for round-trip" }`
   Structural check: Returns a non-empty ID string

2. Read via API with returned ID
   Structural check: Returns entry with matching content

3. Delete via API with same ID
   Structural check: Subsequent read returns null

**Expected outcome:**
- [ ] `write()` returns a UUID string
- [ ] `read(id)` returns entry with correct content and scope
- [ ] `delete(id)` removes the entry
- [ ] `read(id)` after delete returns null

**Pass/Fail:** _pending_

---

### BT-6: Taint tag preservation

**Criterion:** "Content from extraction gets taint-tagged when source is external" (Plan, Security Checklist)
**Plan reference:** `2026-03-02-memoryfs-v2-plan.md`, Security Checklist

**Setup:**
- AX server running with `memory: cortex`

**Chat script:**
1. Write via API: `{ scope: "test", content: "External fact", taint: { source: "web", trust: "external", timestamp: "2026-03-03T00:00:00Z" } }`
   Structural check: Returns an ID

2. Read via API with returned ID
   Structural check: Entry has taint with source "web" and trust "external"

**Expected outcome:**
- [ ] Taint tag stored as JSON in SQLite
- [ ] Taint tag deserialized correctly on read
- [ ] `taint.source` = "web", `taint.trust` = "external"

**Pass/Fail:** _pending_

---

### BT-7: Memorize fails with error when LLM extraction fails

**Criterion:** If LLM extraction fails (including fallback models), `memorize()` must return an error, not silently succeed with no extractions
**Plan reference:** Updated design decision -- no regex fallback

**Setup:**
- AX server running with `memory: cortex`
- LLM provider configured but made to fail (e.g., invalid API key, model unavailable, or mock that throws)

**Chat script:**
1. Call memorize with conversation:
   ```
   user: "Remember that I prefer dark mode"
   ```
   Expected: `memorize()` rejects with an error (not resolves with empty result)

2. Query memory for "dark mode"
   Expected: No items found (nothing was stored because extraction failed)

**Expected outcome:**
- [ ] `memorize()` throws/rejects when LLM extraction fails
- [ ] Error message indicates extraction failure (not a generic error)
- [ ] No items stored in SQLite (extraction failure = no partial writes)
- [ ] No silent degradation to regex patterns

**Pass/Fail:** _pending_

---

### BT-8: Embedding generated on write and queryable (was BT-7)

**Criterion:** New entries must be embedded so they can be found via semantic search
**Plan reference:** Implementation requirement

**Setup:**
- AX server running with `memory: cortex`
- OPENAI_API_KEY set (embedding client available)

**Chat script:**
1. Write via API: `{ scope: "test", content: "The project uses PostgreSQL for the main database" }`
   Structural check: Returns an ID

2. Query via embedding: embed the text "What database does the project use?" and pass resulting vector to `query({ scope: "test", embedding: <vector> })`
   Expected: Returns the PostgreSQL entry (semantic match, not keyword)
   Note: No delay needed — write() awaits embedding storage before returning

3. Query via embedding: embed unrelated text "What color is the sky?" and query
   Expected: Either no results or very low-relevance results

**Expected outcome:**
- [ ] Write succeeds and embedding is stored before write returns
- [ ] Semantic query for related concept finds the entry immediately (no delay needed)
- [ ] Unrelated semantic query does not return the entry (or ranks it very low)
- [ ] Entry in `_vec.db` confirmed via `embeddingStore.hasEmbedding(id)`

**Pass/Fail:** _pending_

---

### BT-9: Long-term memory recall injects context into conversation

**Criterion:** Recalled memories must be automatically prepended to conversation history based on the user's current prompt
**Plan reference:** `src/host/memory-recall.ts`, `src/host/server-completions.ts`

**Setup:**
- AX server running with `memory: cortex`
- `memory_recall: true` in config
- OPENAI_API_KEY set (for embedding)
- Previously stored memories about a specific topic (e.g., "The user prefers Python for data science")

**Chat script:**
1. First session: Store memories
   Send: `Remember that I always use Python with pandas for data analysis`
   Note: memorize() awaits embedding storage — no delay needed before next session

2. New session (different session ID): Ask about the topic
   Send: `I need to analyze some CSV data, what tools should I use?`
   Expected behavior: Agent's response references Python/pandas (recalled from memory)
   Structural check: Audit log shows `memory_recall_hit` with strategy `embedding`

3. Verify context injection
   Structural check: The conversation history sent to the agent begins with
   `[Long-term memory recall -- N relevant memories from past sessions]`

**Expected outcome:**
- [ ] Memory from session 1 is recalled in session 2
- [ ] Agent response incorporates recalled memory (mentions Python/pandas)
- [ ] Recall happens automatically -- user did not ask agent to search memory
- [ ] Log shows `memory_recall_hit` with `strategy: 'embedding'`
- [ ] Recalled memories are the FIRST turns in the conversation (prepended)

**Pass/Fail:** _pending_

---

### BT-10: Summaries appear in query results after items

**Criterion:** Keyword/listing queries must return items first, then summaries filling remaining `limit` slots
**Plan reference:** `docs/plans/2026-03-06-cortex-summary-storage.md`

**Setup:**
- AX server running with `memory: cortex`
- LLM provider available (required for summary generation)
- Session ID: `acceptance:cortex:bt10`

**Chat script:**
1. Store a specific fact via chat: `"Remember that my favorite programming language is Rust"`
   Wait for memorize to complete (check log for `memorize` entry)

2. Query via memory tool or API: `{ scope: "default", query: "programming language" }`
   Expected: Results include item(s) about Rust AND at least one summary entry
   Structural check: Item results appear first (no `summary:` prefix in ID), summary results appear after (ID starts with `summary:`)

3. Query with very small limit: `{ scope: "default", query: "programming language", limit: 1 }`
   Expected: Returns only the item (the most specific hit), not a summary
   Rationale: Items take priority over summaries when limit is tight

**Expected outcome:**
- [ ] Query returns items before summaries
- [ ] Summary entries have IDs starting with `summary:`
- [ ] Summary content is human-readable markdown (not raw JSON)
- [ ] Limit=1 returns the most relevant item, not a summary
- [ ] Empty default summaries (just `# category_name`) are NOT returned

**Pass/Fail:** _pending_

---

### BT-11: Summary IDs rejected by read() and delete()

**Criterion:** `read()` and `delete()` must gracefully handle synthetic summary IDs
**Plan reference:** `docs/plans/2026-03-06-cortex-summary-storage.md`

**Setup:**
- AX server running with `memory: cortex`
- At least one summary exists (from prior memorization)

**Chat script:**
1. Query to get a summary entry: `{ scope: "default" }`
   Find an entry with ID starting with `summary:` (e.g., `summary:knowledge`)

2. Attempt to read it: `read("summary:knowledge")`
   Expected: Returns `null` (not an error)

3. Attempt to delete it: `delete("summary:knowledge")`
   Expected: No error, no crash, no-op

4. Re-query: summaries still appear in results (delete was a no-op)

**Expected outcome:**
- [ ] `read()` returns `null` for summary IDs (not an error)
- [ ] `delete()` is a no-op for summary IDs (not an error)
- [ ] Summaries persist after attempted delete

**Pass/Fail:** _pending_

---

### BT-12: Embedding queries skip summaries

**Criterion:** Embedding-based semantic search returns only items, not summaries
**Plan reference:** `docs/plans/2026-03-06-cortex-summary-storage.md`

**Setup:**
- AX server running with `memory: cortex`
- OPENAI_API_KEY or equivalent set (embedding client available)
- Existing items and summaries in memory

**Chat script:**
1. Store facts via chat: `"Remember that we use Docker for containerization"`
   Wait for memorize + embedding storage

2. Embed query text "containerization" and pass vector: `query({ scope: "default", embedding: <vector> })`
   Expected: Returns item(s) about Docker -- NO summary entries in results

3. Same query without embedding: `query({ scope: "default", query: "containerization" })`
   Expected: Returns items AND summaries (keyword path appends summaries)

**Expected outcome:**
- [ ] Embedding query returns items only (no `summary:` IDs in results)
- [ ] Keyword query for same term returns items + summaries
- [ ] Embedding path is not degraded by summary logic

**Pass/Fail:** _pending_

---

## Integration Tests

### IT-1: Full memorize -> query -> reinforcement lifecycle

**Criterion:** "Full lifecycle: memorize -> query -> reinforcement" (Plan, data flow)
**Plan reference:** `2026-03-02-memoryfs-v2-plan.md`, Data flow (lines 39-58)

**Setup:**
- AX server running with `memory: cortex`
- LLM provider available (required for extraction)
- Session ID: `acceptance-memoryfs-v2-IT-1`

**Sequence:**
1. [Memorize conversation]
   Action: Call memorize with conversation:
   ```
   user: "Remember that I prefer dark mode in all editors"
   assistant: "Noted!"
   user: "I always run tests before committing"
   ```
   Verify: LLM extraction called, items stored in SQLite -- at least 2 items (dark mode + tests)

2. [Query for dark mode]
   Action: Query with `{ scope: "default", query: "dark mode" }`
   Verify: At least 1 result containing "dark mode"

3. [Query for tests]
   Action: Query with `{ scope: "default", query: "tests" }`
   Verify: At least 1 result containing "tests"

4. [Memorize same fact again]
   Action: Call memorize with:
   ```
   user: "Remember that I prefer dark mode in all editors"
   ```
   Verify: No new item created; existing item's reinforcement_count incremented

5. [Check summary state]
   Action: Query with broad keyword to retrieve summaries: `{ scope: "default" }`
   Verify: At least one summary entry (ID starts with `summary:`) contains relevant content
   Alternative: For local env, read summary `.md` files in memory directory

**Expected final state:**
- [ ] SQLite contains exactly 2 unique items (not 3, due to dedup)
- [ ] Dark mode item has reinforcement_count >= 2
- [ ] Summaries contain relevant content (visible in query results as `summary:*` entries)
- [ ] Default categories initialized (all 10)

**Pass/Fail:** _pending_

---

### IT-2: Multi-scope isolation end-to-end

**Criterion:** "Scope isolation: every query scoped by scope" + "Agent isolation: agentId filtering" (Plan, Security Checklist)
**Plan reference:** `2026-03-02-memoryfs-v2-plan.md`, Security Checklist

**Setup:**
- AX server running with `memory: cortex`
- Session ID: `acceptance-memoryfs-v2-IT-2`

**Sequence:**
1. [Write to scope A]
   Action: Write `{ scope: "project-x", content: "Uses React" }`
   Verify: Returns ID-A

2. [Write to scope B]
   Action: Write `{ scope: "project-y", content: "Uses Vue" }`
   Verify: Returns ID-B

3. [Write to scope A with agentId]
   Action: Write `{ scope: "project-x", content: "Agent-specific fact", agentId: "agent-1" }`
   Verify: Returns ID-C

4. [Query scope A -- no agentId filter]
   Action: Query `{ scope: "project-x" }`
   Verify: Returns 2 items (React + agent-specific)

5. [Query scope A -- with agentId filter]
   Action: Query `{ scope: "project-x", agentId: "agent-1" }`
   Verify: Returns only 1 item (agent-specific)

6. [Query scope B]
   Action: Query `{ scope: "project-y" }`
   Verify: Returns only 1 item (Vue), no leakage from scope A

**Expected final state:**
- [ ] Scope A has 2 items, scope B has 1 item
- [ ] AgentId filtering returns only matching items
- [ ] No cross-scope data leakage

**Pass/Fail:** _pending_

---

### IT-3: Content hash deduplication across conversations

**Criterion:** "Content-hash deduplication and reinforcement counting" (Plan, lines 8-9, 100)
**Plan reference:** `2026-03-02-memoryfs-v2-plan.md`, Design Decisions

**Setup:**
- AX server running with `memory: cortex`
- Session ID: `acceptance-memoryfs-v2-IT-3`

**Sequence:**
1. [Write fact A]
   Action: Write `{ scope: "default", content: "Prefers TypeScript over JavaScript" }`
   Verify: Returns ID-A, item has reinforcement_count = 10 (explicit write boost)

2. [Write same fact with different whitespace]
   Action: Write `{ scope: "default", content: "  Prefers   TypeScript   over   JavaScript  " }`
   Verify: Returns same ID-A (dedup via normalized hash), reinforcement incremented

3. [Write same fact with different case]
   Action: Write `{ scope: "default", content: "PREFERS TYPESCRIPT OVER JAVASCRIPT" }`
   Verify: Returns same ID-A (dedup via lowercase normalization)

4. [Verify single item]
   Action: List scope "default"
   Verify: Exactly 1 item, reinforcement_count >= 11

5. [Write different fact with same type]
   Action: Write `{ scope: "default", content: "Prefers JavaScript over Python" }`
   Verify: Returns different ID-B (different content = different hash)

**Expected final state:**
- [ ] Only 2 items in scope "default" (TypeScript fact + JavaScript fact)
- [ ] TypeScript fact reinforced multiple times
- [ ] Content hash is deterministic regardless of whitespace/case

**Pass/Fail:** _pending_

---

### IT-4: Default category initialization on provider create

**Criterion:** `initDefaults()` creates defaults for all 10 categories via the active SummaryStore
**Plan reference:** `2026-03-02-memoryfs-v2-plan.md`, Task 4; updated by `2026-03-06-cortex-summary-storage.md`

**Setup:**
- Fresh memory directory (no prior state)
- AX server starts with `memory: cortex`

**Sequence:**
1. [Provider creates default categories]
   Action: Start provider (or verify post-startup)
   Verify: Memory directory exists (local) or `cortex_summaries` table has rows (k8s)

2. [Check category defaults — local env]
   Action: List `.md` files in memory directory
   Verify: Exactly 10 `.md` files exist (excluding _store.db and _vec.db)

3. [Check category defaults — k8s env (if applicable)]
   Action: Query `cortex_summaries` table: `SELECT category FROM cortex_summaries WHERE user_id = '__shared__'`
   Verify: Exactly 10 rows, one per default category

4. [Check content]
   Action: Read each summary (file or DB row)
   Verify: Each contains `# category_name\n` as initial content

5. [Verify idempotence]
   Action: Restart provider (calls `initDefaults()` again)
   Verify: No content overwritten, existing content preserved

**Expected final state:**
- [ ] 10 default categories initialized (FileSummaryStore: `.md` files; DbSummaryStore: DB rows)
- [ ] Each starts with `# category_name`
- [ ] `initDefaults()` is idempotent (FileSummaryStore: `wx` flag; DbSummaryStore: `ON CONFLICT DO NOTHING`)

**Pass/Fail:** _pending_

---

### IT-5: Salience ranking affects query result order

**Criterion:** "Retrieval uses memU's salience formula" (Plan, line 7)
**Plan reference:** `2026-03-02-memoryfs-v2-plan.md`, Task 5 + Task 8

**Setup:**
- AX server running with `memory: cortex`
- Session ID: `acceptance-memoryfs-v2-IT-5`

**Sequence:**
1. [Write old fact]
   Action: Write fact A, then manually set its `last_reinforced_at` to 90 days ago (via direct DB update)
   Verify: Item exists with old timestamp

2. [Write recent fact]
   Action: Write fact B with current timestamp
   Verify: Item exists with fresh timestamp

3. [Write highly-reinforced old fact]
   Action: Write fact C, reinforce it 20 times, then set `last_reinforced_at` to 60 days ago
   Verify: Item has high reinforcement count

4. [Query all items with keyword matching all three]
   Action: Query with a term matching all items
   Verify: Results ordered by salience -- recent items rank higher than stale ones (unless highly reinforced)

**Expected final state:**
- [ ] Query results are NOT in insertion order
- [ ] Results reflect the salience formula (recency * log(reinforcement))
- [ ] A highly reinforced item can outrank a more recent but less reinforced one

**Pass/Fail:** _pending_

---

### IT-6: Graceful degradation without embedding support

**Criterion:** System must work without OPENAI_API_KEY or sqlite-vec
**Plan reference:** Implementation requirement for robustness

**Setup:**
- AX server running with `memory: cortex`
- No OPENAI_API_KEY set (embedding client unavailable)

**Sequence:**
1. [Write items]
   Action: Write 3 items with distinct content
   Verify: All items stored successfully (no embedding errors)

2. [Query by keyword]
   Action: Query with keyword matching one item
   Verify: Keyword search works, returns correct item

3. [List all]
   Action: List scope
   Verify: All 3 items returned

4. [Check logs for embedding warnings]
   Action: Check logs for `embed_item_failed` or `sqlite_vec_load_failed`
   Verify: Warnings are informational, no crashes

**Expected final state:**
- [ ] All CRUD operations work without embedding support
- [ ] Keyword-based search returns correct results
- [ ] No unhandled exceptions from missing embedding infrastructure
- [ ] Provider starts successfully even without sqlite-vec

**Pass/Fail:** _pending_

---

### IT-7: Write -> embed -> semantic recall across sessions

**Criterion:** Memories stored in one session must be semantically retrievable in a different session via automatic recall
**Plan reference:** `src/host/memory-recall.ts`, `src/host/server-completions.ts`

**Setup:**
- AX server running with `memory: cortex`
- OPENAI_API_KEY set
- `memory_recall: true` in config
- Two separate session IDs

**Sequence:**
1. [Session A: Store facts]
   Action: Send messages in session A:
   ```
   "Remember that our backend is written in Rust with Actix-web"
   "Remember that we deploy to AWS ECS with Fargate"
   ```
   Verify: Items stored in SQLite + embeddings generated in `_vec.db`

2. [Session B: Ask related question]
   Note: No delay needed — memorize() awaits embedding storage before returning
   Action: In a NEW session, send: `"How should I set up the deployment pipeline?"`
   Verify: Memory recall fires -- host embeds this prompt, queries `_vec.db`, finds AWS/ECS memory
   Verify: Agent response incorporates AWS ECS / Fargate context

4. [Session B: Ask unrelated question]
   Action: Send: `"What's 2 + 2?"`
   Verify: No memory recall (or irrelevant memories not injected)

**Expected final state:**
- [ ] Session A memories persist in SQLite + have embeddings in `_vec.db`
- [ ] Session B receives recalled memories as prepended context turns
- [ ] Agent in session B can reference facts it never saw directly
- [ ] Unrelated prompts don't trigger false memory recalls
- [ ] Log shows `memory_recall_hit` with `strategy: 'embedding'` for step 3

**Pass/Fail:** _pending_

---

### IT-8: Embedding backfill covers items created before embeddings were available

**Criterion:** Items created without embeddings must be backfilled on startup
**Plan reference:** `src/providers/memory/memoryfs/provider.ts`, `backfillEmbeddings()`

**Setup:**
- AX server running with `memory: cortex`
- OPENAI_API_KEY set

**Sequence:**
1. [Create items without embeddings]
   Action: Directly insert items into `_store.db` via ItemsStore (bypassing the embedding step)
   Verify: Items exist in SQLite but NOT in `_vec.db`

2. [Restart provider (or trigger backfill)]
   Action: Re-create the provider via `create(config)` (simulates server restart)
   Verify: `backfillEmbeddings()` runs in background

3. [Wait for backfill]
   Action: Wait for backfill to complete (check logs for `backfill_done`)
   Verify: Items now have embeddings in `_vec.db`

4. [Verify semantic search works]
   Action: Query with an embedding vector related to the backfilled items
   Verify: Backfilled items are now findable via semantic search

**Expected final state:**
- [ ] All items that lacked embeddings now have them in `_vec.db`
- [ ] Semantic search returns backfilled items
- [ ] Backfill logged: `backfill_start` and `backfill_done`
- [ ] Backfill is non-blocking (provider usable during backfill)

**Pass/Fail:** _pending_

---

### IT-9: Summaries survive provider restart and appear in queries

**Criterion:** Summaries written via LLM must persist across provider restarts and be retrievable in subsequent queries
**Plan reference:** `docs/plans/2026-03-06-cortex-summary-storage.md`

**Setup:**
- AX server running with `memory: cortex`
- LLM provider available
- Session ID: `acceptance:cortex:it9`

**Sequence:**
1. [Store facts to trigger summary generation]
   Action: Send messages that will be memorized:
   ```
   "Remember that our API uses GraphQL with Apollo Server"
   "Remember that we use Redis for caching"
   ```
   Wait for memorize to complete (check log for `memorize` entries)

2. [Verify summaries exist in query results]
   Action: Query `{ scope: "default" }`
   Verify: Results include summary entries (ID starts with `summary:`)
   Capture summary content for comparison

3. [Restart server]
   Action: Stop and restart the AX server (same AX_HOME)

4. [Verify summaries survive restart]
   Action: Query `{ scope: "default" }` again
   Verify: Summary entries still present with same content as step 2
   Verify: Items still present (SQLite persistence)

**Expected final state:**
- [ ] Summaries persist after server restart
- [ ] Summary content matches pre-restart content
- [ ] Items also survive restart (existing behavior)
- [ ] No data loss from restart

**Pass/Fail:** _pending_

---

### IT-10: Memorize updates summaries visible in query results

**Criterion:** The full memorize -> summarize -> query path must work end-to-end, with LLM-generated summaries visible as query results
**Plan reference:** `docs/plans/2026-03-06-cortex-summary-storage.md`

**Setup:**
- AX server running with `memory: cortex`
- LLM provider available
- Session ID: `acceptance:cortex:it10`

**Sequence:**
1. [First conversation: store initial facts]
   Action: Chat about a topic:
   ```
   user: "I'm working on a machine learning project using PyTorch"
   assistant: "That sounds great!"
   user: "We're training a transformer model for text classification"
   ```
   Wait for memorize to complete

2. [Query and check summary content]
   Action: Query `{ scope: "default", query: "machine learning" }`
   Verify: Results include items about PyTorch/transformer AND summary entry containing synthesized overview

3. [Second conversation: add more facts on same topic]
   Action: Chat more:
   ```
   user: "We switched from PyTorch to JAX for better TPU support"
   ```
   Wait for memorize to complete

4. [Query again and verify summary was updated]
   Action: Query `{ scope: "default", query: "machine learning" }`
   Verify: Summary entry now reflects BOTH conversations (mentions JAX, not just PyTorch)
   Verify: Summary is a coherent synthesis, not a raw concatenation

**Expected final state:**
- [ ] Summary content reflects information from multiple conversations
- [ ] Summary is coherent (LLM-synthesized), not raw concatenation
- [ ] Items from both conversations present in results
- [ ] Summary appears after items in result ordering

**Pass/Fail:** _pending_

---

### IT-11: User-scoped summaries separate from shared summaries

**Criterion:** Summaries for user-scoped writes must be stored separately and both scopes must appear in query results
**Plan reference:** `docs/plans/2026-03-06-cortex-summary-storage.md`

**Setup:**
- AX server running with `memory: cortex`
- LLM provider available
- Session ID: `acceptance:cortex:it11`

**Sequence:**
1. [Write shared fact]
   Action: Write `{ scope: "default", content: "Project uses Node.js 20" }` (no userId)
   Wait for summary update

2. [Write user-scoped fact]
   Action: Write `{ scope: "default", content: "I prefer vim as my editor", userId: "user-alice" }`
   Wait for summary update

3. [Query without userId]
   Action: Query `{ scope: "default" }`
   Verify: Returns shared items + shared summaries
   Verify: Does NOT return user-alice's summary

4. [Query with userId]
   Action: Query `{ scope: "default", userId: "user-alice" }`
   Verify: Returns user-alice's items + user-alice's summaries + shared summaries
   Verify: User summaries appear before shared summaries in the summary section

**Expected final state:**
- [ ] Shared writes produce shared summaries
- [ ] User-scoped writes produce user-scoped summaries
- [ ] Query with userId returns both user and shared summaries
- [ ] Query without userId returns only shared summaries
- [ ] User summaries listed before shared summaries

**Pass/Fail:** _pending_

---

## Plan Deviation Checklist

These are areas where the implementation may deviate from the plan document. Each should be explicitly verified during test execution:

### DEV-1: Read-path reinforcement

**Plan says (data flow, line 58):** "Reinforce accessed items --> return"
**Plan code (lines 1692-1693):** `for (const { item } of ranked) { store.reinforce(item.id); }`
**Check:** Does `query()` in the actual implementation call `store.reinforce()` on returned items?
**Impact:** If missing, frequently-accessed items don't get reinforcement boost, affecting salience ranking over time.

### DEV-2: Write reinforcement count

**Plan says (line 1659):** `reinforcementCount: 1` for explicit writes
**Check:** Does `write()` use reinforcementCount of 1 or some other value?
**Impact:** Higher initial reinforcement (implementation uses 10) makes explicit writes more salient than memorize-extracted items.

### DEV-3: Summary search in read path — RESOLVED

**Plan says (data flow, lines 51-55):** "query --> Search summaries (grep .md files) --> sufficient? return; not enough? --> Search items"
**Resolution (2026-03-06):** Summaries are now wired into `query()`. Implementation uses items-first ordering (not summaries-first as originally planned): items ranked by salience fill the primary results, then summaries fill remaining `limit` slots. This was a deliberate design choice — items provide precise hits while summaries provide broad context. Embedding queries skip summaries entirely. See `docs/plans/2026-03-06-cortex-summary-storage.md` for rationale.

### DEV-4: Read does not reinforce

**Plan code (lines 1706-1718):** `read()` calls `store.reinforce(id)` before returning
**Check:** Does the actual `read()` implementation reinforce the item?
**Impact:** If missing, direct reads don't affect salience.
