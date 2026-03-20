# Mid-Request Credential Collection — Follow-Up Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Context:** The core mid-request credential collection flow was implemented in commits `7be9db1` and `a651e9a`. During live debugging on the kind cluster, we discovered additional issues that block the full E2E flow. This plan addresses those issues.

**Branch:** `feature/mid-request-credential-collection`

**Prerequisites:** Kind cluster running via `npm run k8s:dev setup`. The Helm chart already has `webProxy.enabled: true` and `config.web_proxy: true` in `kind-dev-values.yaml`.

---

## Task 1: Fix Web Proxy Propagation to Sandbox Pods

**Problem:** Agent sandbox pods can't reach npm/pip registries. `npm install` hangs inside sandbox bash tool because `HTTP_PROXY`/`HTTPS_PROXY` env vars aren't set in the sandbox process. The web proxy is running on the host pod (port 3128) and the `ax-web-proxy` Service exists, but the sandbox pod's runner never starts the web proxy bridge.

**Root Cause Investigation:**

The proxy URL flows through this chain:
1. `host-process.ts:568` — `extraSandboxEnv` sets `AX_WEB_PROXY_URL=http://ax-web-proxy.{ns}.svc:3128`
2. `server-completions.ts:906` — `webProxyUrl` field in NATS work payload
3. `runner.ts:344` — `parseStdinPayload()` extracts `webProxyUrl`
4. `runner.ts:553` — `applyPayload()` sets `process.env.AX_WEB_PROXY_URL`
5. `pi-session.ts:358` / `claude-code.ts:115` — reads `AX_WEB_PROXY_URL`, starts bridge or sets `HTTP_PROXY`

**Debug steps:**
1. Add diagnostic logging in `runner.ts:applyPayload()` to confirm `webProxyUrl` is received
2. Check if `AX_WEB_PROXY_URL` is set before the runner reads it (timing issue?)
3. In the runner, verify the web proxy bridge starts (or in claude-code, verify `HTTP_PROXY` is set on the SDK env)
4. From inside a sandbox pod, test TCP connectivity: `node -e "require('net').connect(3128, 'ax-web-proxy.ax-dev.svc').on('connect', () => console.log('ok')).on('error', e => console.error(e))"`

**Files:**
- Debug: `src/agent/runner.ts` (add logging around line 553)
- Debug: `src/agent/runners/pi-session.ts` (line 358-373)
- Debug: `src/agent/runners/claude-code.ts` (line 115-225)
- Debug: `src/agent/web-proxy-bridge.ts` (bridge startup)

**Validation:**
```bash
npm run k8s:dev cycle all
npm run k8s:dev test "install the linear skill from here: https://clawhub.ai/MaTriXy/linear-skill"
npm run k8s:dev logs sandbox  # look for npm install succeeding
```

---

## Task 2: Migrate web-proxy-approvals.ts to Event Bus

**Problem:** `src/host/web-proxy-approvals.ts` uses an in-memory `Map<sessionId, Map<domain, PendingEntry>>` with resolve/reject callbacks. Same pattern that broke `credential-prompts.ts` in multi-replica k8s — `requestApproval()` blocks on replica A, but `resolveApproval()` may arrive on replica B.

**Note:** This is less critical than Task 1 because in the kind dev cluster there's only 1 host replica. But it will break in production k8s with multiple replicas.

**Design:**
- Follow the same event bus pattern used in `credential-prompts.ts` (commit `7be9db1`)
- `requestApproval(sessionId, domain)` → subscribe to `proxy.approval.{requestId}` on event bus, block
- `resolveApproval(sessionId, domain, approved)` → publish `proxy.approval.{requestId}` on event bus
- Keep `approvedCache`/`deniedCache` as local caches (session-scoped, fine for single request lifetime)
- The `preApproveDomain()` function can stay in-memory — it's called during the same request that uses it

**Files:**
- Modify: `src/host/web-proxy-approvals.ts`
- Modify: wherever `requestApproval`/`resolveApproval` are called (likely `src/host/web-proxy.ts` or IPC handler)
- Test: `tests/host/web-proxy-approvals.test.ts`

---

## Task 3: Helm Chart Cleanup for Web Proxy

**Problem:** During debugging, the ConfigMap and web-proxy Service were patched manually via `kubectl`. The Helm release is out of sync. Need to ensure `helm upgrade` works cleanly with the committed `kind-dev-values.yaml`.

**Steps:**
1. Run `helm upgrade ax charts/ax -f charts/ax/kind-dev-values.yaml -n ax-dev` and fix any errors
2. Verify the `ax-web-proxy` Service is created by the chart (not just manually)
3. Verify the host deployment exposes port 3128 (`containerPort` in deployment template)
4. Verify the ConfigMap includes `web_proxy: true`
5. Check NetworkPolicy templates allow sandbox → host:3128 traffic

