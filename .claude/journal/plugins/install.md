# Plugin Install/Uninstall Orchestrator Journal

## [2026-03-29 11:53] -- Implement plugin install/uninstall orchestrator (Task 6)

**Task:** Create the plugin install/uninstall orchestrator that wires together fetcher + parser + store + skill upsert + MCP manager.
**What I did:** Created `src/plugins/install.ts` with `installPlugin()` and `uninstallPlugin()` functions. Created `tests/plugins/install.test.ts` with 10 tests covering valid installs, missing manifests, fetch failures, uninstall flows, audit logging, proxy domain management, and agent isolation.
**Files touched:**
- `src/plugins/install.ts` (created)
- `tests/plugins/install.test.ts` (created)
- `.claude/journal/plugins/install.md` (created)
- `.claude/journal/plugins/index.md` (updated)
**Outcome:** Success -- all 10 tests pass on first run. The orchestrator integrates fetcher, parser, store, skill storage, MCP manager, audit provider, and proxy domain list.
**Notes:** Used `vi.mock()` for fetcher to avoid real git clones. Mocked logger to suppress output. Reused the in-memory DocumentStore stub pattern from `store.test.ts`.
