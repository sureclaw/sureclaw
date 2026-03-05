# Acceptance Tests: K8s Agent Compute Architecture

**Plan document(s):** `docs/plans/2026-03-04-k8s-agent-compute-architecture.md`
**Date designed:** 2026-03-05
**Total tests:** 42 (ST: 16, HT: 8, KT: 8, IT: 6, SEC: 4)
**Test platform:** kind (Kubernetes IN Docker) with Calico CNI

## Test Categories

| Category | Prefix | What it verifies | How |
|----------|--------|-----------------|-----|
| **Structural** | ST | Code shape, interfaces, provider contracts, security hardening | Read source files, grep patterns |
| **Helm Template** | HT | Chart renders correctly, k8s resources are well-formed | `helm template` + assertions on rendered YAML |
| **Kind Cluster** | KT | Infrastructure deploys, pods start, services connect | Deploy to kind cluster, check pod status/readiness |
| **Integration** | IT | End-to-end flows through the three-layer architecture | HTTP requests against deployed cluster |
| **Security** | SEC | Isolation, credential separation, network restrictions | kubectl exec, network probes, env inspection |

## Kind Cluster Adaptations

| GKE Autopilot Feature | Kind Equivalent | Test Impact |
|------------------------|-----------------|-------------|
| gVisor `runtimeClassName` | Not available | **Skip gVisor tests.** Verify the field is set in pod specs but don't assert runtime isolation. |
| Autopilot `requests==limits` | Not enforced | Verify Helm values set requests==limits; don't assert QoS class. |
| Cloud SQL (PostgreSQL) | Bitnami subchart (`postgresql.internal.enabled: true`) | Use internal PostgreSQL, not external secret. |
| GCS workspace cache | Not available | **Skip GCS tests.** Verify git-clone workspace setup only. |
| KEDA autoscaling | Not available | Skip HPA/KEDA tests. |
| Performance compute class | Not available | Skip `nodeSelector` for heavy tier. |
| Node auto-provisioning | All nodes pre-exist | No cold-start latency testing. |

### Kind Cluster Setup (Prerequisites)

```bash
# Create kind cluster with Calico for NetworkPolicy support
cat <<EOF | kind create cluster --name ax-test --config=-
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
  - role: control-plane
  - role: worker
  - role: worker
EOF

# Install Calico CNI for NetworkPolicy enforcement
kubectl apply -f https://raw.githubusercontent.com/projectcalico/calico/v3.27.0/manifests/calico.yaml
kubectl -n kube-system rollout status daemonset/calico-node --timeout=120s

# Build and load AX images into kind
docker build -t ax/host:test -f container/Dockerfile .
docker build -t ax/agent:test -f container/Dockerfile.agent .  # if separate
kind load docker-image ax/host:test ax/agent:test --name ax-test

# Create test namespace and secrets
kubectl create namespace ax-test
kubectl -n ax-test create secret generic ax-db-credentials \
  --from-literal=url="postgresql://ax:ax@ax-postgresql:5432/ax"
kubectl -n ax-test create secret generic ax-api-credentials \
  --from-literal=anthropic-api-key="$ANTHROPIC_API_KEY"

# Install chart with kind-specific overrides
helm dependency update charts/ax
helm install ax charts/ax -n ax-test -f tests/acceptance/k8s-agent-compute/kind-values.yaml
```

### kind-values.yaml (Test Overrides)

```yaml
# Smaller resource footprint for kind
host:
  replicas: 1
  image:
    repository: ax/host
    tag: test
  resources:
    requests: { cpu: "250m", memory: "256Mi" }
    limits: { cpu: "250m", memory: "256Mi" }

agentRuntime:
  replicas: 1
  image:
    repository: ax/host
    tag: test
  resources:
    requests: { cpu: "500m", memory: "1Gi" }
    limits: { cpu: "500m", memory: "1Gi" }

poolController:
  replicas: 1
  image:
    repository: ax/host
    tag: test
  reconcileIntervalMs: 3000  # faster for testing

sandbox:
  image:
    repository: ax/agent
    tag: test
  tiers:
    light:
      minReady: 1        # smaller warm pool
      maxReady: 3
      template:
        cpu: "500m"       # smaller for kind
        memory: "512Mi"
    heavy:
      minReady: 0
      maxReady: 1
      template:
        cpu: "1"
        memory: "2Gi"
        nodeSelector: {}  # remove GKE-specific selector

postgresql:
  external:
    enabled: false
  internal:
    enabled: true
    auth:
      database: ax
      username: ax
      existingSecret: ""

nats:
  enabled: true
  config:
    cluster:
      enabled: false     # single node for kind
      replicas: 1
    jetstream:
      enabled: true
      memoryStore:
        maxSize: 64Mi
      fileStore:
        maxSize: 1Gi
        pvc:
          size: 2Gi

networkPolicies:
  enabled: true

config:
  providers:
    storage: postgresql
    eventbus: nats
    sandbox: k8s-pod
```

---

## Summary of Acceptance Criteria

Extracted from the plan's design principles, component details, NATS topology, execution flows, security model, and phased implementation validation criteria.

### Architecture & Separation
1. Three-layer separation: stateless HTTP ingress (host pods), conversation processing (agent runtime pods), isolated code execution (sandbox pods)
2. NATS JetStream is the single communication layer between all components
3. Provider contracts preserve local dev: `ax start` on a laptop works exactly as today

### Provider Abstractions
4. StorageProvider interface with sqlite and postgresql implementations
5. EventBusProvider interface with inprocess and nats implementations
6. k8s-pod SandboxProvider creates pods with gVisor, security hardening, no credentials

### NATS Topology
7. Five JetStream streams: SESSIONS, TASKS, RESULTS, EVENTS, IPC
8. Queue group consumers for load distribution across pods
9. Per-turn pod affinity for sandbox tool dispatch

### Execution Flows
10. Pi-session chat: host → NATS session dispatch → agent runtime → LLM → NATS events → host → SSE
11. Pi-session with tools: agent runtime → NATS sandbox dispatch → warm pod → tool execution → result
12. Claude-code session: on-demand pod → NATS LLM proxy → agent runtime → Anthropic API
13. Agent delegation: parent agent → NATS → child agent runtime → result via NATS

### Security
14. Pod boundary is the security boundary (no in-pod multi-tenant isolation)
15. No credentials in sandbox pods (LLM calls proxied via NATS)
16. NetworkPolicy: sandbox pods can only reach NATS + DNS
17. gVisor runtime for kernel-level isolation (deferred on kind)
18. No cross-tenant pod reuse
19. IPC validation via Zod schemas with `.strict()` mode

### Pool Controller
20. Warm pool maintenance: reconciliation loop creates/deletes pods to meet minReady/maxReady
21. Tiered resources: light (1 CPU / 2Gi) and heavy (4 CPU / 16Gi)

### Helm Chart
22. ConfigMap-mounted ax.yaml reuses existing loadConfig() code path
23. NATS stream init job creates all five streams post-install
24. RBAC: agent-runtime and pool-controller have pod CRUD permissions
25. Sandbox template configs rendered as JSON in ConfigMap

### Observability
26. Health endpoints on all components
27. Metrics ports exposed

---

## Structural Tests

### ST-1: StorageProvider interface has all required sub-stores

**Criterion:** "StorageProvider interface with MessageQueue, Conversations, Sessions, Documents sub-stores"
**Plan reference:** Section 5, New Provider Abstractions — StorageProvider

**Verification steps:**
1. Read `src/providers/storage/types.ts`
2. Check `StorageProvider` interface exports sub-stores: messages, conversations, sessions, documents
3. Verify `documents` sub-store has: get, put (or set), delete, list methods
4. Verify `messages` sub-store has: enqueue, dequeue, complete, fail methods

