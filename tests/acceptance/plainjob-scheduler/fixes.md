# Fix List: PlainJob Scheduler (K8s)

**Generated from:** acceptance test results (2026-03-05)
**Total issues:** 4 (Critical: 0, Major: 2, Minor: 2)

## Major

### FIX-1: Acceptance test fixture must enable agent-runtime

**Test:** BT-1 (required workaround to pass)
**Environment:** K8s
**Root cause:** Incorrect test setup
**Location:** `tests/acceptance/fixtures/kind-values.yaml`
**What's wrong:** The kind-values.yaml fixture sets `agentRuntime.enabled: false`,
which disables the agent-runtime pod. But the k8s architecture requires it:
`host-process.ts` (host pod) publishes session requests to NATS and
`agent-runtime-process.ts` (agent-runtime pod) subscribes to them, runs
`processCompletion()`, and publishes results back. Without agent-runtime,
completions hang silently for 10 minutes then timeout.

The agent-runtime already handles the subprocess fallback correctly
(lines 119-133 of `agent-runtime-process.ts`): when `sandbox: k8s`, it
overrides to subprocess for the agent loop and uses NATS sandbox dispatch
for tool execution to remote sandbox pods.

**What to fix:** Set `agentRuntime.enabled: true` in `kind-values.yaml`.
The agent-runtime pod will subscribe to NATS, run agents as subprocesses
within its own pod, and publish results back. This is the correct phase-2
architecture — no standalone/all-in-one workaround needed.
**Estimated scope:** 1 file (`tests/acceptance/fixtures/kind-values.yaml`)

### FIX-2: Use PostgreSQL instead of SQLite in k8s environment

**Test:** IT-1, IT-2 (data lost on pod restart)
**Environment:** K8s
**Root cause:** Wrong storage provider for k8s
**Location:** `tests/acceptance/fixtures/kind-values.yaml`
**What's wrong:** The kind-values.yaml uses `storage: sqlite`, `audit: sqlite`,
and `memory: memoryfs` (which uses SQLite internally). SQLite on ephemeral pod
storage loses all data on pod restart — scheduler.db, audit.db, memory stores.
SQLite should never be used in k8s; PostgreSQL is the correct storage backend
for any k8s deployment.
**What to fix:** Update kind-values.yaml to use `storage: postgresql`,
`audit: postgresql`, and any other providers that have PostgreSQL backends.
The chart already deploys PostgreSQL by default and injects `DATABASE_URL`
into pods. Remove the SQLite-specific overrides from the fixture.
**Estimated scope:** 1 file (`tests/acceptance/fixtures/kind-values.yaml`)

## Minor

### FIX-3: Set BIND_HOST=0.0.0.0 in host deployment

**Test:** BT-1 (required workaround to pass)
**Environment:** K8s
**Root cause:** Incorrect default
**Location:** `charts/ax/templates/host/deployment.yaml`
**What's wrong:** `src/host/server.ts` line 868 binds TCP to
`process.env.BIND_HOST ?? '127.0.0.1'`. In k8s, liveness/readiness probes
connect via the pod IP, not localhost. The probes fail and k8s restarts the
pod in a crash loop. Note: `host-process.ts` already binds to `0.0.0.0`
(line 463), so this only affects the all-in-one `server.ts` path. The
agent-runtime also needs this if it exposes a health endpoint via TCP.
**What to fix:** Add `BIND_HOST: "0.0.0.0"` to the host and agent-runtime
deployment env vars in the Helm templates.
**Estimated scope:** 1-2 files (`charts/ax/templates/host/deployment.yaml`,
`charts/ax/templates/agent-runtime/deployment.yaml`)

### FIX-4: Inject API credentials into agent-runtime deployment

**Test:** BT-1 (required workaround to pass)
**Environment:** K8s
**Root cause:** Integration gap
**Location:** `charts/ax/templates/agent-runtime/deployment.yaml`
**What's wrong:** The agent-runtime pod runs `processCompletion()` which makes
LLM calls. It needs API credentials (OPENROUTER_API_KEY, DEEPINFRA_API_KEY, etc.)
injected as env vars from the k8s secret. Verify the agent-runtime deployment
template already has `apiCredentials` rendered — if not, add them.
**What to fix:** Confirm `apiCredentials` env vars are rendered in
`charts/ax/templates/agent-runtime/deployment.yaml`. If missing, add the same
`secretKeyRef` block used elsewhere.
**Estimated scope:** 1 file

## Suggested Fix Order

1. **FIX-1** (enable agent-runtime) — Fixes the fundamental test architecture mismatch
2. **FIX-2** (PostgreSQL) — Correct storage backend for k8s, fixes persistence tests
3. **FIX-3** (BIND_HOST) — One-line fix for probe failures
4. **FIX-4** (API credentials) — Ensure agent-runtime has LLM keys
