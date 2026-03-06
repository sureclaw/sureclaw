# Provider Lessons: Memory

### Tests asserting exact query() result counts must account for appended summaries
**Date:** 2026-03-06
**Context:** After wiring summaries into query() as trailing results (Task 4), a pre-existing integration test (`dedup: same fact mentioned twice -> one entry reinforced`) failed because it expected `toHaveLength(1)` but got 2 — the second result was an appended summary.
**Lesson:** When `query()` appends summary entries after item results, any test that asserts an exact result count (`toHaveLength(N)`) will break. Filter out summary entries before count assertions: `results.filter(r => !r.id?.startsWith(SUMMARY_ID_PREFIX))`. Only test summary-specific behavior in dedicated summary tests. This is especially important when modifying the query() return shape — run ALL tests, not just the ones you changed.
**Tags:** cortex, testing, query, summaries, result-count, breaking-change

### Wildcard scope '*' must be handled explicitly in SQL queries — it's not a SQL pattern
**Date:** 2026-03-06
**Context:** Memory recall was returning empty results despite data existing in SQLite. The `memory_recall_scope` config defaults to `'*'`, but `listByScope()` and `searchContent()` used `WHERE scope = '*'` (literal string match), which matched nothing since items are stored with scope `'default'`.
**Lesson:** When a provider accepts a wildcard/all-scopes sentinel like `'*'`, every SQL query method that filters by scope must check for it: `if (scope && scope !== '*') { query = query.where('scope', '=', scope); }`. The sentinel is a convention at the application layer, not a SQL feature — it requires explicit handling in every query path (listByScope, searchContent, and the EmbeddingStore's findSimilar already did this correctly).
**Tags:** cortex, scope, sql, wildcard, memory-recall, config

### Never fire-and-forget critical data writes — await embeddings in write() and memorize()
**Date:** 2026-03-06
**Context:** `write()` used `.catch(() => {})` for embedding storage (zero logging), `memorize()` used a detached async IIFE with `.catch(() => {})`. Embeddings were often missing when the next session queried because the fire-and-forget hadn't completed or had silently failed.
**Lesson:** Embedding storage must be awaited in `write()` and `memorize()`, not fire-and-forget. If embedding fails, the error should propagate so callers know the write is incomplete. Fire-and-forget with `.catch(() => {})` is appropriate for truly optional side effects (like summary .md updates), but not for data that the primary query path depends on. Rule of thumb: if the read path queries this data, the write path must await it.
**Tags:** cortex, embedding, fire-and-forget, await, write, memorize

### Search strategy fallbacks must be observable — log warnings, not silent degradation
**Date:** 2026-03-06
**Context:** `recallMemoryForMessage()` silently fell back from embedding to keyword search when embeddings returned empty, hiding misconfigured providers, missing API keys, or exhausted token budgets.
**Lesson:** When a search strategy chain degrades (embedding → keyword), log a `warn` on fallback, not a `debug`. Include a diagnostic hint: `"Check embedding provider configuration and that embeddings are being stored."` Silent degradation makes misconfiguration invisible. The keyword fallback should exist for resilience, but operators need to know it's being used.
**Tags:** cortex, memory-recall, embedding, keyword-fallback, observability, logging

### userId = NULL means shared; use (user_id = ? OR user_id IS NULL) for "own + shared" queries
**Date:** 2026-03-04
**Context:** Implementing multi-user memory scoping for MemoryFS. Needed a backward-compatible way to isolate user memories while keeping agent-wide shared memories accessible.
**Lesson:** The pattern `userId = NULL` = shared/agent-scoped works perfectly for backward compatibility (all existing data has NULL userId, so it becomes shared). For user-scoped queries, use `(user_id = ? OR user_id IS NULL)` SQL to return both the user's own memories and shared ones. For hash dedup (`findByHash`), match exactly: `user_id = ?` or `user_id IS NULL` — never combine with OR, since the same content stored by different users should be separate entries.
**Tags:** memoryfs, userId, scoping, sql, backward-compatibility

### Server-side userId injection prevents agent impersonation
**Date:** 2026-03-04
**Context:** Designing where userId should be enforced for memory operations. Considered agent-side injection vs server-side injection.
**Lesson:** Always inject userId server-side in IPC handlers, never trust agent-provided userId. Use `isDmScope(ctx)` to decide: DMs/web/undefined contexts inject `ctx.userId`, channel/group contexts set `userId = undefined` (shared). This keeps userId out of agent-facing IPC schemas entirely — the agent never controls or sees the userId field.
**Tags:** memoryfs, userId, security, ipc, server-side-injection

### LLM extraction rephrases facts — content-hash dedup only catches exact matches
**Date:** 2026-03-03
**Context:** Running acceptance tests for MemoryFS v2. Sent "Remember I use TypeScript" twice. Expected dedup via content hash. Got 3 items: "Uses TypeScript for all projects", "User uses TypeScript for all projects. Apply this context...", "The user uses TypeScript for all of their projects."
**Lesson:** Content-hash dedup (sha256 of normalized lowercase content) works perfectly for identical text (whitespace/case invariant) but fails for LLM-extracted items because the LLM rephrases facts differently each extraction. To achieve semantic dedup, either: (1) constrain extraction prompt to produce canonical minimal phrasings, (2) use embedding similarity to detect near-duplicates before insert, or (3) both.
**Tags:** memoryfs, dedup, llm, extraction, content-hash, semantic-duplicates

### Mock embedding vectors must match EmbeddingStore configured dimensions
**Date:** 2026-03-03
**Context:** Semantic dedup tests used 3-element Float32Arrays but the provider defaults to 1536 dimensions. The EmbeddingStore's vec0 table was created with `float[1536]`, so 3-element upserts silently failed (caught by `.catch(() => {})`), making `findSimilar` return nothing.
**Lesson:** When testing embedding-related features, pass `config.history.embedding_dimensions` matching the mock vector length. Use `{ history: { embedding_dimensions: 3 } } as unknown as Config` for small test vectors. The EmbeddingStore's vec0 virtual table enforces dimension consistency at the SQLite level.
**Tags:** memoryfs, embedding, testing, dimensions, sqlite-vec

### LLM summary generator wraps output in markdown code fences
**Date:** 2026-03-03
**Context:** Acceptance test IT-4 found that 4 of 10 category summary .md files start with ` ```markdown ` instead of `# category_name`. The LLM returns the summary wrapped in code fences.
**Lesson:** When asking an LLM to generate structured text (markdown summaries), the response often includes code fences (` ```markdown ... ``` `). Always strip code fences from LLM output before writing to files, AND instruct the LLM not to use them in the prompt. Belt and suspenders — LLMs don't reliably follow formatting instructions.
**Tags:** memoryfs, llm, summary, markdown, code-fences, output-parsing

### LLM extraction must throw on parse failure for .catch() fallback to work
**Date:** 2026-03-03
**Context:** Wiring LLM extraction into `memorize()` with `.catch(() => extractByRegex(...))` fallback. The `extractByLLM` function initially returned `[]` on invalid JSON, which is a valid result (LLM says "nothing to remember"). The `.catch()` never fired, so regex fallback never ran when LLM returned garbage.
**Lesson:** When a function is used in a `.catch()` fallback pattern, it must throw on actual failures (unparseable response, no JSON array) rather than silently returning an empty result. Reserve returning `[]` for the legitimate case where the LLM explicitly returns an empty array. The distinction: parseable `[]` → success (empty), unparseable garbage → throw → fallback.
**Tags:** llm, extraction, error-handling, fallback-pattern, memoryfs

### vec0 MATCH is global — use vec_distance_l2() for scoped vector queries
**Date:** 2026-03-03
**Context:** PR review found that scoped similarity search did global MATCH with 3x limit then post-filtered by scope, which misses in-scope nearest neighbors when cross-scope items dominate the global top-k.
**Lesson:** sqlite-vec's vec0 `embedding MATCH ?` query does not support WHERE clauses for pre-filtering. For scoped queries, store the raw embedding BLOB in a regular table (embedding_meta) and use `vec_distance_l2(embedding, ?) as distance` with `WHERE scope = ?` for correct within-scope brute-force search. Reserve vec0 MATCH for unscoped/global queries where ANN indexing provides speed benefits.
**Tags:** sqlite-vec, vec0, scoped-search, embedding, vector-search

### MemoryFS provider must handle missing config.history fields with defaults
**Date:** 2026-03-03
**Context:** Adding embedding support to MemoryFS. Tests pass minimal mock configs without `config.history` populated. Accessing `config.history.embedding_model` threw TypeError.
**Lesson:** When the MemoryFS provider reads from config sections that may not exist in test mocks or minimal configs, always use optional chaining with nullish coalescing defaults: `config.history?.embedding_model ?? 'text-embedding-3-small'`. The config schema adds defaults when loading from YAML, but tests call `create()` with hand-crafted partial configs.
**Tags:** memoryfs, config, testing, defaults, embedding

### Use official sqlite-vec package, not @dao-xyz/sqlite3-vec
**Date:** 2026-03-02
**Context:** Replaced `@dao-xyz/sqlite3-vec` (Linux x64 only) with official `sqlite-vec` (cross-platform). The official package uses `sqliteVec.load(db)` on a `better-sqlite3` Database instance.
**Lesson:** Use `import * as sqliteVec from 'sqlite-vec'` + `import Database from 'better-sqlite3'`. Call `sqliteVec.load(db)` after creating the Database. All operations are sync: `db.prepare(sql).get(...)`, `db.prepare(sql).run(...)`. Use `result.lastInsertRowid` from `RunResult` instead of `SELECT last_insert_rowid()`. Spread params directly (`stmt.get(a, b)`) instead of passing arrays (`stmt.get([a, b])`).
**Tags:** sqlite-vec, better-sqlite3, embedding, vector-search, cross-platform

### ESM module namespaces are non-configurable — use vi.mock with hoisted control for degradation tests
**Date:** 2026-03-02
**Context:** Degradation tests needed to mock `sqlite-vec`'s `load()` export to simulate extension load failure, but `vi.spyOn(module, 'load')` fails in ESM with "Cannot redefine property".
**Lesson:** For ESM modules, use `vi.hoisted()` to create a control object + `vi.mock('module', async (importOriginal) => {...})` that wraps the real function and checks the control flag. Set the flag in tests that need the mock, reset in `afterEach`. Import the module under test with `await import(...)` after `vi.mock()`.
**Tags:** vitest, esm, mocking, vi.mock, vi.hoisted, degradation-testing

### Check dependency chain before implementing plan tasks — missing prereqs block you
**Date:** 2026-03-02
**Context:** Implementing Task 8 (MemoryFS Provider) which depends on Task 2 (ItemsStore). The ItemsStore had not been implemented yet, though the plan listed it as a prerequisite.
**Lesson:** Before starting a plan task, verify that all dependency tasks listed in the plan's build order are actually implemented. The plan specifies "Task 8 depends on Tasks 2-7" but doesn't enforce it. Check for the actual source files, not just the plan text. If a prerequisite is missing, implement it inline -- the plan already has the full spec.
**Tags:** memoryfs, dependencies, plan-execution, items-store

### Salience formula produces 0 at zero reinforcement — test ratios need nonzero counts
**Date:** 2026-03-02
**Context:** Implementing salience scoring. Tests compared ratios of scores with reinforcementCount: 0, which produces 0/0 = NaN because log(0+1) = log(1) = 0.
**Lesson:** When testing ratio properties (half-life decay, null fallback) of a multiplicative formula, ensure all other multiplicative factors are nonzero. For salience scoring, use reinforcementCount >= 1 in ratio tests since log(1) = 0 zeroes out the entire product. Add a separate edge-case test to verify zero reinforcement produces score 0.
**Tags:** salience, math, testing, edge-cases, memoryfs

### pi-agent-core only supports text — image blocks must bypass it
**Date:** 2026-02-26
**Context:** Debugging why Slack image attachments weren't visible to the LLM despite being downloaded and stored correctly.
**Lesson:** pi-agent-core (`@mariozechner/pi-agent-core`) only handles text user messages. When the user message includes non-text content blocks (images), they must be extracted before entering pi-agent-core and injected into the IPC/LLM call messages separately. The injection point is in `createIPCStreamFn()` after `convertPiMessages()` runs — find the last user message with string content (the prompt, not tool results) and convert it to structured content with text + image blocks.
**Tags:** pi-agent-core, images, ipc-transport, slack, vision
