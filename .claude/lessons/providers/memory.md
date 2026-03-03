# Provider Lessons: Memory

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

### @dao-xyz/sqlite3-vec uses async API wrapping sync better-sqlite3
**Date:** 2026-03-03
**Context:** Integrating sqlite-vec for vector similarity search. The library's `createDatabase()` returns a Promise and `prepare()` is async, but the underlying operations are synchronous better-sqlite3 calls.
**Lesson:** When using `@dao-xyz/sqlite3-vec` in Node.js: (1) `createDatabase()` is async — await it; (2) `prepare()` returns `Promise<Statement>` — await it; (3) `stmt.run()`, `stmt.get()`, `stmt.all()` are sync; (4) Float32Array values are auto-converted to Buffer for BLOB binding; (5) Use a separate database file from the existing `openDatabase()` adapter to avoid extension loading issues. **Import caveat:** Use `import sqliteVec from '@dao-xyz/sqlite3-vec'` (default import), NOT `import { createDatabase }` — the package's `exports["."].types` resolves to `dist/unified.d.ts` which doesn't declare `createDatabase` as a named export. The default export is typed `any`, so annotate the result: `const db: Database = await sqliteVec.createDatabase(...)`.
**Tags:** sqlite-vec, better-sqlite3, embedding, vector-search, async, typescript-import

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