**Files:**
- Verify: `charts/ax/templates/web-proxy-service.yaml` (selector matches host pod labels)
- Verify: `charts/ax/templates/host/deployment.yaml` (containerPort 3128)
- Verify: `charts/ax/templates/network-policy.yaml` (sandbox egress to host:3128)
- Verify: `charts/ax/templates/networkpolicies/host-network.yaml` (host ingress on 3128)
- Possible fix: `charts/ax/kind-dev-values.yaml` if postgresql secret mismatch blocks helm upgrade

**Validation:**
```bash
helm upgrade ax charts/ax -f charts/ax/kind-dev-values.yaml -n ax-dev
kubectl get svc ax-web-proxy -n ax-dev
kubectl get endpoints ax-web-proxy -n ax-dev  # must show host pod IP
```

---

## Task 4: E2E Validation of Full Credential Flow

**Problem:** The full flow has never been validated end-to-end on the kind cluster because the web proxy issue blocks skill download.

**Test scenario:**
```bash
npm run k8s:dev test "install the linear skill from here: https://clawhub.ai/MaTriXy/linear-skill"
```

**Expected flow:**
1. Agent calls `skill.download` (or host ClawHub fallback downloads the package)
2. Agent calls `bash` to run `npm install` inside sandbox (requires working web proxy)
3. Agent calls `credential_request` with `envName: LINEAR_API_KEY`
4. Host detects credential requirements from committed skill files (post-agent loop)
5. Host emits `credential.required` SSE event with `envName: LINEAR_API_KEY`
6. User provides credential via `POST /v1/credentials/provide` with `requestId`
7. Host receives `credential.resolved` event via event bus
8. Host re-spawns agent with `LINEAR_API_KEY` in env
9. Agent confirms credential is available

**Verify in logs:**
- Host: `post_agent_clawhub_fallback`, `post_agent_new_skill_credentials`, `credential_required_sse`
- Sandbox: `npm install` completes, `credential_request` IPC call, re-spawn with env var

**Fallback test (without SSE client):**
```bash
# In one terminal: watch host logs
npm run k8s:dev logs host

# In another: send request (will emit credential.required and block)
npm run k8s:dev test "install the linear skill from here: https://clawhub.ai/MaTriXy/linear-skill"

# In another: provide credential (get requestId from SSE event in logs)
curl -X POST http://localhost:18080/v1/credentials/provide \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"<session-id>","envName":"LINEAR_API_KEY","value":"lin_api_test123","requestId":"<request-id>"}'
```

---

## Task 5: Model Quality Check

**Observation:** Gemini Flash (the default model in dev) doesn't reliably follow tool-use instructions. It often skips `skill.download` and `credential_request` calls. The ClawHub fallback in the host compensates for `skill.download`, but `credential_request` is harder to compensate for.

**Options:**
1. **Host-side compensation (already partially done):** The post-agent loop in `server-completions.ts` already scans committed files for credential requirements even without `credential_request`. This should work regardless of model quality.
2. **Switch to Claude for testing:** Set `ANTHROPIC_API_KEY` and configure the model in the config to use Claude, which follows tool instructions reliably.
3. **Improve prompt instructions:** Make the `credential_request` tool description more prominent in the prompt builder.

**Recommended:** Validate with option 1 first (host-side detection is model-agnostic). If it works, model quality is not a blocker.

---

## Execution Order

1. **Task 1** (web proxy) — blocks everything else
2. **Task 3** (Helm cleanup) — needed for clean `helm upgrade` before testing
3. **Task 4** (E2E validation) — validates Tasks 1+3
4. **Task 2** (event bus migration) — independent, can be done after E2E works
5. **Task 5** (model quality) — only if E2E reveals model issues

## Key Files Reference

| Component | File | Key Lines |
|---|---|---|
| Web proxy env propagation | `src/host/host-process.ts` | 568 (extraSandboxEnv) |
| Work payload | `src/host/server-completions.ts` | 906 (webProxyUrl) |
| Payload parsing | `src/agent/runner.ts` | 344, 553 (parse + apply) |
| Pi-session proxy bridge | `src/agent/runners/pi-session.ts` | 358-373 |
| Claude-code proxy env | `src/agent/runners/claude-code.ts` | 115-225 |
| Web proxy bridge | `src/agent/web-proxy-bridge.ts` | full file |
| Web proxy approvals | `src/host/web-proxy-approvals.ts` | full file |
| Credential post-agent loop | `src/host/server-completions.ts` | search for `post_agent` |
| Helm dev values | `charts/ax/kind-dev-values.yaml` | 145-157 |
| Web proxy k8s service | `charts/ax/templates/web-proxy-service.yaml` | full file |
