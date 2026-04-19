---
name: ax-web-proxy
description: Use when debugging MITM proxy issues, credential placeholder replacement failures, domain allowlist problems, sandbox HTTPS connectivity problems, curl exit 60 SSL errors, ECONNRESET crashes in the proxy, or modifying web-proxy.ts / credential-placeholders.ts / skills/domain-allowlist.ts
---

## Overview

The web proxy is a forward HTTP/HTTPS proxy running on the host that enables sandboxed agents (which have no direct outbound network) to make web requests. In MITM mode it terminates TLS, replaces `ax-cred:<hex>` credential placeholders with real values, scans for canary tokens, and forwards to the real server.

## Architecture

```
Agent sandbox pod (no port 443 egress)
  ↓ HTTP_PROXY / HTTPS_PROXY env vars
  ↓ curl/wget use proxy; Node.js fetch does NOT
MITM Proxy (host pod, port 3128)
  ├── Receives CONNECT host:443
  ├── Checks domain against a session-frozen Set (synchronous, no blocking)
  ├── Terminates TLS with generated domain cert
  ├── Scans decrypted traffic for ax-cred: placeholders
  ├── Replaces placeholders with real credential values
  └── Forwards to real server via upstream TLS
```

**Two proxy instances in k8s:**
- **Shared proxy** (`server.ts`, k8s only): Listens on port 3128 via `ax-web-proxy` Service. `allowedDomains` is BUILTIN_DOMAINS only (infrastructure traffic). Uses `SharedCredentialRegistry`. Session ID = `host-process`.
- **Per-session proxy** (`server-completions.ts`): For Docker/Apple sandboxes (Unix socket) and local TCP. `allowedDomains` is computed per-session via `getAllowedDomainsForAgent(agentId, ...)`. Uses per-session `CredentialPlaceholderMap`.

## Key Files

| File | Role |
|------|------|
| `src/host/web-proxy.ts` | Proxy server: HTTP forward, CONNECT tunnel, MITM TLS interception |
| `src/host/skills/domain-allowlist.ts` | `BUILTIN_DOMAINS` set + `getAllowedDomainsForAgent()` per-agent allowlist query |
| `src/host/skills/skill-domain-store.ts` | `skill_domain_approvals` read/write (tuple-keyed `agent_id, skill_name, domain`) |
| `src/host/credential-placeholders.ts` | `CredentialPlaceholderMap` (per-session) and `SharedCredentialRegistry` (k8s) |
| `src/host/proxy-ca.ts` | CA key generation, domain cert signing |
| `src/host/server-completions.ts` | Per-session proxy startup — computes allowlist via `getAllowedDomainsForAgent` at session start, hands frozen Set to proxy |
| `src/host/server.ts` | Host-process shared proxy for k8s; `allowedDomains` is BUILTIN_DOMAINS only |
| `src/host/server-admin-skills-helpers.ts` | `approveSkillSetup()` — writes domain approvals to `skill_domain_approvals` |
| `src/agent/runner.ts` | CA cert writing, `CURL_CA_BUNDLE`/`SSL_CERT_FILE` setup |
| `src/agent/runners/pi-session.ts` | `HTTP_PROXY`/`HTTPS_PROXY` env var setup |

## Domain Allowlist

A domain is on the per-agent allowlist iff:

1. It's in **`BUILTIN_DOMAINS`** (package manager registries: npmjs.org, pypi.org, GitHub, etc.), OR
2. **Some enabled skill for the agent declares it AND there's an approval row** in `skill_domain_approvals` for that `(agent_id, skill_name, domain)` tuple.

"Enabled skill" = all declared credentials stored + all declared domains approved (live-computed by `getAgentSkills`). A skill that's pending for any reason contributes nothing to the allowlist.

Unknown domains are denied immediately at the proxy boundary; the proxy logs `domain_denied` to its audit trail.

### How domains flow from skill approval to proxy

```
1. User writes .ax/skills/<name>/SKILL.md with domains in frontmatter or body
2. Agent pushes via sidecar; host drops cached snapshot
3. Admin opens the Approvals page; getAgentSkills surfaces the pending card
4. Admin approves the skill (POST /admin/api/skills/setup/approve)
5. approveSkillSetup() writes rows to skill_domain_approvals per (agentId, skillName, domain)
6. Next session, processCompletion calls getAllowedDomainsForAgent which builds
   a frozen Set and hands it to startWebProxy.allowedDomains
7. Subsequent proxy CONNECTs to the domain return 200 Connection Established
```

### Session-scoped allowlist freezing

The allowlist is computed once at session start and frozen for the session's lifetime. Mid-session admin approvals take effect on the NEXT session — this matches prior behavior and keeps the proxy's `has(domain)` check synchronous on the hot path.

