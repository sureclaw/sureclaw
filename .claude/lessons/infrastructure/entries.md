### Admin API must sync MCP server changes to McpConnectionManager
**Date:** 2026-03-30
**Context:** Linear connector was configured via admin dashboard with correct auth headers, but CLI tool wasn't generated because `discoverAllTools()` sent requests without auth. Root cause: admin CRUD only wrote to DB; the in-memory McpConnectionManager was only populated at startup via `loadDatabaseMcpServers()`.
**Lesson:** Any admin API endpoint that modifies persistent state consumed by an in-memory registry must ALSO update the registry. For MCP servers: POST must call `mcpManager.addServer()`, PUT must `removeServer()` + re-read from DB + `addServer()`, DELETE must `removeServer()`. This pattern applies to any DB-backed registry with in-memory caching.
**Tags:** admin-api, mcp, mcpManager, live-sync, server-admin

### MCP tool stubs must support HTTP IPC for k8s mode
**Date:** 2026-03-30
**Context:** "get all linear issues in this cycle" prompt triggered 40+ bash/read_file calls. The generated `_runtime.ts` in `./agent/tools/` only supported Unix socket IPC (`AX_IPC_SOCKET`), which is empty in k8s HTTP IPC mode. The stubs are intentional — they save tokens by keeping MCP tool schemas out of every LLM turn. Do NOT register MCP tools as first-class LLM tools.
**Lesson:** The `_runtime.ts` template must auto-detect transport: check `AX_HOST_URL` for HTTP mode (POST to `/internal/ipc` with Bearer token from `AX_IPC_TOKEN`), fall back to Unix socket. Import paths must use `.ts` extensions (not `.js`) for `node --experimental-strip-types` compatibility. The system prompt must give explicit execution instructions. After changing the runtime template, clear the `tool-stubs` cache in DB (`DELETE FROM documents WHERE collection = 'tool-stubs'`) because the schema hash doesn't cover template changes.
**Tags:** mcp, tool-stubs, codegen, runtime, http-ipc, k8s, experimental-strip-types

### initHostCore must create McpConnectionManager by default
**Date:** 2026-03-29
**Context:** Debugging why /workspace/agent/tools directory was missing in k8s despite 10 MCP connectors being activated. Traced through server-completions.ts → deps.mcpManager was always undefined because neither server-k8s.ts nor server-local.ts passed it to initHostCore, and initHostCore just destructured `undefined` from opts.
**Lesson:** When `initHostCore` creates shared infrastructure (completionDeps) used by both server-local.ts and server-k8s.ts, it must provide sensible defaults for optional deps that are needed at runtime. The `mcpManager` was marked optional in HostCoreOptions but required for tool stub generation. Always create a default instance in the shared init function rather than relying on each caller to create it. Check that optional deps are actually being wired through by searching for all consumers.
**Tags:** server-init, mcp, tool-stubs, optional-deps, completionDeps

### Plugin MCP servers need credential auto-discovery for tool discovery
**Date:** 2026-03-29
**Context:** After fixing McpConnectionManager creation, tool discovery still failed because all plugin-registered MCP servers had NULL headers. The plugin install creates server records without auth configuration, but the servers need Bearer tokens.
**Lesson:** When plugins register MCP servers, they only store `{name, type, url}` — no auth. The `discoverAllTools` method needs an `authForServer` callback that looks up credentials by server name convention (e.g., server "linear" → `LINEAR_API_KEY`). Same pattern needed in tool-router.ts and tool-batch.ts for tool execution. Always wire auth through ALL paths: discovery, execution (tool-router), and batch execution (tool-batch). The `getServerMetaByUrl` return type must include `name` so the tool router can pass server name to `authForServer`.
**Tags:** mcp, auth, credential-discovery, tool-router, tool-batch, plugins

### GCS downloadScope must use parallel downloads, not sequential
**Date:** 2026-03-23
**Context:** User workspace provisioning for 473 files (7.4MB) took ~50 seconds per request because `downloadScope()` downloaded files sequentially — each `file.download()` is a separate GCS API call at ~100ms.
**Lesson:** Always parallelize independent GCS/HTTP file downloads with a concurrency limit (e.g., 20). For 473 files: sequential = ~47s, parallel(20) = ~3s. Don't add in-memory caching on the host for multi-replica correctness — each replica has an independent cache and `setRemoteChanges()` only invalidates locally. Use GCS metadata (object generation) for cross-replica-safe ETags instead.
**Tags:** gcs, workspace, provisioning, parallel, performance, multi-replica

