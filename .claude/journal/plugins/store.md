# Plugin Store Journal

## [2026-03-29 11:50] — Implement per-agent plugin and command storage (Task 3)

**Task:** Create `src/plugins/store.ts` and `tests/plugins/store.test.ts` for Cowork plugin integration plan Task 3 — per-agent plugin and command storage using DocumentStore.
**What I did:** Created the plugin store module with two DocumentStore collections ('plugins' keyed by `{agentId}/{pluginName}`, 'commands' keyed by `{agentId}/{commandName}`). Implemented full CRUD: `upsertPlugin`, `getPlugin`, `listPlugins`, `deletePlugin`, `upsertCommand`, `listCommands`, `deleteCommandsByPlugin`. Created 10 tests using an in-memory DocumentStore stub, covering: upsert+retrieve, upsert overwrite, null for non-existent, agent-scoped listing (pi vs counsel), delete, command upsert+list, command agent scoping, deleteCommandsByPlugin selective removal, and cross-agent isolation.
**Files touched:** `src/plugins/store.ts` (created), `tests/plugins/store.test.ts` (created), `.claude/journal/plugins/index.md` (updated), `.claude/journal/plugins/store.md` (created)
**Outcome:** Success — all 10 tests pass.
**Notes:** Followed the exact same pattern as `src/providers/storage/skills.ts` and `tests/providers/storage/skills.test.ts`. Used in-memory DocumentStore stub (Map-based) rather than SQLite for fast, dependency-free tests.
