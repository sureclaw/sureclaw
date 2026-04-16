---
name: ax-security
description: Use when modifying security mechanisms — taint budget, canary tokens, path traversal defense, sandbox isolation, scanner patterns, plugin integrity, or any security-sensitive code paths
---

## Overview

AX enforces four security controls across the host/agent boundary. **SC-SEC-001** isolates agents in sandboxed containers with no network or credentials. **SC-SEC-002** loads providers only from a static allowlist in `src/host/provider-map.ts` -- no dynamic imports from config values. **SC-SEC-003** tracks per-session taint ratios and blocks sensitive actions when external content dominates the conversation. **SC-SEC-004** prevents path traversal via `safePath()` on every file-based provider.

## Taint Budget (SC-SEC-003)

| Profile   | Threshold | Meaning                                    |
|-----------|-----------|--------------------------------------------|
| paranoid  | 10%       | Blocks if >10% of session tokens are tainted |
| balanced  | 30%       | Default -- moderate external content allowed |
| yolo      | 60%       | Permissive, still blocks majority-tainted    |

- `TaintBudget` class in `src/host/taint-budget.ts` tracks `taintedTokens / totalTokens` per session.
- `recordContent(sessionId, content, isTainted)` called in `router.processInbound()`.
- `checkAction(sessionId, action)` called in `src/host/ipc-server.ts` as a global gate before handler execution.
- Actions with custom taint handling (`identity_write`, `user_write`, `identity_propose`) skip the global gate and do soft queuing.
- Default sensitive actions: `identity_write`, `user_write`, `oauth_call`, `skill_propose`, `browser_navigate`, `scheduler_add_cron`.

## Canary Tokens

1. **Injection** -- `router.processInbound()` generates canary via `providers.scanner.canaryToken()` (`CANARY-<32hex>`). Appended as `<!-- canary:<token> -->`.
2. **Detection** -- `router.processOutbound()` calls `providers.scanner.checkCanary()`. Canary in response -> full redaction.
3. **Audit** -- Leakage triggers audit log entry (`canary_leaked`, result: `blocked`).
4. **Cleanup** -- Residual tokens stripped via `replaceAll(token, '[REDACTED]')`.

## Safe Path (SC-SEC-004)

`src/utils/safe-path.ts`:
- **`safePath(baseDir, ...segments)`** -- Sanitizes segments (strips `..`, path separators, null bytes, colons), joins to base, resolves, verifies containment. Throws on escape.
- **`assertWithinBase(baseDir, targetPath)`** -- Validates existing path is inside base.
- **Required** in every file-based provider constructing paths from external input.

## Provider Map Security (SC-SEC-002)

- **Static allowlist**: `PROVIDER_MAP` in `src/host/provider-map.ts` maps all (kind, name) pairs to static import paths.
- **URL scheme guard**: Post-resolution `assertFileUrl()` check ensures all resolved paths are `file://` URLs. Prevents protocol confusion attacks (e.g., `data:`, `http:` URLs bypassing the allowlist).
- **Package resolution pinned to module location**: `import.meta.resolve()` resolves relative to the AX installation, not CWD. Prevents attackers from placing malicious packages in project node_modules.
- **Plugin registration**: Runtime allowlist (`_pluginProviderMap`) separate from built-in allowlist. Plugins must pass integrity verification before registration.
- **Cross-provider import prevention**: Shared types extracted to `src/providers/shared-types.ts` and `src/providers/router-utils.ts` to avoid providers importing from sibling provider directories.

## Plugin Integrity

- **SHA-512 hashing**: Plugin lock file (`~/.ax/plugins.lock`) stores SHA-512 hashes of installed packages.
- **Startup verification**: `verifyPluginIntegrity()` called before PluginHost registers providers.
- **Capability declarations**: Plugins declare network, filesystem, and credential needs in MANIFEST.json. No wildcards allowed.
- **Worker isolation**: Plugin workers spawned via fork() with restricted env vars (no credentials).
- **Credential injection**: Plugins never see the credential store. Server resolves credentials and injects via IPC.

### Cowork Plugin Security

Cowork plugins (installed via `ax plugin install`) are stored in DocumentStore with per-agent isolation. Plugin MCP servers are registered in `McpConnectionManager` and routed through the unified tool router. Plugin skill domains are added to the web proxy allowlist. Plugin sources are validated during installation.

## Subagent Delegation Security

- **Depth/concurrency limits**: `maxDepth` (default 2), `maxConcurrent` (default 3) prevent runaway delegation chains.
- **Zombie counter prevention**: `activeDelegations` counter wrapped in try/finally to prevent stuck counters blocking all future delegations.
- **Taint budget inheritance**: Child agents inherit parent's remaining taint budget.
- **Separate sandbox**: Each delegated agent gets its own sandbox, IPC socket, and taint budget.

## Skill Screening

- **Static screener** (`src/providers/screener/static.ts`): 5-layer analysis with scoring:
  1. Hard-reject (BLOCK): exec(), spawn(), eval(), fetch()
  2. Exfiltration (FLAG): webhook.site, requestbin, data exfil URLs
  3. Prompt injection (FLAG): zero-width chars, role reassignment
  4. External deps (FLAG): CDN scripts, curl-pipe-to-shell
  5. Capability mismatch (FLAG): undeclared fs.write, process.env
- **Score thresholds**: >= 0.8 -> REJECT, >= 0.3 -> REVIEW, < 0.3 -> APPROVE

## Taint Tagging

- All external content is wrapped: `<external_content trust="external" source="...">...</external_content>`.
- `TaintTag` structure: `{ source, trust: 'user' | 'external' | 'system', timestamp }`.
- Wrapping happens in `router.processInbound()`. Messages from `provider !== 'system'` are marked tainted.

