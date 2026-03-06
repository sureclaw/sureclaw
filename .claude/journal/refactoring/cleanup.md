# Refactoring: Cleanup

General refactoring, stale reference cleanup, path realignment, dependency updates.

## [2026-03-05 19:25] — Database layer refactoring (14-task plan)

**Task:** Consolidate 10+ standalone SQLite connections into a shared DatabaseProvider factory
**What I did:** Implemented full 14-task plan: (1) Created DatabaseProvider interface + SQLite/PostgreSQL implementations. (2) Created storage/database and storage/file providers. (3) Created audit/database provider. (4) Ported memoryfs ItemsStore and EmbeddingStore to Kysely. (5) Ported JobStore, FileStore, OrchestrationEventStore to shared DB. (6) Removed legacy sqlite/postgresql providers. (7) Extracted content-serialization utils. (8) Deleted dead code (db.ts, session-store.ts, conversation-store.ts, old migrations). (9) Updated 50+ test files and YAML configs.
**Files touched:** ~80 files created/modified/deleted across src/providers/, src/host/, src/utils/, tests/, charts/
**Outcome:** Success — 202 test files pass (2305 tests), only pre-existing k8s mock failure remains
**Notes:** Union return types (`T | Promise<T>`) needed for interfaces supporting both sync MemoryJobStore and async KyselyJobStore. Provider-local migrations pattern (each consumer runs own migrations against shared Kysely) works well.

## [2026-03-03 21:45] — Fix PR #60: production dependency bumps (7 packages)

**Task:** Fix Dependabot PR #60 that bumps 7 production dependencies including 3 major version bumps (ink 5→6, marked 11→17, react 18→19)
**What I did:** (1) Merged dependabot branch into working branch. (2) Fixed `AuthStorage` constructor change in pi-agent-core 0.55.4 — now uses `AuthStorage.create()` factory method instead of `new AuthStorage()`. (3) Rewrote `src/cli/utils/markdown.ts` renderer for marked v17 API — all methods now use token objects instead of positional args, `this.parser.parseInline(tokens)` for inline rendering, and `list()` must manually iterate items via `this.listitem()` instead of `this.parser.parse(token.items)`. (4) React 18→19 and Ink 5→6 required zero code changes.
**Files touched:** `src/agent/runners/pi-session.ts`, `src/cli/utils/markdown.ts`, `package.json`, `package-lock.json`
**Outcome:** Success — build clean, all 208 test files pass (2298 tests)
**Notes:** The marked v17 `list()` renderer cannot pass `token.items` to `this.parser.parse()` because the parser doesn't recognize `list_item` tokens. Must iterate items manually and call `this.listitem(item)` for each.

## [2026-03-01 15:50] — Clean up stale scratch tier references

**Task:** Remove stale "scratch" tier references from tool catalog, MCP server, and runtime prompt after upstream PR removed the scratch tier from IPC schemas
**What I did:** (1) Reverted `.filter(t => t.name !== 'write')` in pi-session.ts so local `write` tool is available for ephemeral `/scratch` writes. (2) Updated 4 tier description strings in tool-catalog.ts from `"agent", "user", or "scratch"` to `"agent" or "user"`. (3) Updated 1 tier description in mcp-server.ts similarly. (4) Renamed runtime prompt section from "Workspace Tiers" to "Workspace" and added `/scratch` ephemeral working directory description. (5) Updated test assertions to match new heading.
**Files touched:** `src/agent/runners/pi-session.ts`, `src/agent/tool-catalog.ts`, `src/agent/mcp-server.ts`, `src/agent/prompt/modules/runtime.ts`, `tests/agent/prompt/enterprise-runtime.test.ts`
**Outcome:** Success — build clean, all 2005 tests pass
**Notes:** The mcp-server.ts file had a stale reference not mentioned in the original plan. Always grep broadly for stale references when cleaning up removed features.