### Empty agent_response causes 120s hang due to JS truthiness check
**Date:** 2026-03-23
**Context:** When the agent only makes tool calls (e.g., skill.install) without generating text, it sends an empty string `''` as agent_response content. The server-completions.ts code used `if (response)` to check if a response was received, but empty string is falsy in JS.
**Lesson:** Never use truthiness (`if (response)`) to check if a Promise-based value was received when empty string is a valid value. Use a separate boolean flag (`agentResponseReceived`) set when the promise resolves. The falsy check caused the host to wait for the cold-start pod's exitCode (~120s via activeDeadlineSeconds) instead of immediately killing it.
**Tags:** k8s, nats, agent_response, truthiness, javascript, empty-response

### Tool availability must match prompt guidance — filter tools based on context flags
**Date:** 2026-03-23
**Context:** The `skill` tool with `type: "install"` was always present in the tool catalog, even when the system prompt said "Do NOT download or re-install" already-installed skills. The LLM followed the tool description over the system prompt.
**Lesson:** When the system prompt tells the LLM NOT to use a capability, also remove the tool from the catalog. Add context flags (like `skillInstallEnabled`) to `ToolFilterContext` and filter tools accordingly. The tool description is often more authoritative to the LLM than system prompt guidance.
**Tags:** tool-catalog, skills, filterTools, LLM, prompt-engineering

### agentResponsePromise timer must start AFTER work is published, not before processCompletion
**Date:** 2026-03-22
**Context:** In k8s NATS mode, the `agentResponsePromise` timeout timer was started in `processCompletionWithNATS` before calling `processCompletion`. The guardian scanner's LLM classification call took ~5 minutes, causing the timer to fire before the sandbox was even spawned.
**Lesson:** Never start timeout timers that guard agent execution time before all pre-processing (scanning, workspace provisioning, CA generation, history loading) completes. Pass a `startAgentResponseTimer` callback through `CompletionDeps` and invoke it in `processCompletion` after `publishWork` succeeds. Pre-processing time is variable and must not eat into the agent's execution timeout budget.
**Tags:** k8s, nats, timeout, scanner, guardian, processCompletion

### macOS Docker Desktop: use host.docker.internal, not bridge gateway
**Date:** 2026-03-20
**Context:** E2e tests with K8s sandbox got ECONNREFUSED when accessing mock server at Docker bridge gateway IP (172.19.0.1) from inside kind containers.
**Lesson:** On macOS, the Docker bridge gateway (172.x.x.x) is inside the Linux VM and doesn't route to the macOS host. Always use `host.docker.internal` on macOS (`process.platform === 'darwin'`) to reach the host from inside kind/Docker containers.
**Tags:** macos, docker, kind, networking, e2e

### K8s sandbox needs all API env vars mapped in Helm secret
**Date:** 2026-03-20
**Context:** K8s sandbox pods got empty LLM responses because OPENROUTER_API_KEY and OPENROUTER_BASE_URL weren't set on the host pod. The Helm `apiCredentials.envVars` mapping had wrong secret keys (kebab-case vs UPPER_CASE).
**Lesson:** The `apiCredentials.envVars` mapping in kind-values.yaml must use the EXACT secret key names created in global-setup.ts. Also include ALL env vars needed by the host (OPENROUTER_BASE_URL, STORAGE_EMULATOR_HOST, etc.), not just API keys. In subprocess mode these were unnecessary because the LLM call path was different; K8s sandbox uses the host's providers directly.
**Tags:** k8s, helm, secrets, e2e, env-vars

### node-forge requires default import, not namespace import
**Date:** 2026-03-19
**Context:** proxy-ca.ts used `import * as forge from 'node-forge'` which worked locally with tsx but crashed in k8s container with `Cannot read properties of undefined (reading 'rsa')`.
**Lesson:** node-forge is a CJS module. `import * as forge` gives `{ default: {...}, 'module.exports': {...} }` — no named exports. Use `import forge from 'node-forge'` to get the actual namespace object with `pki`, `md`, etc.
**Tags:** node-forge, esm, cjs, import, k8s

### Chart-injected Config fields must be in the Zod schema
**Date:** 2026-03-19
**Context:** Added `namespace` to ConfigMap template but not to the Config Zod schema. Host crashed with "unknown field(s): namespace" because `loadConfig()` uses Zod strict mode.
**Lesson:** Any field injected into ax.yaml by the Helm chart template (not from `.Values.config`) must also be added to the Config Zod schema in `src/config.ts`. The strict schema rejects unknown fields.
**Tags:** config, zod, helm, strict-mode

