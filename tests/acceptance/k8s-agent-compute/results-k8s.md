# Acceptance Test Results: K8s Agent Compute Architecture

**Date run:** 2026-03-05 22:18
**Server version:** e158750
**LLM provider:** openrouter/anthropic/claude-sonnet-4
**Environment:** K8s/kind (k8s-pod sandbox, nats eventbus, postgresql storage)
**Namespace:** ax-test-k8s-compute-ee0cefac
**Helm release:** ax-ax-test-k8s-compute-ee0cefac

## Summary

| Test | Category | Result | Notes |
|------|----------|--------|-------|
| HT-1 | Helm Template | PASS | Chart renders cleanly, exit 0, all resource types present |
| HT-2 | Helm Template | PASS | ConfigMap renders ax.yaml with correct providers |
| HT-3 | Helm Template | PASS | NATS init job creates 5 streams with correct subjects/retention |
| HT-4 | Helm Template | PASS | Host deployment: AX_CONFIG_PATH, NATS_URL, DATABASE_URL; NO API keys |
| HT-5 | Helm Template | PASS | Agent-runtime: LLM API keys, K8S_NAMESPACE, K8S_POD_IMAGE, terminationGrace=600 |
| HT-6 | Helm Template | PASS | Pool controller: SANDBOX_TEMPLATE_DIR, light.json/heavy.json rendered correctly |
| HT-7 | Helm Template | PASS | RBAC: agent-runtime pod CRUD + pods/log; pool-controller pod CRUD + patch |
| HT-8 | Helm Template | PASS | NetworkPolicy: sandbox pods restricted to NATS (4222) + DNS (53) only |
| KT-1 | Kind Cluster | PASS | All pods Running: host, agent-runtime, pool-controller, nats, postgresql, sandbox |
| KT-2 | Kind Cluster | PASS | All 5 JetStream streams created: SESSIONS, TASKS, RESULTS, EVENTS, IPC |
| KT-3 | Kind Cluster | PASS | PostgreSQL accessible from host and agent-runtime pods |
| KT-4 | Kind Cluster | PASS | Health endpoint returns 200, /v1/models returns model list |
| KT-5 | Kind Cluster | PASS | Pool controller created 1 warm sandbox pod (light tier, minReady=1) |
| KT-6 | Kind Cluster | PASS | NATS reachable from host, agent-runtime, and pool-controller pods |
| KT-7 | Kind Cluster | PASS | ConfigMap mounted at /etc/ax/ax.yaml in all 3 component pods |
| KT-8 | Kind Cluster | PASS | Sandbox pod connected to NATS, subscribed to task queue |
| IT-1 | Integration | PASS | Full chat flow: host -> NATS -> agent-runtime -> LLM -> response |
| IT-2 | Integration | PASS | SSE streaming: multiple data chunks, delta content, [DONE] terminator |
| IT-3 | Integration | PASS | Bash tool dispatched to sandbox pod via NATS, "hello-from-sandbox" returned |
| IT-4 | Integration | PASS | Multiple tool calls routed to same sandbox pod (per-turn affinity) |
| IT-5 | Integration | PASS | Pool controller recreated warm pod within 30s after deletion |
| IT-6 | Integration | PASS | Conversation history persisted in PostgreSQL across pod restarts |
| SEC-1 | Security | PASS | No API keys, DATABASE_URL, or credentials in sandbox pod env |
| SEC-2 | Security | PASS | External internet blocked, PostgreSQL blocked, NATS reachable, DNS works |
| SEC-3 | Security | PASS | runAsNonRoot, uid=1000, readOnlyRootFilesystem, drop ALL capabilities |
| SEC-4 | Security | PASS | Ingress blocked to sandbox pods from both host and agent-runtime |

**Overall: 26/26 passed**

## Detailed Results

### HT-1: Chart renders without errors with kind values

**Result: PASS**

- `helm template` exit code: 0
- `kubectl apply --dry-run=client` validates all resources
- Resource counts: 4 Deployments (host, agent-runtime, pool-controller, nats-box), 5 Services, 3 ConfigMaps, 2 Roles, 2 RoleBindings, 3 ServiceAccounts, 1 Job, 2 StatefulSets, 4 NetworkPolicies

### HT-2: ConfigMap renders full ax.yaml from values

**Result: PASS**

- ConfigMap name: `ax-test-release-config`
- `data["ax.yaml"]` contains valid AX config
- Providers: `storage: database`, `database: postgresql`, `eventbus: nats`, `sandbox: k8s`
- All config fields present (profile, agent, sandbox, scheduler, history, admin, models)

### HT-3: NATS stream init job creates five streams

