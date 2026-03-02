# Refactoring: Cleanup

General refactoring, stale reference cleanup, path realignment.

## [2026-03-01 15:50] — Clean up stale scratch tier references

**Task:** Remove stale "scratch" tier references from tool catalog, MCP server, and runtime prompt after upstream PR removed the scratch tier from IPC schemas
**What I did:** (1) Reverted `.filter(t => t.name !== 'write')` in pi-session.ts so local `write` tool is available for ephemeral `/scratch` writes. (2) Updated 4 tier description strings in tool-catalog.ts from `"agent", "user", or "scratch"` to `"agent" or "user"`. (3) Updated 1 tier description in mcp-server.ts similarly. (4) Renamed runtime prompt section from "Workspace Tiers" to "Workspace" and added `/scratch` ephemeral working directory description. (5) Updated test assertions to match new heading.
**Files touched:** `src/agent/runners/pi-session.ts`, `src/agent/tool-catalog.ts`, `src/agent/mcp-server.ts`, `src/agent/prompt/modules/runtime.ts`, `tests/agent/prompt/enterprise-runtime.test.ts`
**Outcome:** Success — build clean, all 2005 tests pass
**Notes:** The mcp-server.ts file had a stale reference not mentioned in the original plan. Always grep broadly for stale references when cleaning up removed features.