### PodTemplate extra fields need specific index-signature types, not Record<string, unknown>
**Date:** 2026-03-17
**Context:** Adding extraVolumes/extraVolumeMounts to PodTemplate. Used `Array<Record<string, unknown>>` initially but tsc rejected it because the spread into volumes/volumeMounts arrays expects V1Volume/V1VolumeMount which require `name` and `mountPath`.
**Lesson:** When adding pass-through fields to PodTemplate that get spread into K8s API manifests, use index-signature types with required fields (e.g., `Array<{ name: string; [key: string]: unknown }>`) instead of plain `Record<string, unknown>`. The K8s client types are structural and require specific properties.
**Tags:** k8s, typescript, pod-template, types

### run-http-local.ts debug harness must mirror host-process.ts route surface
**Date:** 2026-03-17
**Context:** Debugging why LLM responses hang and identity isn't saved in real k8s clusters. The e2e tests passed but production failed.
**Lesson:** The `run-http-local.ts` harness must expose ALL three k8s HTTP routes that `host-process.ts` provides: (1) `/internal/llm-proxy/*` — claude-code sets `ANTHROPIC_BASE_URL=${AX_HOST_URL}/internal/llm-proxy` and uses per-turn token as `x-api-key`; missing this causes LLM calls to 404 and hang. (2) `/internal/workspace/release` — direct workspace upload from agent. (3) `/internal/workspace-staging` — legacy two-phase upload. Also need `workspace_release` IPC intercept in `wrappedHandleIPC` for the legacy staging path. Any time you add a new `/internal/*` route to `host-process.ts`, add it to the debug harness too.
**Tags:** k8s, debug-harness, llm-proxy, workspace-release, http-ipc, run-http-local

### Queue-group work delivery only happens when the host does not preselect a pod
**Date:** 2026-03-17
**Context:** Reviewing the NATS-centric workspace provisioning plan against the current k8s execution path.
**Lesson:** When the runner subscribes only to `sandbox.work` queue groups, the host must use the queue-group request path before it has a `podName`. If `server-completions.ts` always spawns a k8s pod first and then calls `publishWork(proc.podName, payload)`, `host-process.ts` falls back to `agent.work.{podName}` and bypasses the queue-group flow entirely. Any design that depends on warm-pod queue-group delivery must either change the host dispatch order or keep runner compatibility with the per-pod fallback subject.
**Tags:** nats, queue-group, host-process, runner, k8s, work-delivery

### NATS work delivery needs retry — agent subprocess takes seconds to subscribe
**Date:** 2026-03-17
**Context:** Testing HTTP IPC harness: host spawned agent subprocess and immediately published work via NATS. Message was lost because agent hadn't connected to NATS yet (tsx import + NATS connect takes ~1-2 seconds). Using `nc.publish()` is fire-and-forget — no subscriber = lost message.
**Lesson:** Use `nc.request()` with a retry loop when publishing NATS work to cold-started processes. The agent's `waitForNATSWork()` responds to requests (`msg.respond()`), so `nc.request()` will succeed once the agent has subscribed. Retry every 1s up to 30 times. This handles the startup timing gap without requiring a readiness signal.
**Tags:** nats, race-condition, work-delivery, timing, cold-start

### server.ts createServer() lacks k8s HTTP IPC infrastructure
**Date:** 2026-03-17
**Context:** Tried to test HttpIPCClient using `createServer()` from server.ts with providerOverrides. Failed because server.ts doesn't have: `/internal/ipc` route, `activeTokens` registry, NATS `publishWork`, or `agentResponsePromise`. These are only in `host-process.ts`.
**Lesson:** To test HTTP IPC end-to-end locally, you must build a minimal host process (like `run-http-local.ts`) that sets up the HTTP IPC route, token registry, and NATS publishing. Can't use `createServer()` for this — it only supports socket IPC. The `processCompletion()` function from server-completions.ts is generic enough to accept these deps via `CompletionDeps`.
**Tags:** http-ipc, server, harness, testing, architecture

### encode() is for objects, not pre-serialized strings — watch for double-encoding
**Date:** 2026-03-16
**Context:** NATS 503 bug. `publishWork` called `encode(payload)` where `encode = (obj) => JSON.stringify(obj)` and payload was already a JSON string from `JSON.stringify()` in server-completions.ts. Double-encoding destroyed the entire payload — sandbox received a JSON string literal, not a JSON object. ALL fields (sessionId, requestId, ipcToken) were lost.
**Lesson:** When a function takes `unknown` and does `JSON.stringify(obj)`, never pass a pre-serialized JSON string — you'll get double-encoding. Use `new TextEncoder().encode(str)` for raw string→bytes conversion. The diagnostic clue: byte count mismatch (sender < receiver, because escaping adds bytes) and ALL fields missing (not just one).
**Tags:** nats, double-encoding, json, encode, 503, debugging

