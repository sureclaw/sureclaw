# AX on GKE Autopilot — Fast Sandbox Architecture for the 80% Case

**Goal:** Keep AX's zero-trust security model while reducing latency for common tool calls (`bash`, `git`, `curl`, file ops) in GKE Autopilot, where in-pod namespace sandboxes (`nsjail`, `bwrap`) are unavailable.

**Problem:** The current three-tier model (host → agent runtime → sandbox pod) adds cold-start and routing overhead for tiny commands. In Autopilot, every strong isolation boundary is pod-level, which is safe but expensive for short-lived tasks.

**Proposal:** Replace the single sandbox path with a **policy-routed hybrid execution fabric**:

1. **Lane A (Fast Path): Wasm tool capsules in-process in agent-runtime pods** for deterministic, high-frequency commands.
2. **Lane B (Warm Pod Path): Existing gVisor sandbox pods** for full POSIX commands and risky shells.
3. **Lane C (Heavy Path): Dedicated on-demand pods** for long-running or high-resource workloads.

The host and security invariants remain unchanged: credentials stay out of untrusted execution contexts, all tool input/output is taint-tagged, and all actions are audited.

---

## 1) Why this works on Autopilot

Autopilot blocks kernel namespace tricks in pods, but it does allow:

- standard user-space runtimes (Node.js + Wasm engines)
- gVisor runtime class for strong pod isolation
- queue-driven work routing and warm pools

Wasm gives us process startup in milliseconds without requiring `CAP_SYS_ADMIN`, custom seccomp, or privileged pods.

---

## 2) New execution model: policy-routed lanes

### Lane A — Wasm Capsules (default for 80% commands)

Run small, capability-limited tools inside a Wasm runtime embedded in agent-runtime pods.

**Candidate commands:**
- `bash` subset (simple command chains without background daemons)
- `git status`, `git diff`, `git add`, `git commit --dry-run`, `git ls-files`
- `curl` with strict allowlist and size/time limits
- file transforms (`sed`-like edits, search, patch apply)

**Security posture:**
- No host filesystem access except mounted per-session workspace virtual FS
- No direct network unless explicitly granted per command policy
- Hard CPU/time/memory quotas per invocation
- Deterministic syscall surface (WASI) and no shell escape to host OS

**Performance target:**
- p50 start < 20ms
- p95 end-to-end tool call < 150ms for simple commands

### Lane B — Warm gVisor Sandbox Pods (fallback/default for full shell)

Keep existing sandbox light/heavy warm pools for commands that need full Linux behavior.

**Use when:**
- command not supported by Wasm capsule
- command includes unsupported shell features (job control, arbitrary binaries, TTY-heavy flows)
- policy marks command as high risk

### Lane C — Dedicated Heavy Pods

Current heavy-tier model for large repo operations, long builds, or tool chains requiring full environments.

---

## 3) Router design: "Execution Intent" instead of raw command dispatch

Before executing a tool call, normalize request into an `ExecutionIntent`:

```ts
interface ExecutionIntent {
  tool: 'bash' | 'git' | 'curl' | 'read_file' | 'write_file' | 'edit_file';
  command: string;
  cwd: string;
  expectedCapabilities: {
    needsNetwork: boolean;
    needsFullPosix: boolean;
    maySpawnChildren: boolean;
    ioProfile: 'tiny' | 'medium' | 'large';
  };
  riskScore: number; // computed from policy rules
}
```

Routing policy:

1. If command matches a verified Wasm capsule + capability budget, send to Lane A.
2. Else if command is light and safe but needs full POSIX, send to Lane B.
3. Else send to Lane C.

This keeps the decision explicit, auditable, and tunable.

---

## 4) Wasm capsule strategy

### 4.1 Runtime

Use a maintained embedded runtime (e.g. Wasmtime or Wasmer via Node bindings).

