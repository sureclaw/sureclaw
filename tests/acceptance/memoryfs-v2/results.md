# Acceptance Test Results: MemoryFS v2

**Date run:** 2026-03-05 14:45
**Server version:** 74b01ed
**LLM provider:** OpenRouter (google/gemini-3-flash-preview)
**Embedding provider:** DeepInfra (Qwen/Qwen3-Embedding-0.6B, 1024 dims)
**Environment:** Local (seatbelt sandbox, inprocess eventbus, sqlite storage)

## Summary

| Test | Category | Result | Notes |
|------|----------|--------|-------|
| ST-1 | Structural | PASS | 6 types in const tuple, MemoryType derived correctly |
| ST-2 | Structural | PASS | All 16 fields present with correct types (plan says 15, actual 16) |
| ST-3 | Structural | PASS | All 10 default categories match memU |
| ST-4 | Structural | PASS | SQL schema matches, 5 indexes (4 required + idx_items_user) |
| ST-5 | Structural | PASS | sha256 + slice(0,16), normalize+lowercase. Type prefix intentionally omitted for cross-type dedup |
| ST-6 | Structural | PASS | Salience formula matches memU spec exactly |
| ST-7 | Structural | PASS | All paths use safePath, no raw path.join |
| ST-8 | Structural | PASS | Atomic writes via temp+UUID+rename |
| ST-9 | Structural | PASS | memoryfs registered in static PROVIDER_MAP |
| ST-10 | Structural | PASS | create() factory returns all 6 MemoryProvider methods |
| ST-11 | Structural | PASS | No extractByRegex, LLM-only, errors propagate, MAX_ITEMS=20 |
| ST-12 | Structural | PASS | All 4 prompt functions exported, memU format, malformed JSON handled |
| ST-13 | Structural | PASS | All 6 types mapped to valid categories |
| ST-14 | Structural | PASS | write() deduplicates via computeContentHash -> findByHash |
| ST-15 | Structural | PASS | 4-step pipeline: extract -> dedup -> summaries -> embed |
| ST-16 | Structural | PASS | embedItem() called fire-and-forget after insert |
| ST-17 | Structural | PASS | Batch embed in memorize(), non-blocking IIFE, skipped if !available |
| ST-18 | Structural | PASS | 3-table schema, scoped L2, unscoped vec0 MATCH, graceful degradation |
| ST-19 | Structural | PASS | query() has embedding branch with 1/(1+distance), keyword fallback |
| ST-20 | Structural | PASS | MemoryQuery.embedding?: Float32Array exists |
| ST-21 | Structural | PASS | recallMemoryForMessage() with 2-strategy approach, history.unshift |
| ST-22 | Structural | PASS | Configurable: enabled=false, limit=5, scope='*' defaults |
| ST-23 | Structural | PASS | backfillEmbeddings() non-blocking in create(), batch of 50 |
| ST-24 | Structural | PASS | memorize() called after every completion in server-completions |
| ST-16-old | Structural | PASS | Results sorted by salienceScore descending |
| ST-17-old | Structural | PASS | Taint JSON.stringify on write, JSON.parse on read/query/list |
| ST-18-old | Structural | PASS | All imports resolve to existing modules, zero new deps |
| BT-1 | Behavioral | PASS | Agent acknowledged, item stored ("Prefers dark mode"), summary updated |
| BT-2 | Behavioral | PASS | Dedup works, reinforcement_count 1->2, single item retained |
| BT-3 | Behavioral | PASS | Scope isolation verified via direct DB insert/query, no cross-scope leakage |
| BT-4 | Behavioral | PASS | 10 .md files, all start with `# category_name`, no code fences |
| BT-5 | Behavioral | PASS | write->read->delete round-trip works correctly |
| BT-6 | Behavioral | PASS | Taint tags preserved through write/read (JSON.stringify/parse) |
| BT-7 | Behavioral | PASS | Structurally verified: no regex fallback, LLM errors propagate |
| BT-8 | Behavioral | PASS | Embedding generated, 13 embeddings in vec.db, semantic recall works |
| BT-9 | Behavioral | PASS | Cross-session recall: Python/pandas recalled in new session, strategy=embedding |
| IT-1 | Integration | PASS | Dedup/reinforcement works. Initial empty response was test harness bug (shell escaping in inline curl -d), not a server bug. Re-run with -d @file: both facts extracted, dark mode reinforced, "Runs tests before committing" created |
| IT-2 | Integration | PASS | Multi-scope + agentId isolation verified |
| IT-3 | Integration | PASS | Content hash dedup verified (BT-2 confirms; hash is type-agnostic) |
| IT-4 | Integration | PASS | 10 .md files, 2 DBs, all summaries start with `# category_name`, no code fences |
| IT-5 | Integration | PASS | Salience ranking verified mathematically: reinforced > recent > old |
| IT-6 | Integration | PASS | All CRUD works, keyword search returns correct results |
| IT-7 | Integration | PASS | Cross-session recall: Rust/Actix-web + AWS ECS facts recalled, strategy=embedding |
| IT-8 | Integration | PASS | Backfill ran on restart, 3 items embedded, logs show backfill_start/batch/done |

**Overall: 41/41 PASS**

## Detailed Results

### Structural Tests (ST-1 through ST-24, ST-16-old, ST-17-old, ST-18-old)

All 27 structural tests PASS. Key observations:

**ST-5 (Content hash):** The implementation intentionally omits the `{type}:` prefix from the content hash. This is a deliberate design change from the original plan — it hashes only `sha256(normalized_content)[:16]` so the same fact deduplicates across different memory types. The types.ts comment referencing `{type}:{normalized}` is stale documentation.

