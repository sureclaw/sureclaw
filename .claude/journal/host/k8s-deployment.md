# K8s Deployment Journal

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