**Expected outcome:**
- [ ] `StorageProvider` interface has `messages`, `conversations`, `sessions`, `documents` sub-stores
- [ ] `documents` has key-value CRUD methods for identity/skills/config storage
- [ ] Both `sqlite` and `postgresql` implementations exist

**Pass/Fail:** _pending_

---

### ST-2: PostgreSQL StorageProvider uses connection pool and atomic dequeue

**Criterion:** "Connection pool via pg or Kysely" and "atomic UPDATE...RETURNING for dequeue"
**Plan reference:** Section 5, StorageProvider — postgresql implementation

**Verification steps:**
1. Read `src/providers/storage/postgresql.ts`
2. Check for `pg` Pool or Kysely usage for connection management
3. Check dequeue uses `FOR UPDATE SKIP LOCKED` for safe concurrent access
4. Check `replaceTurnsWithSummary` uses transactions

**Expected outcome:**
- [ ] Uses `pg` Pool with connection pooling
- [ ] `dequeue()` uses `SELECT ... FOR UPDATE SKIP LOCKED` or similar atomic pattern
- [ ] Transaction support for multi-step operations
- [ ] `create(config)` factory function matches provider contract

**Pass/Fail:** _pending_

---

### ST-3: EventBusProvider interface with inprocess and nats implementations

**Criterion:** "EventBusProvider abstracts event bus for cross-pod event distribution"
**Plan reference:** Section 5, New Provider Abstractions — EventBusProvider

**Verification steps:**
1. Read `src/providers/eventbus/types.ts`
2. Verify interface: emit, subscribe, subscribeRequest, listenerCount, close
3. Read `src/providers/eventbus/inprocess.ts` — wraps existing EventBus
4. Read `src/providers/eventbus/nats.ts` — uses NATS JetStream

**Expected outcome:**
- [ ] Interface re-exports StreamEvent and EventListener types
- [ ] `inprocess` provider wraps existing `createEventBus()`
- [ ] `nats` provider publishes to `events.{requestId}` and `events.global`
- [ ] Both registered in `provider-map.ts`

**Pass/Fail:** _pending_

---

### ST-4: k8s-pod SandboxProvider creates hardened pods

**Criterion:** "runtimeClassName: gvisor, readOnlyRootFilesystem, runAsNonRoot, drop ALL capabilities"
**Plan reference:** Section 4, Sandbox Pods — Security; Section 8, Security Model

**Verification steps:**
1. Read `src/providers/sandbox/k8s-pod.ts`
2. Check pod spec includes `runtimeClassName: gvisor` (or configurable)
3. Check securityContext: `readOnlyRootFilesystem: true`, `runAsNonRoot: true`, `capabilities: { drop: ['ALL'] }`
4. Verify security context is HARDCODED (not configurable via values — per CLAUDE.md lesson)
5. Check that no API credentials are passed to sandbox pods (no ANTHROPIC_API_KEY env var)

**Expected outcome:**
- [ ] `runtimeClassName` set (gvisor or configurable via K8S_RUNTIME_CLASS env)
- [ ] `readOnlyRootFilesystem: true` in securityContext
- [ ] `runAsNonRoot: true` with `runAsUser: 1000`
- [ ] `capabilities.drop: ['ALL']`
- [ ] Security context hardcoded in code, not configurable via Helm values
- [ ] No credential env vars (ANTHROPIC_API_KEY, DATABASE_URL) in pod spec

**Pass/Fail:** _pending_

---

### ST-5: NATS session protocol defines correct subjects and message types

**Criterion:** "session.request.{agentType}" dispatch, "results.{requestId}" completion, "events.{requestId}" streaming
**Plan reference:** Section 6, NATS Topology — Streams

**Verification steps:**
1. Read `src/host/nats-session-protocol.ts`
2. Check SessionRequest type: requestId, sessionId, content, history, userId, agentConfig
3. Check subject mapping: `session.request.pi-session`, `session.request.claude-code`
4. Check result subject: `results.{requestId}`
5. Check queue group name: `ax-agent-runtime`

**Expected outcome:**
- [ ] SessionRequest includes all fields from plan (requestId, sessionId, content, etc.)
- [ ] Subject patterns match plan: `session.request.*`, `results.*`, `events.*`
- [ ] Queue group `ax-agent-runtime` for competing consumers
- [ ] Serialization uses TextEncoder/TextDecoder (JSON over NATS)

**Pass/Fail:** _pending_

---

### ST-6: NATS sandbox dispatch implements per-turn pod affinity

**Criterion:** "First tool call in a turn claims a warm pod... Subsequent tool calls with the same requestId routed to the same pod"
**Plan reference:** Section 4, Pi-Session Tool Pods — Per-turn affinity

**Verification steps:**
1. Read `src/host/nats-sandbox-dispatch.ts`
2. Check claim request publishes to `tasks.sandbox.{tier}` queue group
3. Check pod responds with unique subject `sandbox.{podId}`
4. Check affinity tracking: subsequent tool calls use `sandbox.{podId}` directly (not queue group)
5. Check release message sent at turn end

**Expected outcome:**
- [ ] First tool call → publish to queue group → warm pod claims → returns unique subject
- [ ] Affinity map: `requestId → podSubject` tracked in memory
- [ ] Subsequent calls go to `sandbox.{podId}` (direct, not queue group)
- [ ] Release message sent to `sandbox.{podId}` with `type: "release"` at turn end
- [ ] Claim timeout (60s) and tool timeout (120s) configured

**Pass/Fail:** _pending_

---

### ST-7: NATS LLM proxy for claude-code sandbox pods

**Criterion:** "Claude Code CLI → HTTP → NATS bridge → ipc.llm.{sessionId} → agent runtime proxies to Anthropic"
**Plan reference:** Section 4, Claude-Code Agent Pods — HTTP-to-NATS bridge

**Verification steps:**
1. Read `src/host/nats-llm-proxy.ts` — server-side (agent runtime pod)
2. Check it subscribes to `ipc.llm.{sessionId}`
3. Check it proxies requests to Anthropic API using real credentials
4. Read `src/agent/nats-bridge.ts` — client-side (sandbox pod)
5. Check it starts local HTTP server and publishes to NATS

**Expected outcome:**
- [ ] Agent runtime subscribes to `ipc.llm.{sessionId}` queue group
- [ ] Proxies request to Anthropic with real API key (from pod env)
- [ ] Sandbox-side bridge starts HTTP on localhost, sets `ANTHROPIC_BASE_URL`
- [ ] Also handles IPC tool calls via `ipc.request.{sessionId}`
- [ ] No API credentials in sandbox-side code

**Pass/Fail:** _pending_

---

### ST-8: Host-process is stateless HTTP-only (no agent loops, no LLM calls)

**Criterion:** "Host pods do NOT: run agent conversation loops, make LLM API calls, spawn sandbox processes, hold any session state in memory"
**Plan reference:** Section 4, Host Pods — What they do NOT do

**Verification steps:**
1. Read `src/host/host-process.ts`
2. Grep for LLM-related imports (should be none: no `anthropic`, no `llm` provider calls)
3. Grep for `processCompletion` (should NOT be called — replaced by NATS dispatch)
4. Grep for sandbox spawning (should be none)
5. Check it publishes to NATS `session.request.*` and subscribes to `events.*` / `results.*`

