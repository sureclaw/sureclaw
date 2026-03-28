# Cap'n Web MCP Integration

## [2026-03-28 20:25] — Route Cap'n Web batch through existing IPC socket

**Task:** Replace proxy-based transport with IPC-based transport. Cap'n Web batch goes over the same IPC socket as all other tool calls.
**What I did:**
- Added `capnweb_batch` IPC schema in `ipc-schemas.ts`
- Created `src/host/ipc-handlers/capnweb.ts` — IPC handler that processes batch via `newHttpBatchRpcResponse` with synthetic Request/Response
- Wired handler into `ipc-server.ts` via `capnwebTarget` option
- Rewrote codegen runtime to use `IPCBatchTransport` over `AX_IPC_SOCKET` instead of `newHttpBatchRpcSession` over HTTP
- Reverted all web proxy `internalRoutes` changes — no proxy modifications needed
- Added `capnweb_batch` to `knownInternalActions` in sync test
**Files touched:** `src/ipc-schemas.ts`, `src/host/ipc-handlers/capnweb.ts`, `src/host/ipc-server.ts`, `src/host/capnweb/server.ts`, `src/host/capnweb/codegen.ts`, `src/host/web-proxy.ts`, `tests/`
**Outcome:** Success — 2644 tests pass. Clean separation: Cap'n Web batch is just another IPC action, no proxy changes, no separate socket.
**Notes:** The batch protocol maps perfectly to IPC request-response: client accumulates messages, sends as one `capnweb_batch` call, gets all responses back.

## [2026-03-28 20:10] — Simplify Cap'n Web transport: use existing web proxy instead of separate socket

**Task:** Eliminate the separate Unix socket transport and route Cap'n Web through the existing web proxy.
**What I did:**
- Removed `src/capnweb/transport.ts` (custom SocketRpcTransport) — no longer needed
- Rewrote `src/host/capnweb/server.ts` — replaced `CapnWebServer` (socket server) with `createCapnWebHandler()` that returns a request handler using `nodeHttpBatchRpcResponse`
- Added `internalRoutes` option to `WebProxyOptions` in `web-proxy.ts` — intercepts requests to internal hostnames (e.g. `ax-capnweb`) before DNS/SSRF checks, handles them in-process
- Simplified `codegen.ts` runtime template from 60 lines (inlined transport) to 4 lines (`newHttpBatchRpcSession(url)`)
- Added 3 proxy internal routes tests + updated capnweb tests to use HTTP batch
**Files touched:** `src/host/web-proxy.ts`, `src/host/capnweb/server.ts`, `src/host/capnweb/codegen.ts`, `src/host/capnweb/index.ts`, `tests/host/web-proxy.test.ts`, `tests/host/capnweb/*.test.ts`
**Outcome:** Success — all 2646 tests pass. Much simpler architecture: no separate socket, no custom transport, just the existing proxy with a handler.
**Notes:** The generated `_runtime.ts` is now `import { newHttpBatchRpcSession } from 'capnweb'; export const tools = newHttpBatchRpcSession('http://ax-capnweb/rpc');`. The proxy intercepts `ax-capnweb` hostname and routes to the Cap'n Web handler. Works for all sandbox types since all sandboxes already have `HTTP_PROXY` configured.

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
**Notes:** Superseded by the proxy-based approach above.
