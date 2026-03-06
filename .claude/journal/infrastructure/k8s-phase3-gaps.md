# K8s Phase 3 Gaps

## [2026-03-05 19:45] — Wire NATS LLM proxy and NATS bridge for claude-code k8s sessions

**Task:** Fill remaining Phase 3 gaps: NATS LLM proxy not started in agent-runtime for claude-code sessions, and claude-code runner not using NATS bridge in k8s mode.

**What I did:**
1. `agent-runtime-process.ts`: Import `startNATSLLMProxy` and start it per claude-code session when `config.providers.sandbox === 'k8s'`. Proxy is cleaned up in the `finally` block of `processSessionRequest()`.
2. `claude-code.ts`: Added k8s detection (`!config.proxySocket && !!process.env.NATS_URL`). When detected, dynamically imports and starts `startNATSBridge` instead of `startTCPBridge`. Requires `sessionId` for NATS subjects. Updated cleanup to handle async `stop()`.
3. Tests: Added source-level assertion tests in `tests/agent/runners/claude-code.test.ts` (4 new tests for NATS bridge detection) and `tests/host/nats-llm-proxy.test.ts` (3 new tests for agent-runtime wiring).

**Files touched:**
- `src/host/agent-runtime-process.ts` (added import + LLM proxy lifecycle)
- `src/agent/runners/claude-code.ts` (NATS bridge detection + dual-mode bridge)
- `tests/agent/runners/claude-code.test.ts` (4 new tests)
- `tests/host/nats-llm-proxy.test.ts` (3 new tests)

**Outcome:** Success. All 202 test files pass (1 pre-existing k8s mock failure unrelated).

**Notes:** IPC MCP tools still use Unix socket in both modes — NATS transport for IPC tools (memory, web, audit) would require a NATS IPC transport layer, which is a separate task beyond Phase 3 scope.