**Expected outcome:**
- [ ] No direct LLM API calls from host-process
- [ ] No `processCompletion` — replaced by NATS publish
- [ ] No sandbox subprocess spawning
- [ ] Routes: `/v1/chat/completions`, `/health`, `/v1/models`, `/v1/events` (SSE)
- [ ] All session state goes to PostgreSQL (via StorageProvider), not in-memory

**Pass/Fail:** _pending_

---

### ST-9: Agent-runtime-process claims sessions from NATS queue group

**Criterion:** "Agent runtime pod claims a session.request.pi-session message from NATS queue group"
**Plan reference:** Section 7, Execution Flows — Flow 1 step 3

**Verification steps:**
1. Read `src/host/agent-runtime-process.ts`
2. Check it subscribes to `session.request.*` with queue group
3. Check it loads conversation history from PostgreSQL (via StorageProvider)
4. Check it spawns agent subprocess (pi-session or claude-code)
5. Check it publishes events to NATS EventBus and results to `results.{requestId}`

**Expected outcome:**
- [ ] Subscribes to `session.request.*` via NATS queue group `ax-agent-runtime`
- [ ] Loads history from `providers.storage.conversations`
- [ ] Spawns agent subprocess via existing runner infrastructure
- [ ] Publishes streaming events to `events.{requestId}` via EventBusProvider
- [ ] Publishes final result to `results.{requestId}`
- [ ] Saves conversation to PostgreSQL after completion

**Pass/Fail:** _pending_

---

### ST-10: Sandbox worker subscribes to NATS and executes tools

**Criterion:** "Warm pod subscribes to tasks.sandbox.{tier} via NATS queue group, claims tool task, executes, publishes result"
**Plan reference:** Section 4, Pi-Session Tool Pods — Lifecycle

**Verification steps:**
1. Read `src/sandbox-worker/worker.ts`
2. Check it subscribes to `tasks.sandbox.{tier}` via NATS queue group
3. Check claim/response protocol for warm pool assignment
4. Check tool execution: bash, read_file, write_file, edit_file
5. Check path traversal protection via `safeResolve()`
6. Read `src/sandbox-worker/types.ts` for message types

**Expected outcome:**
- [ ] Subscribes to `tasks.sandbox.{tier}` queue group
- [ ] Handles claim request → responds with unique `sandbox.{podId}` subject
- [ ] Executes bash commands with configurable timeout
- [ ] Executes file operations with path containment (safeResolve)
- [ ] Handles release message → cleans up workspace → returns to warm state
- [ ] Message types: ClaimRequest, ToolRequest (bash/read/write/edit), ReleaseRequest

**Pass/Fail:** _pending_

---

### ST-11: Pool controller reconciliation loop

**Criterion:** "Reconciliation loop: count ready → create/delete to target"
**Plan reference:** Section 4, Pool Controller

**Verification steps:**
1. Read `src/pool-controller/controller.ts`
2. Check reconciliation loop: list warm pods → compare to minReady/maxReady → create/delete
3. Read `src/pool-controller/k8s-client.ts` — pod CRUD via @kubernetes/client-node
4. Check tier-based filtering via pod labels (`ax.io/tier`, `ax.io/status=warm`)
5. Check metrics emission (warmPods, podsCreated, podsDeleted)

**Expected outcome:**
- [ ] Reconciliation loop runs on configurable interval (RECONCILE_INTERVAL_MS)
- [ ] For each tier: counts warm pods, creates if below minReady, deletes if above maxReady
- [ ] Uses `ax.io/tier` and `ax.io/status=warm` labels for filtering
- [ ] Supports tier config from JSON files (SANDBOX_TEMPLATE_DIR) or hardcoded defaults
- [ ] Metrics: warm_pods_available, pods_created, pods_deleted, reconcile_count

**Pass/Fail:** _pending_

---

### ST-12: IPC sandbox tools handler supports dual local/NATS mode

**Criterion:** "In local mode, IPC handlers execute locally. In k8s mode, dispatch via NATS."
**Plan reference:** Phase 1, Task 3 — Move bash/file tools from local to IPC

**Verification steps:**
1. Read `src/host/ipc-handlers/sandbox-tools.ts`
2. Check it handles: sandbox_bash, sandbox_read_file, sandbox_write_file, sandbox_edit_file
3. Check dual mode: local execution when sandbox is subprocess/docker, NATS dispatch when k8s-pod
4. Check integration with `NATSSandboxDispatcher`
5. Check `safePath()` usage for path containment (SC-SEC-004)

**Expected outcome:**
- [ ] Handles four IPC actions: sandbox_bash, sandbox_read_file, sandbox_write_file, sandbox_edit_file
- [ ] Local mode: executes directly (subprocess/docker sandbox provider)
- [ ] K8s mode: dispatches via NATSSandboxDispatcher to sandbox pods
- [ ] Uses safePath() for all path construction
- [ ] Tracks workspace paths per sessionId

**Pass/Fail:** _pending_

---

### ST-13: Provider map has storage, eventbus, and k8s-pod entries

**Criterion:** "Three new providers registered in provider-map.ts"
**Plan reference:** Section 5, Provider map additions

**Verification steps:**
1. Read `src/host/provider-map.ts`
2. Check `storage` section: `{ sqlite, postgresql }`
3. Check `eventbus` section: `{ inprocess, nats }`
4. Check `sandbox` section includes `'k8s-pod'`

**Expected outcome:**
- [ ] `storage: { sqlite: '...sqlite.js', postgresql: '...postgresql.js' }`
- [ ] `eventbus: { inprocess: '...inprocess.js', nats: '...nats.js' }`
- [ ] `sandbox` includes `'k8s-pod': '...k8s-pod.js'`
- [ ] All paths are static strings (SC-SEC-002 — no dynamic construction)

**Pass/Fail:** _pending_

---

### ST-14: Config types include new provider names

**Criterion:** "Config.providers extended with storage, eventbus names"
**Plan reference:** Section 12, Migration — Backwards Compatibility

**Verification steps:**
1. Read `src/types.ts`
2. Check `Config.providers` includes `storage: StorageProviderName` and `eventbus: EventBusProviderName`
3. Check ProviderRegistry includes `storage` and `eventbus`
4. Check SandboxProviderName includes `'k8s-pod'`

**Expected outcome:**
- [ ] `StorageProviderName = 'sqlite' | 'postgresql'`
- [ ] `EventBusProviderName = 'inprocess' | 'nats'`
- [ ] `SandboxProviderName` includes `'k8s-pod'`
- [ ] `ProviderRegistry` has `storage: StorageProvider` and `eventbus: EventBusProvider`

**Pass/Fail:** _pending_

---

### ST-15: AX_CONFIG_PATH environment variable support

**Criterion:** "configPath() respects AX_CONFIG_PATH env var"
**Plan reference:** Section 13, Helm Chart — Key Design Decision

**Verification steps:**
1. Read `src/paths.ts`
2. Check `configPath()` checks `process.env.AX_CONFIG_PATH` before default path
3. Verify it falls back to `~/.ax/ax.yaml` when env var not set

**Expected outcome:**
- [ ] `configPath()` returns `process.env.AX_CONFIG_PATH` when set
- [ ] Falls back to default `~/.ax/ax.yaml` when not set
- [ ] No breaking changes to local dev workflow

**Pass/Fail:** _pending_

---

### ST-16: Sandbox worker workspace setup with safeResolve

**Criterion:** "Ephemeral workspace, path traversal protection"
**Plan reference:** Section 9, Workspace & Storage Strategy; Section 8, Security Model

**Verification steps:**
1. Read `src/sandbox-worker/workspace.ts`
2. Check workspace root is configurable via env var
3. Read `src/sandbox-worker/worker.ts`
4. Check all file paths resolved through `safeResolve()` relative to workspace root
5. Verify no path traversal possible (e.g., `../../etc/passwd`)