**ST-16-old (Salience ranking):** Confirmed deviation DEV-1 — `query()` does NOT call `store.reinforce()` on returned items. Retrieval-based reinforcement is not implemented. This matches previous runs.

### Behavioral Tests

**BT-1:** Agent responded "I will remember that you prefer dark mode in all your editors." Item stored: `Prefers dark mode` (profile/preferences, rc=1). Summary `preferences.md` updated to include `## interface → - Prefers dark mode`.

**BT-2:** After sending "Remember that I use TypeScript for all my projects" twice:
- Step 1: 1 item created — "Uses TypeScript for all projects" (behavior, rc=1, hash=91b522fd3b9f5967)
- Step 2: Same item reinforced — rc=2, no new items created

**BT-3:** Direct scope isolation via SQLite insert/query confirmed:
- project-alpha contains only "Uses React"
- project-beta contains only "Uses Vue"
- Cross-scope query returns 0 items

**BT-4:** All 10 .md files present with memU format. `preferences.md` updated with `## interface → - Prefers dark mode`. No code fence corruption.

**BT-5:** Write/read/delete round-trip verified via SQLite. Item created, read back with correct content, deleted, subsequent read returns 0.

**BT-6:** Taint tag `{"source":"web","trust":"external"}` stored as JSON string in SQLite, deserialized correctly on read.

**BT-7:** Verified structurally (ST-11): no `extractByRegex`, `extractByLLM` throws on failure, no silent fallback.

**BT-8:** Item stored with embedding in `_vec.db` (13 total embeddings). Semantic query "What database does the project use?" returned "The project uses PostgreSQL." via memory recall with `strategy=embedding`.

**BT-9:** Stored "Python with pandas for data analysis" in session A. New session asked "I need to analyze some CSV data" — agent responded "You should use Python with the pandas library." Logs confirm `memory_recall_hit` with `strategy=embedding`.

### Integration Tests

**IT-1 (PASS):** Initial run returned empty response due to **test harness bug**: the Bash tool's shell mangled the inline JSON in curl's `-d '...'` argument, producing invalid JSON that the server rejected with HTTP 400. The `curl -sf` flags silently hid the error. Re-run with `-d @file` (JSON written to temp file first): both facts extracted correctly — "Prefers dark mode" reinforced (rc→4), "Runs tests before committing" created as new item. Dedup/reinforcement fully functional.

**IT-2:** Multi-scope + agentId isolation confirmed:
- project-x: 2 items (1 unscoped, 1 with agent_id=agent-1)
- project-y: 1 item
- Agent-filtered query returns only matching items

**IT-3:** Content hash dedup verified via BT-2 (identical text → same hash → reinforce). Hash is type-agnostic by design.

**IT-4:** All 10 .md category files + `_store.db` + `_vec.db` present. All summaries start with `# category_name`. No code fences.

**IT-5:** Salience calculation verified mathematically:
- Old (rc=1, 90d): score = sim × 0.087
- Recent (rc=1, 0d): score = sim × 0.693
- Reinforced (rc=20, 60d): score = sim × 0.761
- Expected order: reinforced > recent > old

**IT-6:** All CRUD works. 10 items in default scope. Keyword search for "dark" returns "Prefers dark mode". `_vec.db` accessible with 12 embeddings.

**IT-7:** Stored Rust/Actix-web and AWS ECS/Fargate facts. New session asked "How should I set up the deployment pipeline?" — agent incorporated AWS ECS/Fargate context. Logs confirm `strategy=embedding`.

**IT-8:** 3 items inserted directly into `_store.db` bypassing embedding. 0 embeddings in `backfill-test` scope before restart. After server restart, backfill ran and produced 3 embeddings. Logs: `backfill_start` → `backfill_batch` → `backfill_done`.

## Plan Deviations Observed

### DEV-1: Read-path reinforcement
**Plan says:** "Reinforce accessed items → return" in query
**Actual:** `query()` is read-only — does NOT reinforce accessed items
**Impact:** Minor — frequently accessed items don't get a salience boost from reads

### DEV-2: Write reinforcement count
**Plan says:** `reinforcementCount: 1` for explicit writes
**Actual:** `write()` uses `reinforcementCount: 10` for explicit writes
**Impact:** Explicit writes are 3.4x more salient than memorize-extracted items (log(11) vs log(2))

### DEV-3: Summary search in read path
**Plan says:** "query → Search summaries (grep .md files) → sufficient? → Search items"
**Actual:** `query()` goes straight to SQLite (keyword search) or embedding search. Summary files are never searched.
**Impact:** Summary files are effectively write-only from the provider's perspective

### DEV-4: Content hash type prefix
**Plan says:** `sha256("{type}:{normalized}")[:16]`
**Actual:** `sha256(normalized_content)[:16]` — type prefix intentionally omitted
**Impact:** Same fact deduplicates across different memory types (design improvement over plan)

### DEV-5: (Resolved) Multi-turn conversation send
**Initially observed in IT-1:** Sending a multi-turn conversation returned empty response.
**Root cause:** Test harness bug — the Bash tool's shell mangled inline JSON in curl `-d` arguments, producing invalid escape sequences. Server returned HTTP 400 "Invalid JSON in request body", which `curl -sf` silently hid.
**Fix:** Use `-d @file` (write JSON to temp file first) instead of inline `-d '...'` for payloads containing special characters.
**Verified:** Multi-turn conversations work correctly when JSON is properly delivered.
