## [2026-03-16 11:30] — Merge agent-runtime into host + NATS auth

**Task:** Implement plan to eliminate agent-runtime middleman, merge processCompletion into host pod, add per-turn capability tokens and static NATS auth.

**What I did:**
1. Created `src/utils/nats.ts` centralized NATS connection helper with NATS_USER/NATS_PASS support
2. Rewrote `src/host/host-process.ts` to call processCompletion() directly instead of NATS dispatch
3. Added per-turn capability tokens — token-scoped NATS subjects `ipc.request.{requestId}.{token}`
4. NATSIPCHandler uses bound host context (ignores payload _sessionId/_userId for security)
5. Added host RBAC (ServiceAccount, Role, RoleBinding) for sandbox pod management
6. Added NATS static user auth: host (full access) + sandbox (restricted pub/sub)
7. Removed agent-runtime chart components (deployment, SA, role, rolebinding, presets, values)
8. Removed SESSIONS, RESULTS, IPC JetStream streams (keep EVENTS + TASKS)
9. Trimmed nats-session-protocol.ts to only encode/decode/eventSubject
10. Updated all test files (7 files, 54 tests), created new tests/utils/nats.test.ts
11. Fixed claude-code runner to pass requestId + token to startNATSBridge

**Files touched:**
- Created: `src/utils/nats.ts`, `tests/utils/nats.test.ts`, `charts/ax/templates/host/{serviceaccount,role,rolebinding}.yaml`, `charts/ax/templates/nats-auth-secret.yaml`
- Deleted: `src/host/agent-runtime-process.ts`, `charts/ax/templates/agent-runtime/{deployment,serviceaccount,role,rolebinding}.yaml`
- Modified: `src/host/host-process.ts`, `src/host/nats-ipc-handler.ts`, `src/host/nats-llm-proxy.ts`, `src/host/nats-session-protocol.ts`, `src/host/server-completions.ts`, `src/agent/nats-ipc-client.ts`, `src/agent/nats-bridge.ts`, `src/agent/runners/claude-code.ts`, `src/providers/eventbus/nats.ts`, `src/providers/sandbox/types.ts`, `src/providers/sandbox/k8s.ts`, `charts/ax/values.yaml`, `charts/ax/templates/_presets.tpl`, `charts/ax/templates/host/deployment.yaml`, `charts/ax/templates/nats-stream-init-job.yaml`, `charts/ax/templates/NOTES.txt`
- Tests modified: `tests/host/nats-ipc-handler.test.ts`, `tests/host/nats-llm-proxy.test.ts`, `tests/host/nats-session-protocol.test.ts`, `tests/agent/nats-ipc-client.test.ts`, `tests/agent/nats-bridge.test.ts`, `tests/providers/sandbox/k8s.test.ts`, `tests/integration/nats-ipc-roundtrip.test.ts`

**Outcome:** Success — `npm run build` compiles clean, all 2440 tests pass across 207 test files.

**Notes:** Architecture simplified from 3-pod (host → agent-runtime → sandbox) to 2-pod (host → sandbox). Per-turn capability tokens prevent cross-session NATS subject guessing. Static NATS users (host/sandbox) add defense-in-depth at the network layer.