## Sandbox Isolation (SC-SEC-001)

- **No network** -- Agent containers deny all TCP/IP. Unix sockets allowed only for IPC (local). HTTP-based IPC for K8s pods (no NATS).
- **No credentials** -- API keys and OAuth tokens never enter the container.
- **Three-phase orchestration** -- Containers use provision (network) -> run (no network) -> cleanup (network). Network is only available during provisioning and cleanup phases.
- **4 canonical mounts**: `/workspace` (root/CWD), `/workspace/scratch` (rw), `/workspace/agent` (ro), `/workspace/user` (ro). Identity files are sent via stdin payload from git. Skills live in `.ax/skills/` in the git workspace.
- **Local sandbox execution with audit gate** -- In container mode, tools execute inside the agent's container with host audit approval (`sandbox_approve` -> execute -> `sandbox_result`).
- **Sandbox tools via IPC** -- bash, read_file, write_file, edit_file route through IPC to host-side handlers (`src/host/ipc-handlers/sandbox-tools.ts`), enforcing `safePath()` containment.
- **HTTP IPC for K8s** -- Per-turn capability tokens (`AX_IPC_TOKEN`) authenticate HTTP requests. Uses `HttpIPCClient` → `POST /internal/ipc`.
- **Warm pool** -- Pre-warmed pods claimed via NATS queue groups for K8s deployments.
- Providers: subprocess (dev fallback), Docker, Apple Container, K8s pods (HTTP IPC).

### HTTP Forward Proxy (Controlled Outbound Access)

Opt-in (`config.web_proxy`, disabled by default) HTTP forward proxy (`src/host/web-proxy.ts`) allows agents to make outbound HTTP/HTTPS requests (npm install, pip install, curl, git clone) while preserving `--network=none`. Security controls on the proxy:

- **Private IP blocking (SSRF)**: Same private IP ranges as the fetch provider -- `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16` (cloud metadata), `::1`, `fe80:`, `fc/fd`.
- **Canary token scanning**: HTTP request bodies scanned for canary tokens before forwarding. In MITM mode, canary scanning also applies to decrypted HTTPS traffic. Blocks exfiltration attempts.
- **Audit logging**: Every proxy request logged with method, URL, status, bytes, duration, block reason, and `credentialInjected` flag.
- **Transport**: Container sandboxes (Docker/Apple) reach the proxy via a mounted Unix socket (`web-proxy.sock` in IPC dir) + TCP loopback bridge (`web-proxy-bridge.ts`). K8s pods connect directly via a k8s Service (`ax-web-proxy.{namespace}.svc:3128`). Subprocess mode uses a TCP port.
- **MITM TLS inspection**: When skills require third-party API keys, the proxy upgrades from blind CONNECT tunneling to TLS-terminating MITM. A host-generated CA cert is injected into sandboxes. The proxy generates per-domain certs, decrypts traffic, replaces credential placeholders with real values, and scans for canary tokens.
- **Credential placeholder injection**: Skills declare `requires.env` in frontmatter. The host generates opaque `ax-cred:<hex>` tokens, injects them as env vars. The MITM proxy replaces them with real credentials in intercepted HTTPS headers/bodies. Real credentials never enter the container.
- **Interactive credential prompting**: When a skill requires an env var that isn't in the credential store, the host emits a `credential.required` event via the event bus and blocks until the user provides the value. Resolution paths: (1) SSE named event `credential_required` in the chat completions stream + `POST /v1/credentials/provide`; (2) admin dashboard SSE + `POST /admin/api/credentials/provide`. Provided credentials are stored for future sessions. The credential never touches the agent — it stays host-side.
- **MITM bypass**: `config.mitm_bypass_domains` (string array) lists domains that skip MITM inspection and use raw TCP tunneling (for cert-pinning CLIs).
- **CA trust chain**: `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE` env vars point to the AX CA cert in the sandbox.

## Install Validation

- **`src/utils/bin-exists.ts`**: Cross-platform binary lookup with strict regex validation (`[a-zA-Z0-9_.-]+`). Rejects paths and shell metacharacters.
- **`src/agent/skill-installer.ts`**: Reads SKILL.md install specs, runs missing installs with package-manager prefix env vars. Uses `execFileSync(shell, [flag, cmd])` for explicit shell invocation.

## Common Tasks

### Adding a new sensitive action to taint budget
1. Add to `DEFAULT_SENSITIVE_ACTIONS` in `src/host/taint-budget.ts`.
2. If soft blocking needed, skip it in the global gate in `ipc-server.ts` and call `checkAction()` inside the handler.
3. Add test in `tests/host/taint-budget.test.ts`.

### Adding a new scanner pattern
1. Add pattern to `src/providers/scanner/patterns.ts`.
2. Add test cases in `tests/providers/scanner/`.

## Invariants

- Credentials never enter agent containers. Third-party API keys are injected as opaque placeholders; real values exist only in host memory and are substituted by the MITM proxy at request time.
- No network access from agent processes (TCP/IP denied; Unix socket IPC (local) or HTTP IPC (k8s)). Opt-in web proxy provides controlled outbound HTTP with SSRF blocking, canary scanning, and MITM credential injection.
- All external content is taint-tagged before reaching the agent.
- Provider loading uses static allowlist only -- no dynamic path construction from config.
- Every file path from untrusted input passes through `safePath()`.
- Canary tokens are stripped or redacted before responses reach the user.
- All security-relevant actions are audit-logged.
- `ipc-schemas.ts` uses `.strict()` mode -- no unexpected fields pass validation.
- Plugin providers verified against SHA-512 hashes before loading.
- Resolved provider paths must be `file://` URLs (SC-SEC-002 defense-in-depth).