**Expected outcome:**
- [ ] Workspace root from env var (default `/workspace`)
- [ ] `safeResolve(workspaceRoot, path)` called for all file operations
- [ ] Path traversal attempts rejected (throws error)
- [ ] Workspace cleanup on release

**Pass/Fail:** _pending_

---

## Helm Template Tests

These tests use `helm template` to render the chart and assert on the output YAML. No cluster needed.

### HT-1: Chart renders without errors with kind values

**Criterion:** Helm chart should render cleanly with test overrides
**Plan reference:** Section 13, Helm Chart

**Verification steps:**
```bash
helm template ax charts/ax \
  -f tests/acceptance/k8s-agent-compute/kind-values.yaml \
  --namespace ax-test > /tmp/ax-rendered.yaml
echo "EXIT_CODE=$?"
```

**Expected outcome:**
- [ ] `helm template` exits 0
- [ ] Output YAML is valid (parseable by `kubectl apply --dry-run=client`)
- [ ] All five resource types present: Deployment (3), Service (1), ConfigMap (2), Role (2), Job (1)

**Pass/Fail:** _pending_

---

### HT-2: ConfigMap renders full ax.yaml from values

**Criterion:** "Renders .Values.config as ax.yaml"
**Plan reference:** Section 13, Key Design Decision — ConfigMap-Mounted ax.yaml

**Verification steps:**
```bash
helm template ax charts/ax -f kind-values.yaml -s templates/configmap-ax-config.yaml
```
1. Check output has `data.ax.yaml` key
2. Parse the embedded YAML and verify it matches `.Values.config`
3. Check providers: `storage: postgresql`, `eventbus: nats`, `sandbox: k8s-pod`

**Expected outcome:**
- [ ] ConfigMap name: `ax-config` (or `{release}-config`)
- [ ] `data["ax.yaml"]` contains valid AX config
- [ ] Providers match: `{ storage: postgresql, eventbus: nats, sandbox: k8s-pod }`
- [ ] All other config fields present (profile, agent, sandbox, scheduler, etc.)

**Pass/Fail:** _pending_

---

### HT-3: NATS stream init job creates five streams

**Criterion:** "Five JetStream streams: SESSIONS, TASKS, RESULTS, EVENTS, IPC"
**Plan reference:** Section 6, NATS Topology — Streams

**Verification steps:**
```bash
helm template ax charts/ax -f kind-values.yaml -s templates/nats-stream-init-job.yaml
```
1. Check Job has `helm.sh/hook: post-install,post-upgrade`
2. Check script creates exactly 5 streams: SESSIONS, TASKS, RESULTS, EVENTS, IPC
3. Check subject patterns match plan
4. Check retention policies: work-queue for SESSIONS/TASKS/IPC, limits for RESULTS/EVENTS

**Expected outcome:**
- [ ] SESSIONS: subjects `session.request.*`, retention `work`, storage `memory`
- [ ] TASKS: subjects `tasks.sandbox.*`, retention `work`, storage `memory`
- [ ] RESULTS: subjects `results.*`, retention `limits`, max-msgs-per-subject 1
- [ ] EVENTS: subjects `events.>`, retention `limits`, storage `memory`
- [ ] IPC: subjects `ipc.>`, retention `work`, storage `memory`
- [ ] All streams have appropriate max-age (5m-30m)

**Pass/Fail:** _pending_

---

### HT-4: Host deployment has AX_CONFIG_PATH, NATS_URL, DATABASE_URL env vars

**Criterion:** "Every pod mounts ax.yaml at /etc/ax/ax.yaml and sets AX_CONFIG_PATH"
**Plan reference:** Section 13, Helm Chart