### Add diagnostic logging to deployed systems before assuming code fixes work
**Date:** 2026-03-16
**Context:** Made three code fixes for NATS 503 (ipcToken, Helm, permissions) but user still saw same error. Adding `[diag]` stderr lines to trace token flow immediately revealed `ipcToken=MISSING requestId=MISSING` — proving the entire payload was corrupted, not just the token.
**Lesson:** When a fix doesn't work in production, add targeted diagnostics to the deployed code and read the actual output before making more guesses. One line of `process.stderr.write` with the actual values is worth more than ten code reviews.
**Tags:** debugging, diagnostics, production, verification

### NATS 503 has three independent root causes in k8s sandbox
**Date:** 2026-03-16
**Context:** After initial ipcToken code fix, pods still got NATS 503. Deeper investigation revealed two more issues.
**Lesson:** Three things must ALL be correct for warm pool NATS IPC: (1) ipcToken in work payload + setContext → correct subject `ipc.request.{requestId}.{token}`. (2) NATS_SANDBOX_PASS in Helm chart env for pool-controller AND host → pods get NATS credentials. (3) Sandbox NATS user needs `agent.work.>` subscribe permission → pods can receive work. Missing ANY ONE causes 503. Always check all three layers: application code, Helm chart deployment, NATS authorization config.
**Tags:** nats, 503, helm, permissions, k8s, warm-pool, triple-root-cause

### Write reproducing tests before claiming a fix works
**Date:** 2026-03-16
**Context:** First fix for NATS 503 was code-only without tests. User reported it still failed in production and asked "is there a way to reproduce and test your fix before saying it's fixed?"
**Lesson:** Never claim a fix works without a test that reproduces the original failure. Write the test FIRST, confirm it captures the bug's behavior, then fix the code and verify the test passes. For infrastructure bugs (NATS, k8s), also check deployment config (Helm charts, auth config) — code fixes alone may be insufficient.
**Tags:** testing, verification, test-first, bug-fix-policy

### IPC token must travel in NATS work payload, not just pod env vars
**Date:** 2026-03-16
**Context:** Warm pool pods got NATS 503 (No Responders) on every IPC call — LLM calls AND agent_response. Cold-start pods worked fine.
**Lesson:** For warm pool pods, per-turn secrets like `AX_IPC_TOKEN` cannot be passed via pod env vars because the pod is pre-created before the request. The token MUST be included in the NATS work payload (`ipcToken` field in stdinPayload). The runner's `applyPayload()` passes it to `NATSIPCClient.setContext({ token })` which rebuilds the subject to `ipc.request.{requestId}.{token}`. Cold-start pods get it from both env var AND payload (belt and suspenders). Always check: "does this per-turn value need to reach warm pods?"
**Tags:** nats, ipc-token, warm-pool, k8s, 503, no-responders

### NATS work delivery replaces k8s Exec API for warm pods (SUPERSEDED: exec approach)
**Date:** 2026-03-16
**Context:** Eliminated stdin/stdout/exec-based k8s sandbox communication. Previously used k8s Exec API with `env KEY=VAL ... node runner.js` to inject per-turn env vars. Now runner.js IS the standby — it boots at pod creation, connects to NATS, subscribes to `agent.work.{POD_NAME}`, and waits for work. Per-turn context (IPC token, request ID, session ID, message, history, identity, skills) is delivered via the NATS work payload.
**Lesson:** For k8s NATS mode: (1) Runner subscribes to `agent.work.{POD_NAME}` with max=1 — one work message per pod. (2) Host publishes work payload with all per-turn context to this subject. (3) Agent sends response back via `agent_response` IPC action. (4) No exec, no attach, no stdin/stdout pipes. Per-turn env vars go in the NATS payload, not via `env` command injection.
**Tags:** k8s, warm-pool, nats, sandbox, pure-nats

### agent_response IPC action for NATS-mode response delivery
**Date:** 2026-03-16
**Context:** In k8s/NATS mode, stdout can't be used for response delivery (no exec/attach streams). Needed an alternative channel.
**Lesson:** Add an `agent_response` IPC action. Agent runners buffer text output (instead of writing to stdout) when `AX_IPC_TRANSPORT=nats`, then send the buffered text via `client.call({ action: 'agent_response', content })` after session completes. Host intercepts this in the NATS IPC handler and resolves a Promise. Use `subscribeAgentEvents(session, config, { buffer: textBuffer })` to redirect text to an array instead of stdout.
**Tags:** ipc, nats, agent-response, k8s, sandbox

### Redirect pino to stderr (fd 2) in NATS mode to avoid stdout pollution
**Date:** 2026-03-16
**Context:** Even after removing stdout-based response capture for k8s, pino logs on stdout could interfere with future debugging and `kubectl logs` output.
**Lesson:** In logger.ts, check `process.env.AX_IPC_TRANSPORT === 'nats'` and set the console output fd to 2 (stderr) instead of 1 (stdout). Must be applied in all three output modes: pretty formatter Writable stream, sync mode destination, and JSON transport targets. This keeps logs visible via `kubectl logs` stderr while keeping stdout clean.
**Tags:** logging, pino, stderr, nats, k8s

