# MCP Manager Journal

## [2026-03-29 11:49] — Create per-agent MCP connection manager

**Task:** Implement Task 5 from the Cowork plugin integration plan: create a per-agent MCP connection manager
**What I did:** Created `McpConnectionManager` class that tracks MCP server endpoints per agent via a nested Map structure (agentId -> serverName -> ManagedServer). Supports add/remove by server name, bulk remove by plugin name, listing servers (without internal metadata), and deduplicated URL retrieval. Created comprehensive tests covering all methods.
**Files touched:**
- `src/plugins/mcp-manager.ts` (created)
- `tests/plugins/mcp-manager.test.ts` (created)
**Outcome:** Success. All 8 tests pass.
**Notes:** This is a registry, not a connection pool. Actual MCP protocol connections happen when prepareToolStubs() queries each server's tools at sandbox spin-up time. The internal `pluginName` field is stripped from `listServers()` output to keep the public API clean.
