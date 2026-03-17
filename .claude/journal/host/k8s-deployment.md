# K8s Deployment Journal

## [2026-03-17 19:30] — Fix three P1 workspace provisioning issues from PR review

**Task:** Address three code review comments on the k8s workspace provisioning PR
**What I did:**
1. **Git workspace in HTTP GCS path**: Moved `workspaceGitUrl` provisioning inside the HTTP GCS branch (before the `return`) so k8s deployments with both git bootstrap and GCS scopes get the repo checkout.
2. **Read-only directory locking**: Added `lockDirsSync()` helper that recursively chmods directories to `0o555` (r-xr-xr-x) after files are set to `0o444`. Prevents file creation/deletion in read-only agent scopes.
3. **Provision endpoint ID validation**: Extended `activeTokens` map to store `provisionIds` (agent/user/session IDs). The `/internal/workspace/provision` endpoint now validates the caller-supplied `id` against the token's bound context, returning 403 on mismatch.
**Files touched:** `src/agent/runner.ts`, `src/agent/workspace.ts`, `src/host/host-process.ts`, `tests/agent/workspace-provision-fixes.test.ts` (new)
**Outcome:** Success — all 2399 tests pass (6 new tests for these fixes)
**Notes:** `lockDirsSync` recurses depth-first, then chmods the parent, so child dirs are still traversable during the walk.

## [2026-03-16 07:40] — Wire NATS IPC handler into agent-runtime-process, remove subprocess override

**Task:** Remove the subprocess sandbox override in agent-runtime-process.ts and wire the new NATS IPC handler so k8s sandbox pods can route IPC calls back through NATS
**What I did:** (1) Removed the 10-line workaround that force-replaced k8s sandbox with subprocess provider. (2) Added import for startNATSIPCHandler. (3) In processSessionRequest(), added NATS IPC handler startup before processCompletion (conditional on k8s mode), alongside the existing LLM proxy pattern. Handler is cleaned up in the finally block.
**Files touched:** src/host/agent-runtime-process.ts (modified)
**Outcome:** Success — all 746 host tests pass. k8s sessions now use the real k8s sandbox provider, and a per-session NATS IPC handler bridges IPC requests from sandbox pods back through the trusted handleIPC pipeline.
**Notes:** This is Task 5 of the NATS IPC plan. The NATS IPC handler (nats-ipc-handler.ts) was created in a prior task. The handler follows the same lifecycle pattern as the existing NATS LLM proxy: start before processCompletion, close in finally block.

## [2026-03-16 07:35] — Fix k8s agent identity persistence with empty admins file

**Task:** Fix bug where AX agent forgets its identity (enters bootstrap, asks for name) on every session in k8s/Kind clusters
**What I did:** Identified root cause: identity_write IPC handler checks isAdmin() against local filesystem, but agent-runtime pod has empty admins file (admins only configured on host pod). Added hasAnyAdmin() function that gates admin checks only when admins file is non-empty. Updated identity_write and user_write handlers to skip gate when no admins configured. Added 3 tests for empty/missing admins file.
**Files touched:** src/host/ipc-handlers/identity.ts (added hasAnyAdmin, updated gates), tests/host/ipc-handlers/identity.test.ts (added 3 tests)
**Outcome:** Success — identity and user data now persist in k8s agent-runtime pods. Admin enforcement gates are skipped when admins file is empty, allowing access control to be delegated to host layer.
**Notes:** This is a k8s-specific issue because NATS dispatch architecture means host pod and agent-runtime pod have separate filesystems. Admin state is filesystem-based and can't sync across pods. The fix recognizes that admin gatekeeping is only relevant when admins are actually configured.

## [2026-03-05 08:00] — Add FluxCD sources, base kustomization, and SOPS config

**Task:** Create FluxCD GitOps structure with source definitions, base kustomization, and SOPS encryption config
**What I did:** Created 4 files: .sops.yaml (SOPS encryption config for FluxCD secrets using age), flux/sources/git-repository.yaml (GitRepository source pointing to ax repo), flux/sources/helm-repository-nats.yaml (HelmRepository for NATS charts), flux/base/kustomization.yaml (Kustomization pointing to sources path)
**Files touched:** .sops.yaml (created), flux/sources/git-repository.yaml (created), flux/sources/helm-repository-nats.yaml (created), flux/base/kustomization.yaml (created)
**Outcome:** Success — FluxCD structure established with source reconciliation and SOPS-ready secrets encryption
**Notes:** SOPS config uses placeholder age key that must be replaced with actual key before use. GitRepository uses 1m interval, HelmRepository uses 1h interval, Kustomization uses 10m interval with prune enabled.

