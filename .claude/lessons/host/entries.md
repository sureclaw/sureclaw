# Host

### provisionScope must use @google-cloud/storage SDK, not gsutil CLI
**Date:** 2026-03-17
**Context:** Agent pods had blank filesystem despite files being in GCS — debugging via `which gsutil` confirmed gsutil absent
**Lesson:** Agent pods don't have the Google Cloud SDK installed. Any in-pod GCS access must use the `@google-cloud/storage` Node.js SDK via lazy import. Never shell out to gsutil in code that runs inside agent pods. The write path already uses HTTP-to-host for the same reason.
**Tags:** k8s, gcs, gsutil, workspace, provisioning, pod, sdk

### GCS write prefix and provisioning prefix must come from the same source
**Date:** 2026-03-17
**Context:** Debugging blank k8s agent filesystem — files showed in GCS but agent saw nothing on next turn
**Lesson:** The GCS backend commits files using `config.workspace.prefix` (from the config file). The work payload builder was using `process.env.AX_WORKSPACE_GCS_PREFIX` for the provisioning prefixes. When only `config.workspace.prefix` was set, provisioning was silently skipped (all three GCS prefix fields were `undefined`). Fix: always derive the provisioning prefix from `config.workspace.prefix ?? process.env.AX_WORKSPACE_GCS_PREFIX`. When adding any read/write pair that both need the same GCS prefix, drive both from the same config source.
**Tags:** k8s, workspace, gcs, provisioning, config, env-var, blank-filesystem

### Streaming SSE must use try/catch/finally around processCompletion
**Date:** 2026-03-16
**Context:** Chat completions from web UIs hung forever when processCompletion threw during streaming mode
**Lesson:** When SSE headers are already sent (`res.headersSent === true`), the outer `handleRequest` catch block can't use `sendError()` — it must send an error SSE chunk + `data: [DONE]` + `res.end()` to close the stream. Always wrap streaming processCompletion in try/catch/finally. The `finally` must unsubscribe event bus listeners and clear keepalive timers. host-process.ts has the reference implementation.
**Tags:** streaming, sse, error-handling, server, hang

### Admin state is filesystem-based and doesn't sync across k8s pods
**Date:** 2026-03-16
**Context:** Fixed k8s agent identity persistence bug. The identity_write IPC handler checked `isAdmin(topDir)` by reading the local filesystem admins file. In k8s with NATS dispatch (separate host pod and agent-runtime pod), the agent-runtime pod always had an empty admins file because admin claims only happen on the host pod. Every identity_write returned `{ queued: true }` instead of persisting data.
**Lesson:** When admin state is filesystem-based and must be accessed from distributed pods, gate the admin check on `hasAnyAdmin()` — only enforce when admins are actually configured. When the admins file is empty (as on agent-runtime pods), skip the gate and let the host layer handle access control. This decouples admin persistence from distributed pod filesystems and avoids the sync problem entirely. Always check: is this gate only needed because I have configured admins, or is it a universal security requirement?
**Tags:** k8s, admin, identity, ipc-handlers, filesystem, nats-dispatch, access-control

### Sandbox tool handlers need their own mountRoot with workspace tier symlinks
**Date:** 2026-03-14
**Context:** After adding per-tier workspace permissions (agent/, user/ dirs), the agent still couldn't see these directories. The sandbox provider created a symlink mountRoot internally for the agent subprocess, but the IPC sandbox tool handlers on the host used workspaceMap (pointing to the scratch dir) as their CWD — no agent/ or user/ siblings existed there.
**Lesson:** When workspace tiers (agent/, user/) are available, processCompletion must create its own symlink mountRoot (via createCanonicalSymlinks) and store it in workspaceMap. The sandbox provider's internal mountRoot is only visible to the agent subprocess, not to the host-side tool handlers. Both sides need their own symlink layout pointing to the same real directories.
**Tags:** sandbox, workspace, symlinks, mountRoot, ipc-handlers, sandbox-tools, server-completions

### Admin TCP port must handle EADDRINUSE gracefully
**Date:** 2026-03-04
**Context:** When adding the admin dashboard with auto-TCP bind, integration tests started failing because multiple test-spawned servers all tried to bind port 8080. The `admin` config defaults to `enabled: true, port: 8080`, so every server instance tried to claim it.
**Lesson:** When auto-binding a TCP port for optional features (admin dashboard), catch EADDRINUSE and log a warning instead of crashing. Only throw for explicit `--port` from the user. Also: always add `admin: { enabled: false }` to test configs (ax-test.yaml) to prevent port conflicts in CI/parallel test runs.
**Tags:** server, admin, tcp, port, eaddrinuse, testing, config-defaults

