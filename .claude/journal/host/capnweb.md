# Cap'n Web MCP Integration

## [2026-03-28 18:30] — Implement Cap'n Web RPC server and codegen for MCP tools

**Task:** Integrate Cap'n Web (Cloudflare's JS RPC library) to expose MCP tools as typed TypeScript stubs on the agent filesystem, enabling the agent to write scripts that batch multiple tool calls without consuming LLM tokens.
**What I did:**
- Created `src/capnweb/transport.ts` — shared `SocketRpcTransport` implementing Cap'n Web's `RpcTransport` interface over `net.Socket` with length-prefix framing
- Created `src/host/capnweb/server.ts` — `CapnWebServer` class that creates a Unix socket server, dynamically builds an `RpcTarget` with one method per MCP tool, and establishes `RpcSession` per client connection
- Created `src/host/capnweb/codegen.ts` — generates self-contained TypeScript stub files (`_runtime.ts` + per-server/per-tool files) from `McpToolSchema[]` with typed parameters
- Created `src/host/capnweb/index.ts` — barrel exports
- Added comprehensive tests (11 passing) covering RPC tool calls, promise pipelining/batching, error propagation, codegen output, schema-to-TS conversion, and name sanitization
**Files touched:** `src/capnweb/transport.ts`, `src/host/capnweb/server.ts`, `src/host/capnweb/codegen.ts`, `src/host/capnweb/index.ts`, `tests/host/capnweb/server.test.ts`, `tests/host/capnweb/codegen.test.ts`, `package.json`
**Outcome:** Success — all 11 new tests pass, all 2642 existing tests still pass
**Notes:** Transport uses same 4-byte length-prefix framing as existing IPC but on a dedicated socket. The codegen inlines the transport code in `_runtime.ts` so the agent sandbox only needs `capnweb` npm package. Next steps: wire into sandbox creation flow, add `AX_CAPNWEB_SOCKET` env var to sandbox config.
