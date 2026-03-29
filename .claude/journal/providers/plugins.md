# Plugins

Plugin system: install, store, MCP manager, startup.

## Entries

## [2026-03-29 12:25] — Generic MCP HTTP client + wiring (Task 13)

**Task:** Create a generic MCP HTTP client using @modelcontextprotocol/sdk that connects to arbitrary MCP servers and lists/calls tools. Wire it into server-completions.ts (sandbox spin-up tool stubs) and inprocess.ts (fast-path tool discovery).
**What I did:** Created src/plugins/mcp-client.ts with listToolsFromServer, callToolOnServer, listToolsFromServers, and withTimeout. Replaced placeholder comments in server-completions.ts and inprocess.ts with actual code that queries plugin MCP servers via McpConnectionManager and merges discovered tools. Created tests/plugins/mcp-client.test.ts with 2 tests.
**Files touched:** src/plugins/mcp-client.ts (created), src/host/server-completions.ts (edited), src/host/inprocess.ts (edited), tests/plugins/mcp-client.test.ts (created)
**Outcome:** Success — all 2716 tests pass (243 files), no regressions.
**Notes:** MCP SDK Client constructor takes (implementation, options?) where implementation is {name, version}. StreamableHTTPClientTransport takes (url: URL, opts?). The SDK's wildcard export `./*` allows importing from `@modelcontextprotocol/sdk/client/streamableHttp.js`. Connection failures in listToolsFromServer are caught and return empty array (non-fatal).

## [2026-03-29 11:56] — Implement plugin startup module (Task 12)

**Task:** Create src/plugins/startup.ts with two functions: reloadPluginMcpServers (repopulates McpConnectionManager from stored plugin records on restart) and autoInstallDeclaredPlugins (auto-installs plugins declared in config.plugins).
**What I did:** Created startup.ts with both functions and tests/plugins/startup.test.ts with 6 tests covering: reload from stored records, multi-agent reload, empty DB, empty/undefined config.plugins, and skip-already-installed.
**Files touched:** src/plugins/startup.ts (created), tests/plugins/startup.test.ts (created), .claude/journal/providers/plugins.md (created), .claude/journal/providers/index.md (updated)
**Outcome:** Success — all 6 tests pass.
**Notes:** Used the same memoryDocuments() stub pattern from store.test.ts. DocumentStore.get() returns string|undefined (not null).
