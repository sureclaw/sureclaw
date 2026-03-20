# Web Proxy

HTTP forward proxy for sandboxed agent outbound HTTP/HTTPS access.

## [2026-03-19 23:00] — K8s deployment fixes from E2E validation

**Task:** Validate full credential flow E2E on kind cluster; fix issues blocking deployment.
**What I did:**
- Fixed node-forge ESM import in proxy-ca.ts (`import * as forge` → `import forgeModule from`). The CJS module doesn't export named `pki` — need default import.
- Added `namespace` to Config Zod schema — chart-injected field was rejected by strict validation.
- Auto-inject namespace into ConfigMap template from Helm release namespace (so web proxy URL uses correct k8s service FQDN).
- Fixed kind-dev-values.yaml: empty registry for local images, correct mount paths (`/opt/ax/dist`), OpenRouter API credentials.
- E2E test showed host starts successfully, web proxy on port 3128 with MITM, LLM calls work. But sandbox pods never receive NATS work dispatch — tool calls stream back unexecuted.
**Files touched:** src/host/proxy-ca.ts, src/config.ts, charts/ax/templates/configmap-ax-config.yaml, charts/ax/kind-dev-values.yaml
**Outcome:** Partial — host deploys clean, web proxy starts, but NATS work dispatch to sandbox pods is non-functional (pre-existing issue)
**Notes:** Sandbox pods show `[diag] waiting for work on sandbox.work` but never receive messages. This blocks all E2E validation of web proxy propagation, npm install, and credential flow.

## [2026-03-19 22:20] — Migrate web-proxy-approvals to event bus + diagnostic logging

**Task:** Follow-up from live k8s debugging: (1) add diagnostic logging for web proxy URL propagation to sandbox pods, (2) migrate web-proxy-approvals.ts from in-memory promise map to event bus pattern (like credential-prompts.ts), (3) verify Helm chart web proxy config.
**What I did:**
- Added diagnostic logging in runner.ts:applyPayload() to show whether webProxyUrl came from payload vs env
- Added logging in pi-session.ts and claude-code.ts to show which proxy mode (bridge/URL/port) was selected
- Rewrote web-proxy-approvals.ts: replaced in-memory pending Map with event bus subscribeRequest/emit pattern. requestApproval() now takes EventBus + requestId, resolveApproval() publishes event. Kept approvedCache/deniedCache as local short-circuit caches.
- Updated all callers: server-completions.ts, host-process.ts, server-admin.ts, ipc-handlers/sandbox-tools.ts
- Rewrote tests to use createEventBus() — 11 tests including timeout, requestId mismatch, cache, session isolation
- Verified Helm chart: service selector matches host labels, containerPort 3128 conditional, network policies correct
**Files touched:** src/agent/runner.ts, src/agent/runners/pi-session.ts, src/agent/runners/claude-code.ts, src/host/web-proxy-approvals.ts, src/host/server-completions.ts, src/host/host-process.ts, src/host/server-admin.ts, src/host/ipc-handlers/sandbox-tools.ts, tests/host/web-proxy-approvals.test.ts
**Outcome:** Success — all 2479 tests pass, clean TypeScript compilation
**Notes:** resolveApproval() changed from returning boolean (found) to void — it publishes to event bus, so there's no "found" concept. Admin API and IPC handler now accept requestId/proxyRequestId fields.

## [2026-03-19 08:15] — Host-Side Credential Prompting During Skill Install

**Task:** Implement interactive credential prompting when skills require API keys not in the credential store
**What I did:** Created credential prompt registry (modeled on web-proxy-approvals.ts), wired it into server-completions.ts credential collection loop, added SSE named event emission in chat completions stream, added HTTP endpoints (POST /v1/credentials/provide and POST /admin/api/credentials/provide), wired session cleanup, updated skills documentation
**Files touched:** src/host/credential-prompts.ts (new), src/host/server-completions.ts, src/host/server-http.ts, src/host/server.ts, src/host/server-admin.ts, tests/host/credential-prompts.test.ts (new), tests/host/server-credentials-sse.test.ts (new), tests/host/credential-provide-endpoint.test.ts (new), .claude/skills/ax-security/SKILL.md, .claude/skills/ax-provider-credentials/SKILL.md, .claude/skills/ax-provider-web/SKILL.md
**Outcome:** Success — 6 commits, all 2424 tests pass
**Notes:** Clean TDD execution following plan. credential-prompts.ts mirrors web-proxy-approvals.ts pattern exactly (pending map, piggyback, timeout, cleanup). Three resolution paths: SSE + HTTP POST for web chat, admin SSE + admin HTTP POST for dashboard.

## [2026-03-19 06:52] — MITM Credential Injection for Skill API Keys

**Task:** Implement MITM TLS inspection in the web proxy to enable sandboxed skills to use third-party API keys without real credentials entering the container.
**What I did:** Created 9-task plan covering CA cert generation (proxy-ca.ts), credential placeholder manager (credential-placeholders.ts), MITM TLS termination in CONNECT handler, credential map wiring into sandbox launch, CA trust injection into containers, bypass list config, audit logging for credential injection, canary scanning on decrypted HTTPS, and documentation updates.
**Files touched:** `src/host/proxy-ca.ts` (new), `src/host/credential-placeholders.ts` (new), `src/host/web-proxy.ts` (modified), `src/host/server-completions.ts` (modified), `src/types.ts` (modified), tests/host/proxy-ca.test.ts, tests/host/credential-placeholders.test.ts, tests/host/web-proxy.test.ts, tests/host/credential-injection-integration.test.ts, tests/providers/sandbox/k8s-ca-injection.test.ts, 3 skill docs
**Outcome:** Success — 2416 tests passing, all 9 tasks completed. Feature branch `feature/mitm-credential-injection`.
**Notes:** Key discoveries: (1) node-forge SAN for IPs requires `{ type: 7, ip: addr }` not `{ type: 2, value: addr }`, (2) domain cert cache must be keyed by CA+domain to avoid cross-test contamination, (3) canary detection in MITM must write HTTP 403 response before destroying TLS socket (just destroying causes silent failure).

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