### Mock warm-pool-client directly in integration tests, not via shared k8s mocks
**Date:** 2026-03-16
**Context:** Testing warm pool integration in k8s.ts. Both k8s.ts and warm-pool-client.ts import @kubernetes/client-node. Sharing mock functions across two independent API client instances causes flaky once-queue behavior with vi.clearAllMocks().
**Lesson:** When the module under test dynamically imports another module that creates its own API client, mock the imported module directly (`vi.mock('../../../src/providers/sandbox/warm-pool-client.js')`) instead of relying on shared lower-level mocks. This gives precise control over return values per test without mock queue ordering issues.
**Tags:** testing, vitest, mocking, warm-pool, k8s

### Per-turn capability tokens + bound context solve sandbox session isolation
**Date:** 2026-03-16
**Context:** Implementing NATS auth for k8s sandbox pods. Static NATS users alone don't isolate sessions — sandboxes can publish to each other's subjects.
**Lesson:** Combine two layers: (1) Per-turn unguessable token in the NATS subject (`ipc.request.{requestId}.{token}`) — prevents rogue sandboxes from guessing the subject to hijack. (2) Bound host context in the IPC handler — `_sessionId` and `_userId` from the payload are IGNORED; only the context established when the handler was created is used. Still trust `_agentId` from payload since it's our own sandbox. Pass the token to sandbox pods via `extraEnv` on `SandboxConfig`, read from `AX_IPC_TOKEN` env var in the sandbox.
**Tags:** nats, auth, session-isolation, sandbox, k8s, security, capability-token

### JetStream streams conflict with core NATS request/reply on same subjects
**Date:** 2026-03-16
**Context:** The IPC stream (`ipc.>`) was capturing messages meant for core NATS request/reply (`ipc.request.{requestId}.{token}`), causing publish-ack races.
**Lesson:** When using core NATS request/reply (nc.request()) on subjects that overlap with JetStream streams, the stream captures the message and sends a stream ack to the reply-to inbox before the actual subscriber responds. Fix: remove the JetStream stream from those subjects. IPC uses request/reply (not JetStream) — the IPC stream was unnecessary and harmful.
**Tags:** nats, jetstream, ipc, request-reply, stream-conflict

### Custom PG username requires BOTH AX-level and Bitnami subchart-level auth settings
**Date:** 2026-03-06
**Context:** Deploying with `postgresql.internal.auth.username=ax` caused `CreateContainerConfigError: couldn't find key password in Secret` because the Bitnami subchart only creates `postgres-password` key by default.
**Lesson:** When using a non-postgres username, you must set values at TWO levels: (1) `postgresql.internal.auth.username=ax` for AX templates (`_helpers.tpl:ax.databaseEnv`), AND (2) `postgresql.auth.username=ax` + `postgresql.auth.password=<value>` for the Bitnami subchart to create the `password` key in its secret. The `ax k8s init` CLI should emit both when generating values for a custom username. Also: reusing a PVC from a previous install ignores new secret values — always delete the namespace/PVC when changing PG auth settings.
**Tags:** k8s, helm, postgresql, bitnami, auth, subchart, password, custom-user

### k8s init should use single secret for all API credentials
**Date:** 2026-03-06
**Context:** FIX-2 — k8s init created separate secrets for LLM and embeddings API keys, but the Helm chart's `apiCredentials.envVars` maps all env vars from a single `existingSecret`.
**Lesson:** Keep all API credentials (LLM, embeddings, etc.) in the single `ax-api-credentials` secret via `apiCredentials.envVars`. Don't create separate per-provider secrets with `agentRuntime.env` — it diverges from the chart's native pattern and causes mismatch with kind-values.yaml. When providers share the same secret key name (e.g., both use openai), skip the duplicate literal.
**Tags:** k8s-init, helm, secrets, apiCredentials, embeddings

### Calico DNAT means ClusterIP port != actual port for NetworkPolicy
**Date:** 2026-03-05
**Context:** Agent-runtime pod couldn't reach k8s API (10.96.0.1:443) despite port 443 egress being allowed in NetworkPolicy
**Lesson:** With Calico CNI, egress NetworkPolicy port checks may apply after DNAT. The k8s API ClusterIP service forwards 443→6443. Add BOTH port 443 and port 6443 to egress rules for k8s API access. External HTTPS endpoints (port 443 end-to-end) work fine.
**Tags:** calico, networkpolicy, dnat, k8s-api, kind