### Tailwind v4 uses @tailwindcss/postcss, not direct tailwindcss plugin
**Date:** 2026-03-04
**Context:** The dashboard build failed with Tailwind v4 because `tailwindcss` can no longer be used directly as a PostCSS plugin. The PostCSS plugin moved to `@tailwindcss/postcss`. Also, `@tailwind base/components/utilities` directives were replaced with `@import "tailwindcss"`.
**Lesson:** When using Tailwind CSS v4+, use `@tailwindcss/postcss` in postcss.config.js and `@import "tailwindcss"` in CSS files. The `@tailwind` directives and `theme()` function in CSS are v3 patterns.
**Tags:** tailwind, css, postcss, build, dashboard

### IPC defaultCtx.agentId is 'system', not the configured agent name
**Date:** 2026-02-26
**Context:** Image resolver in ipc-handlers/llm.ts used `ctx.agentId` to look up images in user workspace, but images were persisted under `agentName` (typically 'main'). The resolver was looking in `~/.ax/agents/system/users/{user}/workspace/` instead of `~/.ax/agents/main/users/{user}/workspace/`.
**Lesson:** The IPC server's `defaultCtx` has `agentId: 'system'` — this is a fixed global context, not per-request. Any IPC handler that needs the configured agent name (from `config.agent_name`) must receive it as a separate parameter, NOT from `ctx.agentId`. The `agentName` is available in `createIPCHandler` scope and should be threaded through to any handler that needs it. The `_sessionId` injection mechanism only overrides `sessionId`, not `agentId`.
**Tags:** ipc, defaultCtx, agentId, image-resolver, workspace, enterprise

### Plugin providers use a runtime Map, not the static _PROVIDER_MAP
**Date:** 2026-02-27
**Context:** Implementing plugin framework — needed to register third-party providers at runtime without modifying the static allowlist (which would violate SC-SEC-002).
**Lesson:** Plugin-provided providers are stored in a separate `_pluginProviderMap` (Map), not in the `_PROVIDER_MAP` const. `resolveProviderPath()` checks the static map first, then falls back to the plugin map. This preserves the security invariant: built-in providers are static and auditable, while plugin providers are runtime-registered only by the trusted PluginHost after integrity verification. Use `registerPluginProvider()` (not direct map mutation) to add entries, and it will reject any attempt to overwrite built-in providers.
**Tags:** provider-map, plugins, security, SC-SEC-002, allowlist

### Child process IPC for plugins: fork() + process.send(), not worker_threads
**Date:** 2026-02-27
**Context:** Choosing between worker_threads and child_process for plugin isolation in PluginHost.
**Lesson:** Use `child_process.fork()` for plugin isolation, not `worker_threads`. Fork gives proper process isolation (separate V8 heap, can be sandboxed with nsjail), while workers share memory. The IPC protocol is simple: JSON messages over the built-in Node IPC channel (process.send/process.on('message')). Plugin sends `plugin_ready` on startup, host sends `plugin_call` with credentials injected server-side, plugin responds with `plugin_response`. This mirrors the agent<->host IPC pattern already used in AX.
**Tags:** plugins, plugin-host, isolation, child-process, ipc

### Orchestrator handle sessionId must match child agent event requestId
**Date:** 2026-03-01
**Context:** Heartbeat monitor was killing fire-and-forget delegates after 120s despite active tool/LLM work. The handle was registered with the parent's sessionId, but the child agent's events used a different requestId generated in handleDelegate.
**Lesson:** When registering an orchestrator handle for a child agent, the handle's `sessionId` must match the `requestId` that the child's `processCompletion` call will use for its events. Otherwise `sessionToHandles` lookup fails, auto-state never fires, and the heartbeat monitor sees no activity. The delegation handler should generate the child's requestId and pass it to onDelegate via `DelegateRequest.requestId`.
**Tags:** orchestration, heartbeat, delegation, sessionId, auto-state, requestId-alignment

### enableAutoState() must be called in production code
**Date:** 2026-03-01
**Context:** Auto-state inference existed in the orchestrator but was never called in server.ts — only in tests. This meant `tool.call` and `llm.done` events were never mapped to supervisor state transitions in production.
**Lesson:** After adding a feature to the orchestrator (like `enableAutoState()`), always wire it into `server.ts` where the orchestrator is created. Check that production code calls the method, not just tests. Also clean up the subscription in the shutdown path.
**Tags:** orchestration, auto-state, server, wiring, production-vs-test

