# Pool Controller NATS IPC Updates

## [2026-03-16 07:41] — Update pool controller pod template for NATS IPC

**Task:** Update pool controller pod template to use runner.js with NATS IPC transport, canonical workspace mounts, and proper env vars
**What I did:**
- Updated `k8s-client.ts`: replaced workspace/tmp volumes with scratch/agent-ws/user-ws/tmp canonical mounts, added workingDir `/workspace`, added AX_IPC_TRANSPORT=nats and workspace env vars, removed SANDBOX_WORKSPACE_ROOT
- Updated `main.ts`: changed default command from `dist/sandbox-worker/main.js` to `/opt/ax/dist/agent/runner.js` in both light and heavy tiers
- Updated `charts/ax/values.yaml`: populated sandbox tiers section with light/heavy defaults using runner.js command
- Updated test fixtures in controller.test.ts and main.test.ts to match new command path
**Files touched:**
- src/pool-controller/k8s-client.ts
- src/pool-controller/main.ts
- charts/ax/values.yaml
- tests/pool-controller/controller.test.ts
- tests/pool-controller/main.test.ts
**Outcome:** Success — all 12 pool-controller tests pass
**Notes:** The SANDBOX_WORKSPACE_ROOT env var was replaced by AX_WORKSPACE, AX_AGENT_WORKSPACE, and AX_USER_WORKSPACE for the canonical workspace layout