### Agent-runtime must use subprocess sandbox for the agent loop in k8s
**Date:** 2026-03-05
**Context:** processCompletion uses providers.sandbox to spawn the agent subprocess. When sandbox=k8s-pod, it creates a new k8s pod that can't connect back via Unix socket IPC.
**Lesson:** In agent-runtime-process.ts, always override providers.sandbox to subprocess for the agent conversation loop. The k8s-pod provider is only for tool dispatch to sandbox worker pods. The agent loop runs in-process (as a subprocess within the agent-runtime pod), not in a separate k8s pod.
**Tags:** k8s, sandbox, agent-runtime, ipc, subprocess

### k8s labels must start/end with alphanumeric characters
**Date:** 2026-03-05
**Context:** Pod creation failed with "Invalid value" for label derived from Unix socket path
**Lesson:** When using user-controlled strings as k8s label values, sanitize with regex: replace invalid chars with `_`, then strip leading/trailing non-alphanumeric with `.replace(/^[^a-zA-Z0-9]+/, '').replace(/[^a-zA-Z0-9]+$/, '')`. Labels must match `(([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9])?`.
**Tags:** k8s, labels, validation, sanitization

### Helm subchart dependencies should be gitignored
**Date:** 2026-03-05
**Context:** Creating Helm chart with NATS and PostgreSQL subcharts
**Lesson:** Add `charts/*/charts/` and `charts/*/Chart.lock` to .gitignore. These are downloaded by `helm dependency update` and should not be committed. The Chart.yaml specifies the version ranges.
**Tags:** helm, gitignore, subcharts

### ConfigMap-mounted config reuses loadConfig() via AX_CONFIG_PATH
**Date:** 2026-03-05
**Context:** Replacing scattered env vars with a single ax.yaml ConfigMap
**Lesson:** Adding `AX_CONFIG_PATH` env var to `configPath()` in paths.ts is all that's needed to support ConfigMap-mounted config in k8s. The existing loadConfig() reads from configPath() and handles all parsing/validation. No changes needed to config.ts itself.
**Tags:** config, helm, k8s, configmap

### Helm `default` treats false as empty — use `ne` for boolean guards
**Date:** 2026-03-06
**Context:** Pool-controller `enabled: false` had no effect because `default true false` returns `true`
**Lesson:** Helm's `default` function treats `false`, `0`, `""`, and `nil` as empty. For boolean opt-out guards, use `{{- if ne .Values.foo.enabled false }}` instead of `{{- if (default true .Values.foo.enabled) }}`.
**Tags:** helm, boolean, guard, template

### Bitnami PostgreSQL subchart only creates postgres-password key
**Date:** 2026-03-06
**Context:** Chart expected a `url` key with full connection string, but bitnami only creates `postgres-password`
**Lesson:** When using bitnami PostgreSQL subchart, construct DATABASE_URL from PGPASSWORD using `$(VAR_NAME)` env var expansion. Define PGPASSWORD first from secretKeyRef, then reference it in DATABASE_URL value field.
**Tags:** helm, postgresql, bitnami, database-url

### Security contexts must stay hardcoded in k8s-client.ts
**Date:** 2026-03-05
**Context:** Making sandbox tier configs Helm-configurable via SANDBOX_TEMPLATE_DIR
**Lesson:** The sandbox templates (light.json, heavy.json) mounted via ConfigMap should ONLY control resources (CPU, memory), image, command, and NATS config. Security context (gVisor runtime, readOnlyRootFilesystem, drop ALL capabilities, runAsNonRoot) must remain hardcoded in `k8s-client.ts:createPod()` — never make security hardening configurable.
**Tags:** security, helm, sandbox, k8s

### Kind cluster pods use app.kubernetes.io/name not component labels
**Date:** 2026-03-05
**Context:** Running KT-3 acceptance test, the label selector `app.kubernetes.io/component=host` returned zero pods
**Lesson:** AX Helm chart labels use `app.kubernetes.io/name=ax-host` and `app.kubernetes.io/name=ax-agent-runtime` for pod selection. The `app.kubernetes.io/component` label is only set on subchart pods (e.g., NATS, PostgreSQL). Always check `kubectl get pods --show-labels` before writing label selectors.
**Tags:** kubernetes, labels, helm, kind, acceptance-tests

### AX container images have no wget or curl — use Node.js for HTTP checks
**Date:** 2026-03-05
**Context:** Running KT-4 health check, both `wget` and `curl` were not found in the host container
**Lesson:** The AX container images are minimal and do not include wget or curl. For HTTP checks inside pods, use `node -e` with the built-in `http` module: `node -e "const http=require('http');http.get('http://localhost:8080/health',(r)=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>console.log('HTTP '+r.statusCode+' '+d))}).on('error',e=>console.error('ERROR: '+e.message))"`.
**Tags:** container, health-check, node, kubernetes, acceptance-tests

