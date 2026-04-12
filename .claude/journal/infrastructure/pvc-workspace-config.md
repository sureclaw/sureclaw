## [2026-04-06 10:20] — Configurable workspace PVC size + aggressive pod idle timeout

**Task:** Make PVC workspace size configurable (Phase 4 of PVC Workspace plan) and reduce pod idle timeout since PVCs preserve state
**What I did:**
1. Added `workspace_size_gi` (int, 1-100, default 10) to config schema, types, sandbox types, and Helm values
2. Threaded `workspaceSizeGi` through SandboxConfig -> server-completions -> k8s.ts ensurePvc()
3. Reduced default `idle_timeout_sec` from 1800 (30 min) to 300 (5 min) in values.yaml and server-k8s.ts fallback
4. Added 3 tests: PVC with custom size, PVC with default size, PVC volume mount verification
**Files touched:**
- src/config.ts (added workspace_size_gi to Zod schema)
- src/types.ts (added workspace_size_gi to Config sandbox type)
- src/providers/sandbox/types.ts (added workspaceSizeGi to SandboxConfig)
- src/providers/sandbox/k8s.ts (pass workspaceSizeGi to ensurePvc)
- src/host/server-completions.ts (pass workspace_size_gi through to sandboxConfig)
- src/host/server-k8s.ts (reduced idle_timeout_sec default from 1800 to 300)
- charts/ax/values.yaml (added workspace_size_gi: 10, changed idle_timeout_sec: 1800 -> 300)
- tests/providers/sandbox/k8s.test.ts (added PVC mock functions + 3 new tests)
**Outcome:** Success. Build passes, all 20 k8s sandbox tests pass, no new test failures.
**Notes:** PVCs persist installed tools/packages across pod restarts, so pods can be killed aggressively (5 min idle). The 30-min idle timeout was only needed when emptyDir meant losing all state.