**Result: PASS**

- Job has `helm.sh/hook: post-install,post-upgrade` annotation
- Creates exactly 5 streams:
  - SESSIONS: subjects `session.request.*`, retention `work`, storage `memory`
  - TASKS: subjects `tasks.sandbox.*`, retention `work`, storage `memory`
  - RESULTS: subjects `results.*`, retention `limits`, max-msgs-per-subject 1
  - EVENTS: subjects `events.>`, retention `limits`, storage `memory`
  - IPC: subjects `ipc.>`, retention `work`, storage `memory`
- Replicas set to 1 (kind values override)
- hook-delete-policy: hook-succeeded,before-hook-creation

### HT-4: Host deployment has AX_CONFIG_PATH, NATS_URL, DATABASE_URL env vars

**Result: PASS**

- `AX_CONFIG_PATH: /etc/ax/ax.yaml`
- `NATS_URL` set via helper template (full FQDN)
- `DATABASE_URL` from secretKeyRef (ax-db-credentials)
- NO `ANTHROPIC_API_KEY` or `OPENROUTER_API_KEY` env vars
- Volume mount: `/etc/ax` from ConfigMap, readOnly: true
- Readiness/liveness probes on /health
- Plane label: `ax.io/plane: ingress`
- Config checksum annotation for rolling restarts
- Command: `["node","dist/host/host-process.js"]`

### HT-5: Agent-runtime deployment has LLM API credentials and K8S_NAMESPACE

**Result: PASS**

- `ANTHROPIC_API_KEY` from secretKeyRef `ax-api-credentials`
- `OPENROUTER_API_KEY` from secretKeyRef `ax-api-credentials`
- `K8S_NAMESPACE` set to chart namespace
- `K8S_POD_IMAGE` set to `ax/agent:test`
- `serviceAccountName: ax-test-release-agent-runtime`
- `terminationGracePeriodSeconds: 600`
- Config checksum annotation
- Plane label: `ax.io/plane: conversation`
- Command: `["node","dist/host/agent-runtime-process.js"]`

### HT-6: Pool controller has SANDBOX_TEMPLATE_DIR and sandbox template ConfigMap

**Result: PASS**

- Deployment mounts two ConfigMaps: ax-config + sandbox-templates
- `SANDBOX_TEMPLATE_DIR=/etc/ax/sandbox-templates`
- `RECONCILE_INTERVAL_MS=3000` (kind override)
- `light.json`: minReady=1, maxReady=3, cpu=500m, memory=512Mi
- `heavy.json`: minReady=0, maxReady=1, cpu=1, memory=2Gi
- Template JSON includes `natsUrl` for pod connectivity
- Checksum annotations on both ConfigMaps
- Note: heavy.json includes GKE `nodeSelector` from chart defaults due to Helm deep merge behavior

### HT-7: RBAC roles grant pod CRUD permissions

**Result: PASS**

- Agent-runtime Role (`sandbox-manager`): pods verbs [get, list, watch, create, delete] + pods/log verbs [get]
- Pool-controller Role (`pool-manager`): pods verbs [get, list, watch, create, delete, patch]
- RoleBindings bind to respective ServiceAccounts
- Roles are namespaced (Role, not ClusterRole)

### HT-8: NetworkPolicy restricts sandbox pods to NATS and DNS only

**Result: PASS**

- Targets pods with `ax.io/plane: execution` label
- Egress allowed to NATS pods on port 4222 (TCP) via podSelector
- Egress allowed to DNS on port 53 (UDP + TCP)
- No other egress allowed
- Ingress: empty array (no inbound connections)
- Conditional on `networkPolicies.enabled`

### KT-1: All pods reach Running state

**Result: PASS**

- `ax-host` deployment: 1/1 Ready
- `ax-agent-runtime` deployment: 1/1 Ready (recovered after PostgreSQL started)
- `ax-pool-controller` deployment: 1/1 Ready
- `ax-nats-0` pod: 2/2 Running
- `ax-postgresql-0` pod: 1/1 Running
- `ax-sandbox-light-*` pod: 1/1 Running
- No pods in CrashLoopBackOff or Error state (at steady state)
- Note: Initial PostgreSQL ImagePullBackOff due to `bitnami/postgresql:17` tag; resolved by loading correct image into kind. Host and agent-runtime CrashLoopBackOff'd until PostgreSQL was available, then recovered.

### KT-2: NATS JetStream streams created by init job

**Result: PASS**