**Verification steps:**
```bash
helm template ax charts/ax -f kind-values.yaml -s templates/host/deployment.yaml
```
1. Check env vars: AX_CONFIG_PATH=/etc/ax/ax.yaml, NATS_URL, DATABASE_URL (from secret), PORT
2. Check volumeMount: ax-config at /etc/ax (readOnly: true)
3. Check NO ANTHROPIC_API_KEY (host pods don't make LLM calls)
4. Check readiness/liveness probes on /health

**Expected outcome:**
- [ ] `AX_CONFIG_PATH: /etc/ax/ax.yaml`
- [ ] `NATS_URL` set from helper template
- [ ] `DATABASE_URL` from secretKeyRef
- [ ] NO `ANTHROPIC_API_KEY` env var
- [ ] Volume mount: `/etc/ax` from ConfigMap, readOnly
- [ ] Readiness probe: GET /health
- [ ] Plane label: `ax.io/plane: ingress`

**Pass/Fail:** _pending_

---

### HT-5: Agent-runtime deployment has ANTHROPIC_API_KEY and K8S_NAMESPACE

**Criterion:** "Agent runtime pod has credentials, creates sandbox pods via k8s API"
**Plan reference:** Section 4, Agent Runtime Pods

**Verification steps:**
```bash
helm template ax charts/ax -f kind-values.yaml -s templates/agent-runtime/deployment.yaml
```
1. Check env vars include ANTHROPIC_API_KEY (from secret), K8S_NAMESPACE, K8S_POD_IMAGE
2. Check serviceAccountName references the sandbox-manager SA
3. Check terminationGracePeriodSeconds: 600 (long agent sessions)
4. Check plane label: `ax.io/plane: conversation`

**Expected outcome:**
- [ ] `ANTHROPIC_API_KEY` from secretKeyRef `ax-api-credentials`
- [ ] `K8S_NAMESPACE` set to chart namespace
- [ ] `K8S_POD_IMAGE` set to sandbox image (`ax/agent:test`)
- [ ] `serviceAccountName: {release}-agent-runtime`
- [ ] `terminationGracePeriodSeconds: 600`
- [ ] Config checksum annotation for rolling restarts

**Pass/Fail:** _pending_

---

### HT-6: Pool controller has SANDBOX_TEMPLATE_DIR and sandbox template ConfigMap

**Criterion:** "Sandbox tier configs rendered as JSON files in ConfigMap"
**Plan reference:** Section 13, Sandbox Templates

**Verification steps:**
```bash
helm template ax charts/ax -f kind-values.yaml \
  -s templates/pool-controller/deployment.yaml \
  -s templates/pool-controller/configmap-sandbox-templates.yaml
```
1. Check deployment env: SANDBOX_TEMPLATE_DIR=/etc/ax/sandbox-templates, RECONCILE_INTERVAL_MS
2. Check volume mount: sandbox-templates at /etc/ax/sandbox-templates
3. Check ConfigMap has `light.json` and `heavy.json` keys
4. Check each tier JSON has: tier, minReady, maxReady, template.{image, command, cpu, memory, natsUrl}

**Expected outcome:**
- [ ] Deployment mounts two ConfigMaps: ax-config + sandbox-templates
- [ ] `SANDBOX_TEMPLATE_DIR=/etc/ax/sandbox-templates`
- [ ] `light.json`: minReady=1, maxReady=3, cpu=500m, memory=512Mi (kind values)
- [ ] `heavy.json`: minReady=0, maxReady=1, cpu=1, memory=2Gi (kind values)
- [ ] Template JSON includes `natsUrl` for pod connectivity
- [ ] Checksum annotations on both ConfigMaps

**Pass/Fail:** _pending_

---

### HT-7: RBAC roles grant pod CRUD permissions

**Criterion:** "Agent runtime: pod CRUD for sandbox management. Pool controller: pod CRUD for warm pool."
**Plan reference:** Section 13, Chart Structure — role.yaml files

**Verification steps:**
```bash
helm template ax charts/ax -f kind-values.yaml \
  -s templates/agent-runtime/role.yaml \
  -s templates/pool-controller/role.yaml
```
1. Check agent-runtime role: pods (get, list, watch, create, delete), pods/log (get)
2. Check pool-controller role: pods (get, list, watch, create, delete, patch)
3. Verify RoleBindings reference correct ServiceAccounts

**Expected outcome:**
- [ ] Agent-runtime Role: `pods` verbs `[get, list, watch, create, delete]` + `pods/log` verbs `[get]`
- [ ] Pool-controller Role: `pods` verbs `[get, list, watch, create, delete, patch]`
- [ ] RoleBindings bind to respective ServiceAccounts
- [ ] Roles are namespaced (Role, not ClusterRole)

**Pass/Fail:** _pending_

---

### HT-8: NetworkPolicy restricts sandbox pods to NATS and DNS only

**Criterion:** "Sandbox pods can only reach NATS (k8s NetworkPolicy)"
**Plan reference:** Section 8, Security Model — NetworkPolicy for Sandbox Pods

**Verification steps:**
```bash
helm template ax charts/ax -f kind-values.yaml \
  -s templates/networkpolicies/sandbox-restrict.yaml
```
1. Check podSelector matches `ax.io/plane: execution`
2. Check policyTypes: [Ingress, Egress]
3. Check egress: NATS (port 4222, podSelector for nats) + DNS (port 53 UDP+TCP)
4. Check ingress: empty (no inbound)

**Expected outcome:**
- [ ] Targets pods with `ax.io/plane: execution` label
- [ ] Egress allowed to NATS pods on port 4222 only
- [ ] Egress allowed to DNS on port 53 (UDP + TCP)
- [ ] No other egress allowed (no internet, no PostgreSQL, no LLM APIs)
- [ ] Ingress: empty array (no inbound connections)
- [ ] Conditional on `networkPolicies.enabled`

**Pass/Fail:** _pending_

---

## Kind Cluster Tests

These tests require a running kind cluster with the chart deployed. They verify that pods start, connect, and operate correctly.

### KT-1: All pods reach Running state

**Criterion:** All AX components start successfully in the kind cluster
**Plan reference:** Section 4, Component Details — all components

**Setup:**
- kind cluster created with Calico CNI
- AX chart installed with kind-values.yaml
- Wait up to 5 minutes for all pods

**Verification steps:**
```bash
# Wait for all deployments
kubectl -n ax-test rollout status deployment/ax-host --timeout=300s
kubectl -n ax-test rollout status deployment/ax-agent-runtime --timeout=300s
kubectl -n ax-test rollout status deployment/ax-pool-controller --timeout=300s

# Check NATS StatefulSet
kubectl -n ax-test rollout status statefulset/ax-nats --timeout=300s

# Check PostgreSQL
kubectl -n ax-test rollout status statefulset/ax-postgresql --timeout=300s

# List all pods
kubectl -n ax-test get pods -o wide
```

**Expected outcome:**
- [ ] `ax-host` deployment: 1/1 Ready
- [ ] `ax-agent-runtime` deployment: 1/1 Ready
- [ ] `ax-pool-controller` deployment: 1/1 Ready
- [ ] `ax-nats-0` pod: Running
- [ ] `ax-postgresql-0` pod: Running
- [ ] No pods in CrashLoopBackOff or Error state

**Pass/Fail:** _pending_

---

### KT-2: NATS JetStream streams created by init job

**Criterion:** "Five JetStream streams created post-install"
**Plan reference:** Section 6, NATS Topology

**Verification steps:**
```bash
# Check init job completed
kubectl -n ax-test get jobs | grep nats-stream-init

# Port-forward to NATS and list streams
kubectl -n ax-test port-forward svc/ax-nats 4222:4222 &
PF_PID=$!
sleep 2

# Using nats CLI (or nats-box pod)
kubectl -n ax-test run nats-check --rm -i --restart=Never \
  --image=natsio/nats-box:latest -- \
  nats --server=nats://ax-nats:4222 stream ls

kill $PF_PID 2>/dev/null
```

**Expected outcome:**
- [ ] Init Job status: Completed (1/1)
- [ ] Stream `SESSIONS` exists with subjects `session.request.*`
- [ ] Stream `TASKS` exists with subjects `tasks.sandbox.*`
- [ ] Stream `RESULTS` exists with subjects `results.*`
- [ ] Stream `EVENTS` exists with subjects `events.>`
- [ ] Stream `IPC` exists with subjects `ipc.>`

**Pass/Fail:** _pending_

---

### KT-3: PostgreSQL accepts connections from host and agent-runtime pods

**Criterion:** "PostgreSQL shared state accessible from all components"
**Plan reference:** Section 3, Architecture Overview — Cloud SQL

**Verification steps:**
```bash
# From host pod
HOST_POD=$(kubectl -n ax-test get pod -l app.kubernetes.io/component=host -o jsonpath='{.items[0].metadata.name}')
kubectl -n ax-test exec $HOST_POD -- \
  sh -c 'node -e "const{Pool}=require(\"pg\");const p=new Pool({connectionString:process.env.DATABASE_URL});p.query(\"SELECT 1 as ok\").then(r=>console.log(JSON.stringify(r.rows[0]))).catch(e=>console.error(e)).finally(()=>p.end())"'

# From agent-runtime pod
RUNTIME_POD=$(kubectl -n ax-test get pod -l app.kubernetes.io/component=agent-runtime -o jsonpath='{.items[0].metadata.name}')
kubectl -n ax-test exec $RUNTIME_POD -- \
  sh -c 'node -e "const{Pool}=require(\"pg\");const p=new Pool({connectionString:process.env.DATABASE_URL});p.query(\"SELECT 1 as ok\").then(r=>console.log(JSON.stringify(r.rows[0]))).catch(e=>console.error(e)).finally(()=>p.end())"'
```

**Expected outcome:**
- [ ] Host pod: `{"ok":1}` — PostgreSQL connection works
- [ ] Agent-runtime pod: `{"ok":1}` — PostgreSQL connection works
- [ ] Both use DATABASE_URL from k8s secret

**Pass/Fail:** _pending_

---

### KT-4: Host pod health endpoint returns 200

**Criterion:** "Readiness probe: GET /health"
**Plan reference:** Section 4, Host Pods

**Verification steps:**
```bash
# Port-forward to host service
kubectl -n ax-test port-forward svc/ax-host 8080:8080 &
PF_PID=$!
sleep 2

curl -sf http://localhost:8080/health
HEALTH_STATUS=$?

curl -sf http://localhost:8080/v1/models
MODELS_STATUS=$?

kill $PF_PID 2>/dev/null
echo "Health: $HEALTH_STATUS, Models: $MODELS_STATUS"
```

**Expected outcome:**
- [ ] `/health` returns HTTP 200
- [ ] `/v1/models` returns HTTP 200 with model list
- [ ] Readiness probe passes (pod stays Ready)

**Pass/Fail:** _pending_

---

### KT-5: Pool controller creates warm sandbox pods

**Criterion:** "Maintains warm pool of pi-session tool pods"
**Plan reference:** Section 4, Pool Controller — Reconciliation loop

**Verification steps:**
```bash
# Wait for pool controller to reconcile (3s interval in kind-values)
sleep 10

# Check for warm sandbox pods
kubectl -n ax-test get pods -l ax.io/tier=light,ax.io/status=warm

# Count should match minReady (1 in kind-values)
WARM_COUNT=$(kubectl -n ax-test get pods -l ax.io/tier=light,ax.io/status=warm --no-headers | wc -l)
echo "Warm pods: $WARM_COUNT"
```

**Expected outcome:**
- [ ] At least 1 warm pod with labels `ax.io/tier=light`, `ax.io/status=warm`
- [ ] Warm pod is Running
- [ ] Pod uses sandbox image (`ax/agent:test`)
- [ ] No heavy-tier warm pods (minReady=0 in kind-values)

**Pass/Fail:** _pending_

---

### KT-6: NATS connectivity from all component pods

**Criterion:** "NATS is the single communication layer between all components"
**Plan reference:** Design Principle 3

**Verification steps:**
```bash
# From host pod
HOST_POD=$(kubectl -n ax-test get pod -l app.kubernetes.io/component=host -o jsonpath='{.items[0].metadata.name}')
kubectl -n ax-test exec $HOST_POD -- \
  sh -c 'node -e "const{connect}=require(\"nats\");connect({servers:process.env.NATS_URL}).then(nc=>{console.log(\"CONNECTED\");nc.close()}).catch(e=>console.error(e))"'

# From agent-runtime pod
RUNTIME_POD=$(kubectl -n ax-test get pod -l app.kubernetes.io/component=agent-runtime -o jsonpath='{.items[0].metadata.name}')
kubectl -n ax-test exec $RUNTIME_POD -- \
  sh -c 'node -e "const{connect}=require(\"nats\");connect({servers:process.env.NATS_URL}).then(nc=>{console.log(\"CONNECTED\");nc.close()}).catch(e=>console.error(e))"'

# From pool controller pod
CTRL_POD=$(kubectl -n ax-test get pod -l app.kubernetes.io/component=pool-controller -o jsonpath='{.items[0].metadata.name}')
kubectl -n ax-test exec $CTRL_POD -- \
  sh -c 'node -e "const{connect}=require(\"nats\");connect({servers:process.env.NATS_URL}).then(nc=>{console.log(\"CONNECTED\");nc.close()}).catch(e=>console.error(e))"'
```

**Expected outcome:**
- [ ] Host pod: `CONNECTED` — NATS reachable
- [ ] Agent-runtime pod: `CONNECTED` — NATS reachable
- [ ] Pool controller pod: `CONNECTED` — NATS reachable
- [ ] All pods use the same NATS_URL from Helm template

**Pass/Fail:** _pending_

---

### KT-7: ConfigMap is mounted at /etc/ax/ax.yaml in all pods

**Criterion:** "Every pod mounts ax.yaml ConfigMap at /etc/ax/ax.yaml"
**Plan reference:** Section 13, Key Design Decision

**Verification steps:**
```bash
for COMPONENT in host agent-runtime pool-controller; do
  POD=$(kubectl -n ax-test get pod -l app.kubernetes.io/component=$COMPONENT -o jsonpath='{.items[0].metadata.name}')
  echo "=== $COMPONENT ==="
  kubectl -n ax-test exec $POD -- cat /etc/ax/ax.yaml
  kubectl -n ax-test exec $POD -- sh -c 'echo AX_CONFIG_PATH=$AX_CONFIG_PATH'
done
```

**Expected outcome:**
- [ ] All three component types have `/etc/ax/ax.yaml` mounted
- [ ] File content matches rendered ConfigMap (valid ax.yaml with k8s providers)
- [ ] `AX_CONFIG_PATH=/etc/ax/ax.yaml` set in all pods
- [ ] Config shows `providers.storage: postgresql`, `providers.eventbus: nats`, `providers.sandbox: k8s-pod`

**Pass/Fail:** _pending_

---

### KT-8: Warm sandbox pod connects to NATS and subscribes to task queue

**Criterion:** "Warm pod subscribes to tasks.sandbox.light via NATS queue group"
**Plan reference:** Section 4, Pi-Session Tool Pods — Lifecycle step 2

**Verification steps:**
```bash
# Check warm pod logs for NATS subscription
WARM_POD=$(kubectl -n ax-test get pod -l ax.io/tier=light,ax.io/status=warm -o jsonpath='{.items[0].metadata.name}')
kubectl -n ax-test logs $WARM_POD --tail=50

# Check NATS consumer exists for sandbox workers
kubectl -n ax-test run nats-check --rm -i --restart=Never \
  --image=natsio/nats-box:latest -- \
  nats --server=nats://ax-nats:4222 consumer ls TASKS
```

**Expected outcome:**
- [ ] Warm pod logs show successful NATS connection
- [ ] Warm pod logs show subscription to `tasks.sandbox.light`
- [ ] NATS consumer exists for sandbox worker queue group
- [ ] Pod is in warm/ready state (waiting for task claims)

**Pass/Fail:** _pending_

---

## Integration Tests

These tests exercise end-to-end flows through the deployed cluster. They require all components running and connected.

### IT-1: Pi-session chat flow — host → NATS → agent-runtime → response

**Criterion:** "Client → POST /v1/chat/completions → Host Pod → NATS → Agent Runtime → LLM → NATS events → Host → SSE response"
**Plan reference:** Section 7, Flow 1 — Pi-Session Chat (No Code Execution)

**Setup:**
- All pods Running
- ANTHROPIC_API_KEY valid (real LLM call required)
- Port-forward to host service

**Verification steps:**
```bash
kubectl -n ax-test port-forward svc/ax-host 8080:8080 &
PF_PID=$!
sleep 2

# Send chat completion request
curl -sf http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "agent:main",
    "messages": [{"role": "user", "content": "Say hello in exactly 3 words."}],
    "stream": false
  }'

RESPONSE_CODE=$?
kill $PF_PID 2>/dev/null
```

**Expected outcome:**
- [ ] HTTP 200 response with JSON body
- [ ] Response contains `choices[0].message.content` with agent reply
- [ ] Response `model` field identifies the agent
- [ ] No errors in host pod logs
- [ ] No errors in agent-runtime pod logs
- [ ] Request flowed: host → NATS session dispatch → agent-runtime → LLM → NATS result → host → response

**Pass/Fail:** _pending_

---

### IT-2: SSE streaming — events flow from agent-runtime through NATS to host

**Criterion:** "Host subscribes to events.{requestId} → forwards as SSE chunks to client"
**Plan reference:** Section 7, Flow 1 — step 5a

**Setup:**
- Same as IT-1

**Verification steps:**
```bash
kubectl -n ax-test port-forward svc/ax-host 8080:8080 &
PF_PID=$!
sleep 2

# Send streaming request, capture SSE events
curl -sf http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "agent:main",
    "messages": [{"role": "user", "content": "Count from 1 to 5."}],
    "stream": true
  }' --no-buffer 2>/dev/null | head -50

kill $PF_PID 2>/dev/null
```

**Expected outcome:**
- [ ] Response is `text/event-stream` content type
- [ ] Multiple `data:` lines received (SSE chunks)
- [ ] Final chunk is `data: [DONE]`
- [ ] Each data chunk contains a partial response (delta content)
- [ ] Events originated from agent-runtime via NATS EventBus, forwarded by host

**Pass/Fail:** _pending_

---

### IT-3: Tool execution flow — bash tool dispatched to sandbox pod via NATS

**Criterion:** "Agent LLM decides to use bash tool → IPC → parent dispatches to sandbox pod via NATS → pod executes → result returned"
**Plan reference:** Section 7, Flow 2 — Pi-Session With Bash/File Tools

**Setup:**
- All pods Running, warm sandbox pods available
- Agent configured to allow bash tool use

**Verification steps:**
```bash
kubectl -n ax-test port-forward svc/ax-host 8080:8080 &
PF_PID=$!
sleep 2

# Request that triggers bash tool use
curl -sf http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "agent:main",
    "messages": [{"role": "user", "content": "Run the command echo hello-from-sandbox and tell me the output."}],
    "stream": false
  }'

kill $PF_PID 2>/dev/null

# Check sandbox pod was claimed (look for non-warm status)
kubectl -n ax-test get pods -l ax.io/tier=light --show-labels
```

**Expected outcome:**
- [ ] Agent response includes "hello-from-sandbox" (bash output)
- [ ] Sandbox pod was claimed during request (status changed from warm)
- [ ] After request completes, sandbox pod returned to warm pool (or new warm pod created)
- [ ] Agent-runtime logs show NATS sandbox dispatch
- [ ] Sandbox pod logs show tool execution

**Deviation notes:**
- This test makes a real LLM call. The LLM may not always use the bash tool. If it responds without using bash, re-prompt with: "Use your bash tool to run: echo hello-from-sandbox"

**Pass/Fail:** _pending_

---

### IT-4: Per-turn pod affinity — multiple tool calls hit same sandbox pod

**Criterion:** "Subsequent tool calls with the same requestId are routed to the same pod"
**Plan reference:** Section 4, Per-turn affinity; Section 7, Flow 2 steps 4e-4j

**Setup:**
- All pods Running, at least 2 warm sandbox pods (adjust minReady to 2)

**Verification steps:**
```bash
kubectl -n ax-test port-forward svc/ax-host 8080:8080 &
PF_PID=$!
sleep 2

# Request that triggers multiple tool calls
curl -sf http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "agent:main",
    "messages": [{"role": "user", "content": "Create a file called /workspace/test.txt with content \"hello\" using write_file, then use bash to run cat /workspace/test.txt and tell me the output."}],
    "stream": false
  }'

kill $PF_PID 2>/dev/null

# Check agent-runtime logs for pod affinity tracking
RUNTIME_POD=$(kubectl -n ax-test get pod -l app.kubernetes.io/component=agent-runtime -o jsonpath='{.items[0].metadata.name}')
kubectl -n ax-test logs $RUNTIME_POD --tail=100 | grep -i "sandbox\|affinity\|claim"
```

**Expected outcome:**
- [ ] Agent uses both write_file and bash tools (at least 2 tool calls)
- [ ] Both tool calls routed to the SAME sandbox pod (same podId in logs)
- [ ] File written by write_file is visible to subsequent bash call (shared workspace)
- [ ] Agent response contains "hello" (cat output)
- [ ] Only ONE claim request to queue group (first call), subsequent calls to direct subject

**Pass/Fail:** _pending_

---

### IT-5: Pool controller recovers warm pool after pod deletion

**Criterion:** "Reconciliation loop: if ready < minReady, create (minReady - ready) new pods"
**Plan reference:** Section 4, Pool Controller — Reconciliation loop

**Setup:**
- Pool controller running with minReady=1 for light tier
- At least 1 warm sandbox pod exists

**Verification steps:**
```bash
# Record current warm pods
WARM_BEFORE=$(kubectl -n ax-test get pods -l ax.io/tier=light,ax.io/status=warm -o name)
echo "Before: $WARM_BEFORE"

# Delete a warm pod
WARM_POD=$(kubectl -n ax-test get pod -l ax.io/tier=light,ax.io/status=warm -o jsonpath='{.items[0].metadata.name}')
kubectl -n ax-test delete pod $WARM_POD

# Wait for reconciliation (3s interval + pod startup)
sleep 30

# Check new warm pod was created
WARM_AFTER=$(kubectl -n ax-test get pods -l ax.io/tier=light,ax.io/status=warm --no-headers | wc -l)
echo "After: $WARM_AFTER warm pods"
```

**Expected outcome:**
- [ ] Deleting warm pod reduces count below minReady
- [ ] Pool controller detects deficit within reconcile interval (3s)
- [ ] New warm pod created to restore minReady count
- [ ] New pod reaches Running state within 30s
- [ ] Pool controller metrics show podsCreated incremented

**Pass/Fail:** _pending_

---

### IT-6: Conversation history persists in PostgreSQL across pod restarts

**Criterion:** "All state is in PostgreSQL, not in-memory"
**Plan reference:** Section 4, Host Pods — "Hold no session state in memory"

**Setup:**
- All pods Running
- Unique session ID for this test

**Verification steps:**
```bash
kubectl -n ax-test port-forward svc/ax-host 8080:8080 &
PF_PID=$!
sleep 2

SESSION_ID="acceptance:k8s:it6:$(date +%s)"

# Turn 1: send a message with a memorable fact
curl -sf http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d "{
    \"model\": \"agent:main\",
    \"messages\": [{\"role\": \"user\", \"content\": \"My favorite number is 42. Remember this.\"}],
    \"stream\": false,
    \"session_id\": \"$SESSION_ID\"
  }"

# Restart agent-runtime pod (simulates pod rescheduling)
RUNTIME_POD=$(kubectl -n ax-test get pod -l app.kubernetes.io/component=agent-runtime -o jsonpath='{.items[0].metadata.name}')
kubectl -n ax-test delete pod $RUNTIME_POD
kubectl -n ax-test rollout status deployment/ax-agent-runtime --timeout=120s

# Turn 2: ask about the fact (different agent-runtime pod instance)
curl -sf http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d "{
    \"model\": \"agent:main\",
    \"messages\": [{\"role\": \"user\", \"content\": \"What is my favorite number?\"}],
    \"stream\": false,
    \"session_id\": \"$SESSION_ID\"
  }"

kill $PF_PID 2>/dev/null
```

**Expected outcome:**
- [ ] Turn 1 succeeds, agent acknowledges the fact
- [ ] Agent-runtime pod is replaced (new pod name after restart)
- [ ] Turn 2 succeeds, agent recalls "42" from conversation history
- [ ] History was loaded from PostgreSQL (not in-memory on the old pod)
- [ ] Session continuity across pod restarts confirmed

**Pass/Fail:** _pending_

---

## Security Tests

### SEC-1: Sandbox pods have no API credentials in environment

**Criterion:** "No credentials in sandbox — cannot call LLM or DB directly"
**Plan reference:** Section 8, Security Model — "No credentials in sandbox"

**Verification steps:**
```bash
# Wait for a warm sandbox pod
WARM_POD=$(kubectl -n ax-test get pod -l ax.io/tier=light,ax.io/status=warm -o jsonpath='{.items[0].metadata.name}')

# Check environment for credential leaks
kubectl -n ax-test exec $WARM_POD -- env | grep -iE "api_key|secret|password|database_url|credential" || echo "NO_CREDENTIALS_FOUND"

# Check pod spec directly
kubectl -n ax-test get pod $WARM_POD -o json | jq '.spec.containers[0].env[] | select(.name | test("API_KEY|SECRET|PASSWORD|DATABASE"; "i"))' || echo "NO_CREDENTIAL_ENVS"
```

**Expected outcome:**
- [ ] No `ANTHROPIC_API_KEY` in sandbox pod env
- [ ] No `DATABASE_URL` in sandbox pod env
- [ ] No other credential-like env vars
- [ ] Only `NATS_URL`, `SESSION_ID`, `REQUEST_ID`, `WORKSPACE_ROOT` type vars present

**Pass/Fail:** _pending_

---

### SEC-2: Sandbox pod cannot reach external network (NetworkPolicy)

**Criterion:** "Network restricted to NATS only (k8s NetworkPolicy)"
**Plan reference:** Section 8, Security Model — NetworkPolicy

**Setup:**
- Calico CNI installed (for NetworkPolicy enforcement)
- NetworkPolicies applied (`networkPolicies.enabled: true`)

**Verification steps:**
```bash
WARM_POD=$(kubectl -n ax-test get pod -l ax.io/tier=light,ax.io/status=warm -o jsonpath='{.items[0].metadata.name}')

# Attempt to reach external internet (should be blocked by NetworkPolicy)
kubectl -n ax-test exec $WARM_POD -- \
  sh -c 'timeout 5 wget -q -O- http://httpbin.org/ip 2>&1 || echo "BLOCKED"'

# Attempt to reach PostgreSQL (should be blocked)
kubectl -n ax-test exec $WARM_POD -- \
  sh -c 'timeout 5 nc -z ax-postgresql 5432 2>&1 || echo "BLOCKED"'

# Attempt to reach NATS (should succeed)
kubectl -n ax-test exec $WARM_POD -- \
  sh -c 'timeout 5 nc -z ax-nats 4222 2>&1 && echo "NATS_REACHABLE" || echo "NATS_BLOCKED"'

# Attempt to reach Anthropic API directly (should be blocked)
kubectl -n ax-test exec $WARM_POD -- \
  sh -c 'timeout 5 wget -q -O- https://api.anthropic.com/ 2>&1 || echo "BLOCKED"'
```

**Expected outcome:**
- [ ] External internet: BLOCKED (httpbin.org unreachable)
- [ ] PostgreSQL: BLOCKED (sandbox can't query DB directly)
- [ ] NATS: REACHABLE (only allowed egress)
- [ ] Anthropic API: BLOCKED (no direct LLM calls from sandbox)
- [ ] DNS: works (for resolving `ax-nats` service name)

**Pass/Fail:** _pending_

---

### SEC-3: Sandbox pod security context is hardened

**Criterion:** "gVisor, readOnlyRootFilesystem, runAsNonRoot, drop ALL capabilities"
**Plan reference:** Section 8, Security Model — Pod isolation

**Verification steps:**
```bash
WARM_POD=$(kubectl -n ax-test get pod -l ax.io/tier=light,ax.io/status=warm -o jsonpath='{.items[0].metadata.name}')

# Check security context from pod spec
kubectl -n ax-test get pod $WARM_POD -o json | jq '{
  runAsNonRoot: .spec.containers[0].securityContext.runAsNonRoot,
  runAsUser: .spec.containers[0].securityContext.runAsUser,
  readOnlyRootFilesystem: .spec.containers[0].securityContext.readOnlyRootFilesystem,
  capabilities: .spec.containers[0].securityContext.capabilities,
  runtimeClassName: .spec.runtimeClassName
}'

# Verify running as non-root inside the container
kubectl -n ax-test exec $WARM_POD -- id
kubectl -n ax-test exec $WARM_POD -- whoami
```

**Expected outcome:**
- [ ] `runAsNonRoot: true`
- [ ] `runAsUser: 1000` (non-root)
- [ ] `readOnlyRootFilesystem: true`
- [ ] `capabilities.drop: ["ALL"]`
- [ ] `runtimeClassName: gvisor` (set in spec, but may not be enforced on kind — that's OK)
- [ ] `id` command shows uid=1000
- [ ] Container cannot write to root filesystem (only writable tmpfs/emptyDir volumes)

**Deviation note (kind):** gVisor runtime is NOT available in kind. The `runtimeClassName` field will be set in the pod spec but kind will ignore it and use the default runtime. This is expected. Full gVisor testing requires GKE Autopilot.

**Pass/Fail:** _pending_

---

### SEC-4: Sandbox pod has no inbound network access (ingress blocked)

**Criterion:** "ingress: [] — No inbound connections to sandbox pods"
**Plan reference:** Section 8, NetworkPolicy — ingress: []

**Verification steps:**
```bash
WARM_POD=$(kubectl -n ax-test get pod -l ax.io/tier=light,ax.io/status=warm -o jsonpath='{.items[0].metadata.name}')
WARM_IP=$(kubectl -n ax-test get pod $WARM_POD -o jsonpath='{.status.podIP}')

# From host pod, try to connect to sandbox pod on any port
HOST_POD=$(kubectl -n ax-test get pod -l app.kubernetes.io/component=host -o jsonpath='{.items[0].metadata.name}')
kubectl -n ax-test exec $HOST_POD -- \
  sh -c "timeout 5 nc -z $WARM_IP 8080 2>&1 || echo 'INGRESS_BLOCKED'"

# From agent-runtime pod, try the same
RUNTIME_POD=$(kubectl -n ax-test get pod -l app.kubernetes.io/component=agent-runtime -o jsonpath='{.items[0].metadata.name}')
kubectl -n ax-test exec $RUNTIME_POD -- \
  sh -c "timeout 5 nc -z $WARM_IP 8080 2>&1 || echo 'INGRESS_BLOCKED'"
```

**Expected outcome:**
- [ ] Host pod cannot connect to sandbox pod: INGRESS_BLOCKED
- [ ] Agent-runtime pod cannot connect to sandbox pod: INGRESS_BLOCKED
- [ ] No inbound network access to sandbox pods from any source
- [ ] All sandbox-to-host communication goes through NATS (outbound from sandbox, not inbound)

**Pass/Fail:** _pending_

---

## Plan Deviation Checklist

These are areas where the implementation may deviate from the plan or where kind limitations apply:

### DEV-1: gVisor runtime not available on kind

**Plan says:** "runtimeClassName: gvisor" for all sandbox pods
**Kind reality:** gVisor is not installed. Pods will use default containerd runtime.
**Impact:** Kernel-level isolation NOT tested. Must verify on GKE Autopilot separately.
**Action:** Verify the field is SET in pod specs (ST-4, SEC-3) but don't assert runtime behavior.

### DEV-2: GCS workspace caching not testable on kind

**Plan says:** "Check GCS cache: gs://ax-workspace-cache/{repoHash}/workspace.tar.gz"
**Kind reality:** No GCS. Workspace setup falls back to git clone only.
**Impact:** Workspace restore performance not measured. GCS integration untested.
**Action:** Skip GCS cache tests. Verify git clone workspace path only.

### DEV-3: Autopilot QoS enforcement not testable

**Plan says:** "requests == limits (Guaranteed QoS only)"
**Kind reality:** Kind doesn't enforce Autopilot QoS constraints.
**Impact:** Resource overcommit possible on kind but not on GKE.
**Action:** Verify Helm values set requests==limits (HT-4, HT-5) but don't assert QoS class.

### DEV-4: Heavy tier nodeSelector won't work on kind

**Plan says:** "cloud.google.com/compute-class: Performance" for heavy tier
**Kind reality:** No GKE compute classes.
**Impact:** Heavy pods schedule on any node.
**Action:** Override nodeSelector to `{}` in kind-values.yaml (already done).

### DEV-5: NATS cluster replication

**Plan says:** "replicas: 3" for NATS, "--replicas=3" for streams
**Kind reality:** Single NATS node for simplicity.
**Impact:** No HA/replication testing.
**Action:** Set `cluster.enabled: false, replicas: 1` in kind-values. Stream init may need adjustment to skip replicas flag. Consider a separate HA test with 3-node NATS.

### DEV-6: KEDA/HPA autoscaling

**Plan says:** Phase 4 includes KEDA ScaledObject for NATS queue depth scaling.
**Kind reality:** KEDA not installed.
**Impact:** Autoscaling not tested.
**Action:** Skip. Verify HPA values exist in Helm chart but don't deploy.

---

## Teardown

```bash
# Uninstall chart
helm uninstall ax -n ax-test

# Delete namespace
kubectl delete namespace ax-test

# Delete kind cluster
kind delete cluster --name ax-test
```
