# MCP Manager Journal

## [2026-03-29 14:55] — Deprecate providers.mcp singleton

**Task:** Mark `providers.mcp` as deprecated and add migration-path comments across the codebase (Task 7 of unified MCP registry plan)
**What I did:**
- Added `@deprecated` JSDoc to `ProviderRegistry.mcp` in `src/types.ts`
- Added migration-path comment block in `src/host/registry.ts` near the MCP provider loading section
- Added deprecation comments in `src/host/server-init.ts` at the toolBatchProvider wiring and the loadDatabaseMcpServers block
- Added `@deprecated` inline comment on legacy `providers.mcp` reference in `src/host/inprocess.ts`
- Added `@deprecated` inline comment on legacy fallback in `src/host/server-completions.ts`
**Files touched:** `src/types.ts`, `src/host/registry.ts`, `src/host/server-init.ts`, `src/host/inprocess.ts`, `src/host/server-completions.ts`
**Outcome:** Success — all 2752 tests pass, no functional changes, deprecation markers guide future migration
**Notes:** The `tool-router.ts` `ToolRouterContext.mcp` field already had a `@deprecated` marker from a prior task. No Activepieces provider exists — only `database` and `none` MCP providers.

## [2026-03-29 14:30] — Unified tool discovery via McpConnectionManager.discoverAllTools

**Task:** Execute Task 4 from the unified MCP registry plan: replace split discovery paths with single manager-based discovery
**What I did:**
- Added `discoverAllTools(agentId, opts?)` method to `McpConnectionManager` that iterates all registered servers, resolves credential placeholders in headers via an optional callback, queries tools via `listToolsFromServer`, and registers tool-to-URL mappings
- Replaced two separate discovery paths in `server-completions.ts` (global `providers.mcp.listTools()` + per-plugin `listToolsFromServer`) with a single `deps.mcpManager.discoverAllTools()` call, with legacy fallback when no manager exists
- Replaced two separate discovery paths in `inprocess.ts` (skill-filtered `discoverTools()` + per-plugin server loop) with a single `deps.mcpManager.discoverAllTools()` call, with legacy `discoverTools()` fallback
- Removed now-unused imports (`listToolsFromServer`, `McpToolSchema`) from both consumer files
**Files touched:**
- `src/plugins/mcp-manager.ts` (modified — added imports, `discoverAllTools` method)
- `src/host/server-completions.ts` (modified — replaced split discovery with unified call + legacy fallback)
- `src/host/inprocess.ts` (modified — replaced split discovery with unified call + legacy fallback)
**Outcome:** Success. All 2739 tests pass.
**Notes:** The `resolveHeaders` adapter in server-completions.ts uses `JSON.stringify(h)` to match the `resolveHeaders(headersJson: string, credentials)` signature from `database.ts`. The inprocess.ts fast path doesn't pass `resolveHeaders` since it doesn't have credentials context — the manager will use raw headers.

## [2026-03-29 14:23] — Load database MCP servers into manager on startup

**Task:** Execute Task 3 from the unified MCP registry plan: load MCP servers from mcp_servers DB table into McpConnectionManager at startup
**What I did:**
- Added `loadDatabaseMcpServers()` to `src/plugins/startup.ts` that queries enabled rows from `mcp_servers` table and registers them in the manager with `source: 'database'`
- Wired both `reloadPluginMcpServers()` and `loadDatabaseMcpServers()` into `initHostCore()` in `server-init.ts`, so both plugin-based and DB-based MCP servers are loaded on startup
- Added 3 tests: registers DB servers with correct source/headers, handles missing table gracefully, handles undefined database
**Files touched:**
- `src/plugins/startup.ts` (modified — added import + new function)
- `src/host/server-init.ts` (modified — added import + startup calls)
- `tests/plugins/startup.test.ts` (modified — added 3 tests)
**Outcome:** Success. All 2739 tests pass.
**Notes:** The mcp_servers table may not exist yet if no DB migration has run, so the function catches and ignores errors. The `HostCore` interface and return now expose `mcpManager` for downstream consumers.

## [2026-03-29 14:18] — Add source tags, headers, and source-based removal to McpConnectionManager

**Task:** Execute Tasks 1 and 2 from the unified MCP registry plan: extend McpConnectionManager with source tags and headers, and add header support to MCP client
**What I did:**
- Added `source` and `headers` fields to `ManagedServer` interface
- Made `addServer` accept both old string `pluginName` arg (backward compat, derives `source` as `plugin:<name>`) and new `AddServerOpts` object
- Added `listServersWithMeta()`, `getServerMeta()`, `removeServersBySource()` methods
- Refactored `removeServersByPlugin` and `clearToolsForPlugin` to delegate to source-based equivalents
- Added optional `headers` param to `listToolsFromServer` and `callToolOnServer` in mcp-client, passed through `StreamableHTTPClientTransport`'s `requestInit`
- Added 7 new tests for source tags, headers, source-based removal, and backward compat
**Files touched:**
- `src/plugins/mcp-manager.ts` (modified)
- `src/plugins/mcp-client.ts` (modified)
- `tests/plugins/mcp-manager.test.ts` (modified)
**Outcome:** Success. All 2736 tests pass (21 in mcp-manager including 7 new ones).
**Notes:** `removeServersByPlugin` now delegates to `removeServersBySource` with derived source `plugin:<name>`. The `listServersWithMeta` method strips `pluginName` but exposes `source` and `headers`. Existing callers of `listToolsFromServer`/`callToolOnServer` are unaffected since the new `opts` param is optional.

## [2026-03-29 11:49] — Create per-agent MCP connection manager

**Task:** Implement Task 5 from the Cowork plugin integration plan: create a per-agent MCP connection manager
**What I did:** Created `McpConnectionManager` class that tracks MCP server endpoints per agent via a nested Map structure (agentId -> serverName -> ManagedServer). Supports add/remove by server name, bulk remove by plugin name, listing servers (without internal metadata), and deduplicated URL retrieval. Created comprehensive tests covering all methods.
**Files touched:**
- `src/plugins/mcp-manager.ts` (created)
- `tests/plugins/mcp-manager.test.ts` (created)
**Outcome:** Success. All 8 tests pass.
**Notes:** This is a registry, not a connection pool. Actual MCP protocol connections happen when prepareToolStubs() queries each server's tools at sandbox spin-up time. The internal `pluginName` field is stripped from `listServers()` output to keep the public API clean.