- Init Job completed and was cleaned up (helm hook delete policy)
- All 5 streams verified via `nats stream ls`:
  - SESSIONS: subjects `session.request.*`, retention WorkQueue, storage Memory
  - TASKS: subjects `tasks.sandbox.*`, retention WorkQueue, storage Memory
  - RESULTS: subjects `results.*`, retention Limits, storage Memory
  - EVENTS: subjects `events.>`, retention Limits, storage Memory
  - IPC: subjects `ipc.>`, retention WorkQueue, storage Memory

### KT-3: PostgreSQL accepts connections from host and agent-runtime pods

**Result: PASS**

- Host pod: `{"ok":1}` -- PostgreSQL connection works via `pg` Pool
- Agent-runtime pod: `{"ok":1}` -- PostgreSQL connection works
- Both use DATABASE_URL from k8s secret

### KT-4: Host pod health endpoint returns 200

**Result: PASS**

- `/health` returns HTTP 200 with `{"status":"ok"}`
- `/v1/models` returns HTTP 200 with `{"object":"list","data":[{"id":"router(openrouter/anthropic/claude-sonnet-4)","object":"model"}]}`
- Readiness probe passes (pod stays Ready)

### KT-5: Pool controller creates warm sandbox pods

**Result: PASS**

- 1 warm pod with labels `ax.io/tier=light`, `ax.io/status=warm`, `ax.io/plane=execution`
- Warm pod is Running (1/1 Ready)
- Pod uses sandbox image `ax/agent:test`
- No heavy-tier warm pods (minReady=0 in kind-values)
- Pool controller logs show: `scaling_up` tier=light, toCreate=1, pod_created

### KT-6: NATS connectivity from all component pods

**Result: PASS**

- Host pod: CONNECTED
- Agent-runtime pod: CONNECTED
- Pool controller pod: CONNECTED
- All pods use the same NATS_URL from Helm template

### KT-7: ConfigMap is mounted at /etc/ax/ax.yaml in all pods

**Result: PASS**

- All three component types have `/etc/ax/ax.yaml` mounted
- `AX_CONFIG_PATH=/etc/ax/ax.yaml` set in all pods
- Config content identical across all pods, showing correct providers

### KT-8: Warm sandbox pod connects to NATS and subscribes to task queue

**Result: PASS**

- Sandbox pod logs: `connected to NATS at nats://..., podId=ax-sandbox-light-8mvp7sha, tier=light`
- Sandbox worker subscribed to task queue (confirmed by successful tool dispatch in IT-3)
- Note: No JetStream consumer shown via `nats consumer ls TASKS` -- sandbox worker uses core NATS subscription pattern

### IT-1: Pi-session chat flow -- host -> NATS -> agent-runtime -> response

**Result: PASS**

- HTTP 200 response with JSON body
- Response: `"Hello there, friend!"` (agent replied with 3 words as requested)
- Agent-runtime logs confirm full flow:
  - `session_claimed`: requestId=chatcmpl-b5b85986, sessionId=acceptance:k8s-compute:k8s:it1
  - `session_completed`: responseLength=20, finishReason=stop
- Host pod logs show NATS connection and request routing

### IT-2: SSE streaming -- events flow from agent-runtime through NATS to host

**Result: PASS**

- Response is SSE format with multiple `data:` lines
- Delta content chunks: `"1, 2, 3,"` and `" 4, 5"`
- Final chunk: `{"finish_reason":"stop"}`
- Stream terminator: `data: [DONE]`
- Events originated from agent-runtime via NATS EventBus, forwarded by host

### IT-3: Tool execution flow -- bash tool dispatched to sandbox pod via NATS

**Result: PASS**

- Agent response: `"The command executed successfully and output \"hello-from-sandbox\"."`
- Agent-runtime logs show complete NATS dispatch flow:
  - `nats_dispatch_start`: toolType=bash, action=sandbox_bash
  - `claim_request_sent`: tier=light
  - `pod_claimed`: podId=ax-sandbox-light-8mvp7sha, podSubject=sandbox.ax-sandbox-light-8mvp7sha
  - `nats_dispatch_success`
- Sandbox pod logs confirm:
  - `claimed task`: requestId=chatcmpl-4f5788d4
  - `workspace ready`: source=empty
  - `released, returning to warm pool`

### IT-4: Per-turn pod affinity -- multiple tool calls hit same sandbox pod

**Result: PASS**

- Agent used bash tool twice (echo + cat)
- First call: `claim_request_sent` -> `pod_claimed` (podId=ax-sandbox-light-8mvp7sha)
- Second call: `nats_dispatch_start` -> `nats_dispatch_success` (NO new claim -- reused affinity)
- File written by first call visible to second call (shared workspace)
- Response: `"cat /workspace/test.txt outputs: test123"` -- confirms workspace persistence
- Only ONE claim request to queue group; subsequent calls go directly to claimed pod