### Session-to-handle mapping must be 1:N
**Date:** 2026-03-01
**Context:** Multiple agents can share a single sessionId — the auto-state inference map was Map<string, string> which lost earlier handles
**Lesson:** When building a mapping from sessionId to runtime entities (handles, connections), always use Map<string, Set<string>> or Map<string, string[]> to support multiple entities per session. A 1:1 map silently drops concurrent agents in the same session.
**Tags:** orchestrator, session-mapping, multi-agent, data-structure

### resolveCallerHandle OR vs AND bug pattern
**Date:** 2026-03-01
**Context:** Fixing caller identity resolution in orchestration IPC handlers where `bySession()` pre-filters candidates
**Lesson:** When writing `candidates.find()` after a pre-filter like `bySession(ctx.sessionId)`, never use `||` with a condition that the pre-filter already guarantees (e.g. `h.sessionId === ctx.sessionId`). The `||` makes the whole predicate always true, returning the first candidate. Use `&&` to narrow within the pre-filtered set.
**Tags:** logic-bug, find-predicate, orchestration, ipc-handlers

### Orchestration handlers now wired into createIPCHandler
**Date:** 2026-03-01
**Context:** Previously orchestration IPC handlers were defined but never registered in the main dispatcher
**Lesson:** After wiring orchestration handlers via `opts.orchestrator` in `createIPCHandler`, the cross-component test skip set is still needed because that test doesn't configure an orchestrator. Update the comment from "separate handler" to "requires Orchestrator instance" for accuracy.
**Tags:** ipc-server, orchestration, handler-registration, cross-component-test

### Async fire-and-forget needs a collect mechanism, not polling
**Date:** 2026-03-01
**Context:** Added `wait: false` to delegate, told the prompt to "poll via agent_orch_status" — but that IPC action wasn't exposed as an agent tool. The agent resorted to `sleep 15 && echo ...`.
**Lesson:** When adding an async fire-and-forget pattern, always provide a **blocking collect tool** (like `delegate_collect`) that accepts handleIds and awaits all results. Polling is bad UX for LLMs — they improvise with sleep/retry. A collect action that blocks until done is cleaner. Also: verify end-to-end that the agent actually has access to every tool/action referenced in its prompt.
**Tags:** delegation, async, fire-and-forget, agent-tools, prompt-tool-mismatch

### Inject filesystem ops as deps for testable HTTP handlers
**Date:** 2026-03-03
**Context:** Building the webhook handler needed existsSync/readFileSync for transform files, but mocking the filesystem in tests is fragile.
**Lesson:** When a handler needs to check file existence or read files, inject those as callbacks in the deps struct (e.g. `transformExists: (name) => boolean`, `readTransform: (name) => string`) instead of importing fs directly. This makes the handler fully testable with simple mocks and avoids temp file setup/teardown in tests. The server.ts composition root provides the real implementations.
**Tags:** testing, dependency-injection, webhook, server-composition

### Features in server.ts must also be ported to host-process.ts
**Date:** 2026-03-05
**Context:** Webhook transforms were fully implemented in server.ts (local all-in-one) but the k8s host entry point (host-process.ts) was never updated. K8s acceptance tests returned 404 for all webhook routes.
**Lesson:** AX has two HTTP server entry points: `server.ts` (local) and `host-process.ts` (k8s). Any new HTTP route or feature added to server.ts MUST also be ported to host-process.ts — or better, extract the shared route handling into a common module. The dispatch mechanism differs (direct processCompletion vs NATS publish), but route matching, auth, rate limiting, and response shaping should be shared. Always run acceptance tests in BOTH local and k8s environments to catch this class of gap.
**Tags:** host-process, server, k8s, webhook, integration-gap, dual-entry-point

### Per-session NATS LLM proxy must be started for claude-code in k8s mode
**Date:** 2026-03-05
**Context:** Phase 3 implementation had `startNATSLLMProxy()` written but not called in agent-runtime-process.ts. The claude-code runner also lacked k8s detection to switch from TCP bridge to NATS bridge.
**Lesson:** When adding cross-pod communication (like LLM proxying via NATS), both sides must be wired: the proxy subscriber (agent-runtime) AND the publisher (sandbox pod/nats-bridge). The proxy is per-session (scoped to `ipc.llm.{sessionId}`) and must be cleaned up in `finally` blocks. Detection in the agent subprocess uses env vars (`NATS_URL`) since CLI args are set by the host.
**Tags:** nats, llm-proxy, claude-code, k8s, agent-runtime, phase3