Requirements:
- per-invocation memory cap
- deadline cancellation
- stderr/stdout capture limits
- virtual FS mount for workspace snapshot
- optional egress hook for policy-enforced HTTP

### 4.2 Capsule packaging

Each capsule is a signed artifact with metadata:

```json
{
  "name": "git-lite",
  "version": "1.2.0",
  "sha256": "...",
  "capabilities": ["fs.read", "fs.write"],
  "network": false,
  "maxMemoryMb": 128,
  "maxTimeMs": 5000
}
```

AX verifies signatures and hash before loading.

### 4.3 Command compatibility

Do not attempt full bash compatibility first. Start with explicit subcommands and grow safely:

- `git-lite`: status/diff/add/reset/ls-files
- `http-lite`: curated HTTP client for `curl`-like fetches
- `patch-lite`: safe textual patch operations

Unknown flags/subcommands are rejected or escalated to Lane B.

---

## 5) Security model updates

### Preserved invariants

- No credentials in untrusted execution lanes
- Mandatory taint tagging on all external content
- Complete audit logs for route decision + execution result
- No dynamic imports from config values

### New controls

- **Dual allowlists:** command grammar allowlist + capsule capability allowlist
- **Route attestations:** every tool result records why it ran in Lane A/B/C
- **Capsule provenance:** signature verification + immutable digest pinning
- **Adaptive kill-switch:** cluster-wide flag to disable Lane A instantly

---

## 6) Rollout plan

### Phase 0 — Observe only (no behavior change)

- Add intent classifier and route simulator
- Keep actual execution in existing sandbox pods
- Emit metrics: "would-have-been-lane-A" hit rate

### Phase 1 — Safe read-only capsules

- Enable Lane A for read-only operations (`git status`, `git diff`, file reads)
- Auto-fallback on any runtime error

### Phase 2 — Controlled write operations

- Enable patch/write capsules with stricter quotas
- Add canary by tenant or agent type

### Phase 3 — Curl-lite and policy tuning

- Add constrained network capsule for common fetch patterns
- Keep full curl in Lane B/C for advanced cases

### Phase 4 — Optimize warm pool based on hit rate

- If Lane A handles most calls, shrink light warm-pod baseline to reduce cost

---

## 7) Metrics and SLOs

Track per-lane:

- route distribution (`lane_a`, `lane_b`, `lane_c`)
- latency p50/p95/p99
- fallback rate from Lane A → B/C
- security policy rejection count
- capsule load/verify failures

Initial SLO:

- 70%+ of tool calls served by Lane A
- p95 latency reduction of 3x on common git/file/curl workflows
- zero security invariant regressions

---

## 8) Risks and mitigations

1. **Wasm tool incompatibility with real-world shell usage**
   - Mitigation: strict scope; fast fallback; compatibility telemetry before expansion.

2. **Runtime escape concerns / supply chain risk in capsules**
   - Mitigation: signed artifacts, digest pinning, reproducible builds, staged rollouts.

3. **Operational complexity (three lanes)**
   - Mitigation: one router, one policy DSL, one audit format.

4. **Debuggability**
   - Mitigation: include route decision tree in audit events and trace spans.

---

## 9) Concrete next steps in AX codebase

1. Add `execution-router` provider contract (`src/providers/execution-router/types.ts`).
2. Implement `policy-intent-classifier` in host/IPC tool dispatch path.
3. Add `wasm-capsule` provider with local stub + k8s implementation.
4. Extend audit events with route attestation fields.
5. Add integration tests:
   - route decision correctness
   - automatic fallback behavior
   - invariant checks (no credentials, taint preserved)
6. Run shadow mode in production-like GKE Autopilot namespace for one week.

---

## Recommendation

Adopt the hybrid lane model. It keeps the pod boundary for hard cases, but introduces a Wasm fast path for the repetitive, low-complexity commands that dominate user-perceived latency. This gives us better UX without trading away the security posture that makes AX trustworthy.