### Helm values.yaml must match the Zod config schema exactly
**Date:** 2026-03-05
**Context:** Host pod CrashLoopBackOff due to loadConfig() failing with Zod validation errors
**Lesson:** The AX config uses `z.strictObject()` — any extra keys cause validation failure. Before deploying, render the ConfigMap (`helm template -s templates/configmap-ax-config.yaml`) and validate all fields against the `ConfigSchema` in `src/config.ts`. Common mismatches: `scheduler.active_hours.start/end` must be "HH:MM" strings (not integers), `providers.scanner` must be `patterns` (not `regex`), `providers.scheduler` must be `plainjob` (not `sqlite`), and `models.default` array is required for the LLM router.
**Tags:** config, helm, zod, validation, k8s

### NATS subchart defaults memoryStore.enabled=false
**Date:** 2026-03-05
**Context:** NATS init job failed with "insufficient memory resources" when creating JetStream streams
**Lesson:** The NATS Helm chart (nats-io/nats v1.2.x) defaults `config.jetstream.memoryStore.enabled: false`. Memory-backed streams require explicitly setting `enabled: true` AND a sufficient `maxSize` (256Mi works for 5 streams). Also, `nats server ping` requires a system account — use `nats stream ls` as the readiness check instead.
**Tags:** nats, jetstream, helm, memory-store, kind

### Make gVisor runtimeClassName conditional for dev/test
**Date:** 2026-03-05
**Context:** Pool controller couldn't create sandbox pods on kind: "RuntimeClass gvisor not found"
**Lesson:** gVisor is not available on kind clusters. Make `runtimeClassName` conditional: use spread operator `...(runtimeClass ? { runtimeClassName: runtimeClass } : {})` so it's omitted when empty. The `K8S_RUNTIME_CLASS` env var already exists — set it to empty string to disable. Keep security contexts (readOnlyRootFS, runAsNonRoot, drop ALL) hardcoded regardless.
**Tags:** gvisor, kind, sandbox, k8s, security

### Bitnami subchart values are top-level under the chart alias
**Date:** 2026-03-05
**Context:** PostgreSQL auth failed because password was set at `postgresql.internal.auth.password`
**Lesson:** Helm subchart values are passed at the top level under the chart's alias key, not under custom keys. For the Bitnami PostgreSQL subchart, use `postgresql.auth.password` (NOT `postgresql.internal.auth.password`). The `internal` key is an AX-specific wrapper for the condition flag. Check the subchart's `values.yaml` for the actual schema.
**Tags:** helm, subchart, bitnami, postgresql, values

### Helm presets can't override subchart conditions
**Date:** 2026-03-06
**Context:** Implementing preset-based defaults for NATS cluster mode and PostgreSQL internal/external
**Lesson:** Helm evaluates subchart `condition:` keys (from Chart.yaml dependencies) at the values level BEFORE template rendering. Template helpers in `_presets.tpl` can control our own templates but CANNOT affect whether subcharts deploy. For subchart-controlled settings (NATS cluster, PostgreSQL internal vs external), generate the correct values in the CLI tool's output file rather than relying on preset template logic.
**Tags:** helm, presets, subchart, conditions, nats, postgresql

### Use `kindIs "invalid"` to detect null values in Helm templates
**Date:** 2026-03-06
**Context:** Implementing user override > preset > chart default resolution in Helm
**Lesson:** In Go templates, `nil` (YAML null) has kind "invalid". Use `{{- if not (kindIs "invalid" .Values.foo) -}}` to detect user-provided values vs null defaults. This allows the pattern: null in values.yaml means "use preset or chart default", while any explicit value (including empty string or 0) is treated as a user override.
**Tags:** helm, template, null-detection, presets

### Host deployment needs API credentials for memory recall and extraction
**Date:** 2026-03-06
**Context:** Running k8s cortex acceptance tests -- memory recall and embedding calls returned empty because the host pod had no API keys
**Lesson:** The Helm chart only injects `ax-api-credentials` secret into the agent-runtime deployment. The host deployment also needs API credentials for: (1) embedding-based memory recall (DEEPINFRA_API_KEY for embedding client), and (2) LLM-based memory extraction in the memorize pipeline. Until the chart is fixed, manually patch the host deployment to add envFrom/env referencing the api-credentials secret.
**Tags:** k8s, helm, api-credentials, host, memory-recall, embeddings

