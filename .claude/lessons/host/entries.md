# Host

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
