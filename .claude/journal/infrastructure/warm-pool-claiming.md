## [2026-03-16 16:00] — Warm sandbox pool claiming for k8s

**Task:** Implement warm pool claiming so pre-warmed k8s pods can be reused for chat turns instead of cold-starting new pods every time.

**What I did:**
- Created `src/providers/sandbox/warm-pool-client.ts` — claims warm pods via label patching (warm → claimed), with optimistic concurrency (retries on 409/404)
- Modified `src/providers/sandbox/k8s.ts` — added warm pool path: try claimPod(), exec agent with env vars via k8s Exec API, fall back to cold start
- Exported `buildExecCommand()` to construct `env KEY=VAL ... <agent-cmd>` for exec into warm pods
- Changed pool controller templates from `['node', 'runner.js']` to `['sleep', '86400']` standby entrypoint — pods wait for exec
- Added `podsClaimed` and `poolMisses` metrics to pool controller
- Updated k8s.ts to factor out `watchPodExit()` and split into `spawnCold()`/`spawnWarm()` paths

**Files touched:**
- `src/providers/sandbox/warm-pool-client.ts` (new)
- `src/providers/sandbox/k8s.ts` (rewritten for warm pool support)
- `src/pool-controller/k8s-client.ts` (added WARM_POD_STANDBY_COMMAND)
- `src/pool-controller/main.ts` (use standby command)
- `src/pool-controller/controller.ts` (init claim metrics)
- `src/pool-controller/metrics.ts` (added claimed/miss metrics + Prometheus output)
- `tests/providers/sandbox/warm-pool-client.test.ts` (new, 8 tests)
- `tests/providers/sandbox/k8s-warm-pool.test.ts` (new, 9 tests)
- `tests/providers/sandbox/k8s.test.ts` (added Exec mock)
- `tests/pool-controller/metrics.test.ts` (updated for new metrics)
- `tests/pool-controller/main.test.ts` (added standby command test)

**Outcome:** Success — 2457 tests pass, 208 test files pass (1 pre-existing NATS infra failure unrelated).

**Notes:** The exec-based approach avoids the env var injection problem: warm pods run a standby sleep command, and the host exec's the agent with all per-turn env vars (IPC token, request ID, canonical paths) via the `env` command. This is simpler than alternatives (NATS config delivery, wrapper entrypoints) and requires no container image changes.