### IT-5: Pool controller recovers warm pool after pod deletion

**Result: PASS**

- Before: 1 warm pod (ax-sandbox-light-8mvp7sha)
- Deleted warm pod
- After 30s: new warm pod created (ax-sandbox-light-ifg4zfx6), 1/1 Running
- Pool controller detected deficit within reconcile interval (3s) and created replacement

### IT-6: Conversation history persists in PostgreSQL across pod restarts

**Result: PASS**

- Turn 1: Agent acknowledged "42" on pod `xd886`
- Agent-runtime pod deleted and replaced by pod `h65k2`
- Turn 2: New pod correctly recalled "Your favorite number is 42."
- History loaded from PostgreSQL, not in-memory on old pod
- Session continuity across pod restarts confirmed

### SEC-1: Sandbox pods have no API credentials in environment

**Result: PASS**

- No `ANTHROPIC_API_KEY` in sandbox pod env
- No `DATABASE_URL` in sandbox pod env
- No credential-like env vars
- Only explicitly set: `NATS_URL`, `SANDBOX_TIER`, `SANDBOX_WORKSPACE_ROOT`, `POD_NAME`

### SEC-2: Sandbox pod cannot reach external network (NetworkPolicy)

**Result: PASS**

- External internet: BLOCKED (HTTP to httpbin.org timed out with ECONNRESET)
- PostgreSQL: BLOCKED (TCP connection to port 5432 refused/timed out)
- NATS: REACHABLE (TCP connection to port 4222 succeeded)
- Anthropic API: BLOCKED
- DNS: works (resolved httpbin.org to IP, but egress blocked for TCP)

### SEC-3: Sandbox pod security context is hardened

**Result: PASS**

- `runAsNonRoot: true`
- `runAsUser: 1000`
- `readOnlyRootFilesystem: true`
- `capabilities: { drop: ["ALL"] }`
- `runtimeClassName: null` (gVisor not available on kind -- expected deviation DEV-1)
- `id` command shows uid=1000(node)
- Root filesystem read-only; only /tmp (emptyDir) and /workspace are writable

### SEC-4: Sandbox pod has no inbound network access (ingress blocked)

**Result: PASS**

- Host pod cannot connect to sandbox pod: TIMEOUT_INGRESS_BLOCKED
- Agent-runtime pod cannot connect to sandbox pod: TIMEOUT_INGRESS_BLOCKED
- All sandbox-to-host communication goes through NATS (outbound from sandbox, not inbound)

## Findings and Notes

### Infrastructure Issues Encountered

1. **PostgreSQL image tag**: The kind-values.yaml set `postgresql.image.tag: "17"` which doesn't exist as a Bitnami image tag. The correct tag from the subchart default is `17.6.0-debian-12-r4`. Resolved by pulling `bitnami/postgresql:latest` and tagging as `:17` for kind. This should be fixed in kind-values.yaml.

2. **Sandbox image loading**: The `ax/agent:test` image needed to be loaded into kind with the correct Docker tag format (`docker.io/ax/agent:test`).

3. **Host/Agent-runtime crash recovery**: Both pods entered CrashLoopBackOff when PostgreSQL was unavailable, then self-recovered once PostgreSQL started. This is expected behavior -- no retry/backoff logic needed since K8s restarts handle it.

### Architecture Validation

The three-layer architecture (host/agent-runtime/pool-controller) is fully functional:

1. **Stateless host**: Host pods handle HTTP only, dispatch via NATS, no LLM calls
2. **Agent-runtime**: Claims sessions from NATS queue group, processes via LLM, dispatches tools to sandbox
3. **Pool controller**: Maintains warm pool, reconciliation loop works, creates/recovers sandbox pods
4. **Sandbox isolation**: No credentials, network restricted to NATS, hardened security context, read-only root FS
5. **NATS as communication layer**: All 5 JetStream streams operational, per-turn pod affinity works
6. **PostgreSQL persistence**: Conversation history survives pod restarts
7. **ConfigMap-mounted config**: Reuses existing loadConfig() via AX_CONFIG_PATH

### Known Deviations from Plan

- **DEV-1**: gVisor runtime not available on kind (field set to null in pod spec)
- **DEV-5**: Single NATS node (no cluster replication testing)
- **DEV-6**: No KEDA/HPA autoscaling testing
- **Heavy tier nodeSelector**: Helm deep merge causes GKE-specific `cloud.google.com/compute-class: Performance` to appear in heavy.json even when kind-values overrides to `{}`

## Teardown

- Helm release uninstalled
- Namespace deleted
- All resources cleaned up