### Bitnami PostgreSQL needs explicit auth.password for custom users
**Date:** 2026-03-06
**Context:** Host pod CrashLoopBackOff with "password authentication failed for user ax"
**Lesson:** The Bitnami PostgreSQL subchart only auto-generates `postgres-password` (superuser) in its secret. When using a custom username (e.g., `auth.username: ax`), you MUST also set `auth.password` explicitly, or the `ax` user will be created without a password while the chart's DATABASE_URL uses `postgres-password`. Fix: either set `postgresql.internal.auth.password` in values, or use `auth.username: postgres` to match the auto-generated password.
**Tags:** k8s, helm, postgresql, bitnami, auth, password

### sqlite-vec is available but unused in k8s PostgreSQL mode -- pgvector is the right path
**Date:** 2026-03-06
**Context:** After FIX-7 added build tools to Dockerfile, sqlite-vec loaded on the host pod. But in k8s with PostgreSQL, the cortex provider passes the PostgreSQL `database` object to the EmbeddingStore, which uses pgvector (not sqlite-vec). sqlite-vec is only used in SQLite mode (standalone local development).
**Lesson:** In k8s/PostgreSQL mode, the embedding store uses pgvector, not sqlite-vec. pgvector is available in the Bitnami PostgreSQL 17 image but must be explicitly enabled via `CREATE EXTENSION IF NOT EXISTS vector`. The database provider (`src/providers/database/postgres.ts`) runs this command at init, but requires sufficient privileges. For the Helm chart: either use the `postgres` superuser, or add an init container that enables the extension as superuser before the application starts.
**Tags:** k8s, pgvector, embeddings, postgresql, vector-search, bitnami

### Keyword search LIKE bug: OR-joined terms treated as literal string
**Date:** 2026-03-06
**Context:** Memory recall keyword fallback produced zero results despite matching items existing
**Lesson:** `items-store.ts:searchContent()` uses `WHERE content LIKE '%query%'` where query is the raw output of `extractQueryTerms()` (e.g., "set OR deployment OR pipeline"). This does a literal substring match for the entire string including " OR ". Fix: split on " OR " and generate multiple LIKE conditions joined with SQL OR.
**Tags:** cortex, memory, keyword-search, bug, sql, like

### Both host and agent-runtime have independent cortex provider instances
**Date:** 2026-03-06
**Context:** After enabling pgvector on PostgreSQL and restarting only the host pod, new items from chat still had no embeddings. The memorize code runs on the agent-runtime, which had its own cortex provider instance that was initialized before pgvector was installed.
**Lesson:** In k8s mode, both the host AND agent-runtime pods create independent cortex provider instances. The agent-runtime uses its instance for memory recall (injecting context before conversation) and memorize (storing extracted facts). The host uses its instance for its own operations. Both need pgvector access, both must be restarted after infrastructure changes (like enabling pgvector). Use PostgreSQL advisory locks (`pg_try_advisory_lock`) to coordinate expensive one-time operations like embedding backfill so only one process does the work.
**Tags:** k8s, cortex, agent-runtime, host, provider-instances, pgvector, backfill, advisory-lock

### Use Helm hook Jobs for PostgreSQL extensions and user setup
**Date:** 2026-03-06
**Context:** pgvector needed manual `CREATE EXTENSION` as superuser; custom PG user/database needed manual creation
**Lesson:** Create a `postgresql-init-job.yaml` as a Helm post-install/post-upgrade hook (weight=1, before NATS weight=5) that connects as postgres superuser to: (1) enable pgvector, (2) create custom user/database if configured. Use `bitnami/postgresql:17` as the job image since it includes psql and matches the subchart. Make pgvector creation non-fatal (`|| echo`) since not all PG images include it.
**Tags:** helm, postgresql, pgvector, init-job, hook, bitnami

### NATS nc.request() returns JetStream stream ack instead of worker reply
**Date:** 2026-03-05
**Context:** NATSSandboxDispatcher.claimPod() used `nc.request('tasks.sandbox.light', ...)` to claim a sandbox pod. The TASKS JetStream stream covers `tasks.sandbox.*`. The `nc.request()` returned a 27-byte JetStream publish ack (`{"stream":"TASKS","seq":N}`) instead of the worker's `claim_ack` response.
**Lesson:** When using NATS `nc.request()` on a subject that's covered by a JetStream stream, the server sends a stream publish acknowledgment to the reply-to inbox BEFORE any subscriber responds. Since `nc.request()` returns the first response, it gets the JetStream ack, not the actual reply. **Fix:** Use manual `nc.publish()` with a custom reply-to inbox + `nc.subscribe()` on that inbox, filtering for the expected response type (e.g., `type: 'claim_ack'`) and skipping JetStream acks. Alternatively, avoid overlapping core NATS request/reply subjects with JetStream stream subjects.
**Tags:** nats, jetstream, request-reply, stream-ack, sandbox-dispatch
