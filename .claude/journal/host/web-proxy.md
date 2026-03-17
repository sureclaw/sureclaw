# Web Proxy

HTTP forward proxy for sandboxed agent outbound HTTP/HTTPS access.

## [2026-03-17 00:55] — Implement HTTP forward proxy for sandboxed agents

**Task:** Implement the HTTP forward proxy design from docs/plans/2026-03-16-http-proxy-design.md — allow sandboxed agents to make outbound HTTP/HTTPS requests through a controlled proxy on the host.

**What I did:**
- Created `src/host/web-proxy.ts` — core HTTP forward proxy with HTTP forwarding + HTTPS CONNECT tunneling, private IP blocking (SSRF protection), canary token scanning on request bodies, audit logging, support for both Unix socket and TCP listeners
- Created `src/agent/web-proxy-bridge.ts` — TCP-to-Unix-socket bridge for Docker/Apple containers (same pattern as tcp-bridge.ts but handles both HTTP and CONNECT)
- Integrated proxy into `src/host/server-completions.ts` — starts web proxy per completion when `config.web_proxy` is enabled, passes to sandbox config
- Added `AX_WEB_PROXY_SOCKET` to `src/providers/sandbox/canonical-paths.ts`
- Updated both agent runners (`pi-session.ts`, `claude-code.ts`) to detect web proxy env vars, start bridge, set HTTP_PROXY/HTTPS_PROXY
- Added K8s deployment: web-proxy-service.yaml, network-policy.yaml, host-process.ts startup
- Added `web_proxy` and `namespace` fields to Config type
- Created comprehensive tests: 17 proxy tests + 6 bridge tests, all passing
- Full test suite: 2495 tests pass, no regressions

**Files touched:**
- `src/host/web-proxy.ts` (created)
- `src/agent/web-proxy-bridge.ts` (created)
- `src/host/server-completions.ts` (modified)
- `src/host/host-process.ts` (modified)
- `src/providers/sandbox/canonical-paths.ts` (modified)
- `src/agent/runners/claude-code.ts` (modified)
- `src/agent/runners/pi-session.ts` (modified)
- `src/types.ts` (modified)
- `charts/ax/templates/web-proxy-service.yaml` (created)
- `charts/ax/templates/network-policy.yaml` (created)
- `charts/ax/values.yaml` (modified)
- `tests/host/web-proxy.test.ts` (created)
- `tests/agent/web-proxy-bridge.test.ts` (created)

**Outcome:** Success — all 7 design tasks implemented, 23 new tests passing, full suite green.

**Notes:**
- `startWebProxy()` is async (returns Promise<WebProxy>) because TCP ephemeral port assignment requires waiting for the listen callback
- fetch() rejects `transfer-encoding` and `content-length` headers — must strip them before forwarding (same as tcp-bridge.ts pattern)
- Private IP blocking uses `allowedIPs` opt-out for testing (tests need localhost access)
- Proxy is opt-in via `config.web_proxy` — disabled by default
- CONNECT tunnel byte tracking works alongside pipe() — data events still fire with pipe
- Cleanup handlers need a `cleaned` guard to prevent double-fire from close+error events