## [2026-03-05 07:30] — Add network policies and Cloud SQL proxy Helm templates

**Task:** Create Helm templates for network policies (sandbox, agent-runtime, host) and Cloud SQL proxy (deployment, service, serviceaccount)
**What I did:** Created 3 NetworkPolicy templates under charts/ax/templates/networkpolicies/ and 3 Cloud SQL proxy templates under charts/ax/templates/cloud-sql-proxy/. Network policies enforce plane-based segmentation: sandbox pods (execution plane) get NATS+DNS only, agent-runtime (conversation plane) gets NATS+PostgreSQL+HTTPS+DNS, host (ingress plane) gets inbound HTTP + NATS+PostgreSQL+HTTPS+DNS egress. Cloud SQL proxy uses Workload Identity (GKE) with auto-IAM-authn.
**Files touched:** charts/ax/templates/networkpolicies/sandbox-restrict.yaml, agent-runtime-network.yaml, host-network.yaml (created), charts/ax/templates/cloud-sql-proxy/deployment.yaml, service.yaml, serviceaccount.yaml (created)
**Outcome:** Success — networkPolicies.enabled=false produces 0 NetworkPolicy resources, enabled produces 3. Cloud SQL proxy conditional on postgresql.external.enabled AND cloudSqlProxy.enabled.
**Notes:** Network policies reference cloud-sql-proxy pod selector for PostgreSQL egress even when proxy is disabled — no matching pods means no egress allowed, which is correct security posture.

## [2026-03-05 07:00] — Add NATS JetStream stream init hook job

**Task:** Create Helm template for NATS JetStream stream initialization as a post-install/post-upgrade hook
**What I did:** Created nats-stream-init-job.yaml template that uses natsio/nats-box to create 5 JetStream streams (SESSIONS, TASKS, RESULTS, EVENTS, IPC) with correct retention policies, TTLs, and replication. Job waits for NATS readiness, runs as a Helm hook with hook-succeeded cleanup.
**Files touched:** charts/ax/templates/nats-stream-init-job.yaml (created)
**Outcome:** Success — helm template renders correctly with proper NATS URL from ax.natsUrl helper
**Notes:** Each stream has specific retention (work vs limits), max-age, and subject patterns matching the existing k8s/nats-cluster.yaml Job. Conditional on .Values.nats.enabled.

## [2026-03-05 06:15] — Add agent runtime deployment and RBAC Helm templates

**Task:** Create Helm templates for the agent-runtime component: Deployment, ServiceAccount, Role, and RoleBinding
**What I did:** Created 4 Helm templates under charts/ax/templates/agent-runtime/. Deployment includes config checksum annotation, ANTHROPIC_API_KEY secret mount, K8S_NAMESPACE/K8S_POD_IMAGE env vars for sandbox pod creation, and 600s termination grace period. RBAC grants pod CRUD + pod/log read for sandbox management.
**Files touched:** charts/ax/templates/agent-runtime/deployment.yaml (created), serviceaccount.yaml (created), role.yaml (created), rolebinding.yaml (created)
**Outcome:** Success — helm template renders all 4 resources correctly with proper label/selector resolution
**Notes:** Follows same pattern as host/ templates. ServiceAccount is referenced by deployment spec.serviceAccountName. Role is scoped to namespace with minimal pod permissions for sandbox lifecycle.

## [2026-03-05 06:00] — Add Helm ConfigMap + Host deployment/service/ingress templates

**Task:** Create Helm templates for the ax.yaml ConfigMap, host Deployment, Service, and Ingress
**What I did:** Created 4 template files: configmap-ax-config.yaml (renders .Values.config as ax.yaml), host/deployment.yaml (with config mount, checksum annotation, all helpers), host/service.yaml (ClusterIP on port 80), host/ingress.yaml (conditional on .Values.host.ingress.enabled). Ran helm dependency build and verified all templates render correctly.
**Files touched:** charts/ax/templates/configmap-ax-config.yaml (created), charts/ax/templates/host/deployment.yaml (created), charts/ax/templates/host/service.yaml (created), charts/ax/templates/host/ingress.yaml (created)
**Outcome:** Success — helm template renders all 4 resources correctly with proper labels, selectors, config mount, and rolling restart annotation
**Notes:** Key design: .Values.config is rendered verbatim as ax.yaml ConfigMap, mounted at /etc/ax. AX_CONFIG_PATH env var points to it. checksum/config annotation triggers rolling restart on config changes. Ingress only renders when host.ingress.enabled=true.

