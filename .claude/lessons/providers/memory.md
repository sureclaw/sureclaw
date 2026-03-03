# Provider Lessons: Memory

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