## Credential Replacement Flow

```
1. Host registers credential: credentialMap.register("LINEAR_API_KEY", realValue)
   → Returns placeholder: "ax-cred:38e10b8b39a945d1623937f77105e0ff"

2. Host registers map in SharedCredentialRegistry (by reference)
   → sharedCredentialRegistry.register(sessionId, credentialMap)

3. Placeholder sent to agent in NATS payload as credentialEnv
   → Agent sets process.env.LINEAR_API_KEY = "ax-cred:38e10b8b..."

4. Agent bash tool runs: curl -H "Authorization: $LINEAR_API_KEY" https://api.example.com
   → curl sends via HTTPS_PROXY → proxy receives CONNECT

5. Proxy MITM decrypts TLS, sees "Authorization: ax-cred:38e10b8b..."
   → SharedCredentialRegistry.replaceAllBuffer() replaces with real value
   → Forwards to real server with real credential
```

**Critical:** The `credentialMap` is registered in the `SharedCredentialRegistry` BY REFERENCE before credentials are populated. Later `credentialMap.register()` calls are immediately visible to the proxy.

**Critical:** `sharedCredentialRegistry.deregister(sessionId)` runs at session cleanup. If the session ends before the proxy processes the request, replacement fails silently.

## Node.js fetch Does NOT Use HTTP_PROXY

Node.js built-in `fetch` (undici-based) does NOT respect `HTTP_PROXY`/`HTTPS_PROXY` environment variables:

- `curl` through the proxy: **works**
- `wget` through the proxy: **works**
- `node -e "fetch(...)"`: **does NOT go through proxy** — blocked by NetworkPolicy
- Node.js SDKs using `fetch`: **does NOT go through proxy**

Node.js 22+ has `--use-env-proxy` flag but it's not currently wired up.

## CA Certificate Trust

1. Host generates CA in `agentDir/ca/` via `getOrCreateCA()`
2. CA cert PEM sent to agent in NATS payload as `caCert`
3. Agent writes to `/tmp/ax-mitm-ca.pem` (Node.js `NODE_EXTRA_CA_CERTS`)
4. Agent builds combined bundle: system CAs + MITM CA → `/tmp/ax-ca-bundle.pem`
5. Sets `SSL_CERT_FILE`, `CURL_CA_BUNDLE`, `REQUESTS_CA_BUNDLE` to combined bundle

| Symptom | Cause | Fix |
|---------|-------|-----|
| `curl exit 60` | MITM CA not in curl's trust store | Verify `CURL_CA_BUNDLE` points to combined bundle |
| CA cert not written | `payload.caCert` is empty | Check `config.web_proxy` is true |

## Debugging Checklist

1. **Is the proxy running?** Look for `web_proxy_started` in host logs
2. **Is `config.web_proxy` true?** Defaults to true for k8s/docker/apple sandboxes
3. **Is the domain allowed for this agent?** Check the skill is enabled (`getAgentSkills`) AND there's a row in `skill_domain_approvals`. Approve via the Approvals page if missing.
4. **Did you start a fresh session after approving?** The per-session allowlist freezes at session start — mid-session approvals don't apply until the next session.
5. **Are credentials registered?** Look for `credential_injected` in host logs
6. **Did replacement happen?** Check if `credentialMap` has placeholders for the session
7. **Is the session still active?** Credentials deregistered at `session_completed`
8. **Is the agentResponsePromise timer starting after work delivery?** The timer is deferred via `startAgentResponseTimer` callback — it starts after `publishWork` succeeds, not before `processCompletion` runs. If you see `nats_agent_response_error` simultaneous with `nats_work_claimed`, something is wrong with timer deferral.

## Gotchas

- **Node.js `fetch` ignores `HTTP_PROXY`** — only curl/wget/pip respect proxy env vars
- **`SharedCredentialRegistry` is session-scoped** — credentials vanish after `session_completed`
- **Always handle socket errors** in proxy code — unhandled `ECONNRESET` crashes the host process. Add `clientSocket.on('error', ...)` before TLS wrapping.
- **Unapproved skills don't get proxy access** — domains are added to the allowlist only after an admin approves the skill's setup request, which writes to `skill_domain_approvals`. And the allowlist is per-agent: one agent's approvals don't leak to another.
- **Allowlist is frozen per session** — mid-session admin approvals apply on the NEXT session, not the current one.
- **Host-process proxy (k8s) is BUILTIN_DOMAINS only** — it handles infrastructure traffic, not agent traffic. Agent traffic routes through per-session proxies with per-agent allowlists.
- **k8s clusters without host volume mounts** need Docker image rebuild + `kind load` to deploy code changes