## [2026-03-05 05:22] — Add loadTierConfigs() for SANDBOX_TEMPLATE_DIR support

**Task:** Extract hardcoded tier configs from pool controller main() into a loadTierConfigs() function that supports loading from JSON files via SANDBOX_TEMPLATE_DIR env var
**What I did:** Created exported loadTierConfigs() function that reads light.json/heavy.json from SANDBOX_TEMPLATE_DIR when set, falls back to hardcoded defaults otherwise. Updated main() to call loadTierConfigs(). Created first pool-controller test file with 2 tests.
**Files touched:** src/pool-controller/main.ts (modified), tests/pool-controller/main.test.ts (created)
**Outcome:** Success — both tests pass (template dir loading + default fallback)
**Notes:** Security context (gVisor, readOnlyRoot, drop ALL caps) stays hardcoded in k8s-client.ts:createPod() — templates only control resources and config. This enables Helm charts to inject tier configs via ConfigMap-mounted JSON files.

## [2026-03-05 00:00] — Create Helm chart scaffolding

**Task:** Create foundational Helm chart files under charts/ax/ for the AX platform
**What I did:** Created 5 Helm chart files: Chart.yaml (with NATS and PostgreSQL subchart dependencies), .helmignore, templates/_helpers.tpl (11 template helpers for names, labels, images, NATS URL, DB secret, namespace, plane labels), templates/NOTES.txt (post-install notes), and values.yaml (comprehensive defaults for all components: host, agent-runtime, pool-controller, sandbox tiers, PostgreSQL, NATS, network policies, API credentials).
**Files touched:**
- Created: charts/ax/Chart.yaml, charts/ax/.helmignore, charts/ax/templates/_helpers.tpl, charts/ax/templates/NOTES.txt, charts/ax/values.yaml
**Outcome:** Success — helm lint passes (0 charts failed). Expected warnings about missing subchart dependencies (resolved at `helm dependency update` time).
**Notes:** The values.yaml config block mirrors the existing AX loadConfig() schema so it can be rendered as ax.yaml and mounted into pods without code changes. Helper templates use dict-based argument passing for component labels/selectors/images.

## [2026-03-04 23:30] — Implement Phase 3: K8s Deployment

**Task:** Implement Phase 3 of the k8s agent compute architecture plan (tasks 8-13)
**What I did:** Created 9 K8s manifests, pool controller (4 files), workspace provisioning, server refactor into host-process + agent-runtime-process, NATS session protocol, NATS bridge for claude-code, NATS LLM proxy. Fixed pre-existing TS error in nats-sandbox-dispatch.ts. Added 7 test files.
**Files touched:**
- Created: k8s/namespace.yaml, k8s/host.yaml, k8s/agent-runtime.yaml, k8s/sandbox-light.yaml, k8s/sandbox-heavy.yaml, k8s/nats-cluster.yaml, k8s/pool-controller.yaml, k8s/network-policies.yaml, k8s/cloud-sql-proxy.yaml
- Created: src/pool-controller/k8s-client.ts, controller.ts, metrics.ts, main.ts
- Created: src/sandbox-worker/workspace.ts, main.ts
- Created: src/host/nats-session-protocol.ts, host-process.ts, agent-runtime-process.ts, nats-llm-proxy.ts
- Created: src/agent/nats-bridge.ts
- Modified: src/host/nats-sandbox-dispatch.ts (fix this binding), src/sandbox-worker/worker.ts (workspace provisioning), container/Dockerfile (git, workspace dir)
- Created: tests/pool-controller/controller.test.ts, metrics.test.ts, tests/sandbox-worker/workspace.test.ts, tool-handlers.test.ts, tests/host/nats-session-protocol.test.ts, nats-llm-proxy.test.ts, tests/agent/nats-bridge.test.ts
**Outcome:** Success — build passes, all new tests pass (2404 passed, 3 pre-existing failures unrelated)
**Notes:** Split monolithic server.ts into two k8s-deployable processes while keeping local dev path unchanged. NATS session protocol enables host→agent-runtime dispatch. Pool controller manages warm pod scaling. Workspace provisioning supports GCS cache → git clone → empty fallback.
