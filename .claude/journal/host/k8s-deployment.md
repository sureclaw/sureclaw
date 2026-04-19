# K8s Deployment Journal

## [2026-04-17 20:45] — Fix Postgres startup: unixepoch() error + BetterAuth base_url config

**Task:** User's kind-deployed AX host crashed on startup with `function unixepoch() does not exist` against Postgres, plus a warning `[Better Auth]: Base URL could not be determined`.
**What I did:**
- Root cause 1: `src/host/server-init.ts` imported the SQLite-hardcoded default exports `skillsMigrations` and `adminOAuthMigrations` (baked with `buildX('sqlite')`) and ran them against whatever DB the provider returned. Swapped to the dialect-aware factories `buildSkillsMigrations(providers.database.type)` and `buildAdminOAuthMigrations(providers.database.type)`.
- Root cause 2: BetterAuth requires `baseURL` (env `BETTER_AUTH_URL` or option) for OAuth redirects. Added `auth.better_auth.base_url` to the Zod schema in `src/config.ts`, Config type in `src/types.ts`, and threaded it into `betterAuth({ baseURL })` in `src/providers/auth/better-auth.ts` (falls back to `process.env.BETTER_AUTH_URL`).
- Also fixed user's `ax-values.yaml`: `better-auth:` → `better_auth:` to match Zod schema's snake_case key.
- Restyled `ui/chat/src/App.tsx` LoginPage to match admin's login (same `.card` wrapper, `text-amber`, `bg-foreground/[0.04]`, `border-border/50`, and `bg-foreground text-background` button). Added the `.card` component class to `ui/chat/src/index.css` so chat can reuse it.
**Files touched:** `src/host/server-init.ts`, `src/config.ts`, `src/types.ts`, `src/providers/auth/better-auth.ts`, `ui/chat/src/App.tsx`, `ui/chat/src/index.css`, `ax-values.yaml` (user's local)
**Outcome:** Success — `npm run build` clean, migrations + config tests pass (5 + 26), chat UI typecheck clean.
**Notes:** The hardcoded-'sqlite' defaults in `src/migrations/{skills,admin-oauth-providers,files,jobs}.ts` are landmines for Postgres deployments; only the two imported by server-init were active bugs, but the others should eventually be deleted or migrated to build-style callers.

## [2026-03-25 20:35] — Remove skill_list/skill_read IPC and workspace GCS provisioning

**Task:** Remove dead IPC actions and dead workspace GCS provisioning code
**What I did:** (1) Removed skill_list/skill_read from IPC schemas, handlers, tool catalog, MCP server, capabilities template, and manifest generator. (2) Removed provision() and cleanup() from workspace-cli.ts, gutted workspace.ts to only keep diffScope (used by release). (3) Removed GCS prefix fields (agentGcsPrefix, userGcsPrefix, sessionGcsPrefix, workspaceCacheKey) from StdinPayload and resolveWorkspaceGcsPrefixes() from server-completions.ts. (4) Updated all tests.
**Files touched:** `src/ipc-schemas.ts`, `src/host/ipc-handlers/skills.ts`, `src/agent/tool-catalog.ts`, `src/agent/mcp-server.ts`, `templates/capabilities.yaml`, `src/utils/manifest-generator.ts`, `src/agent/workspace-cli.ts`, `src/agent/workspace.ts`, `src/agent/runner.ts`, `src/host/server-completions.ts`, 6 test files
**Outcome:** Success — all 2634 tests pass. skill tool now has install/update/delete only. Workspace provisioning is gone.
**Notes:** Skills are DB-backed and delivered via payload. Agent reads from filesystem (written by runner from payload). workspace_* IPC tools handle all workspace operations. Only workspace-cli.ts release() remains for end-of-turn diff upload.

## [2026-03-25 20:10] — Move skill persistence from GCS/filesystem to database-only

**Task:** Skills were being stored in GCS bucket instead of only in database
**What I did:** Removed GCS write (setRemoteChanges) and filesystem write (mkdirSync/writeFileSync) from skill_install handler. Made DB upsertSkill the primary persistence. Added skills delivery via stdinPayload (loaded from DB on host, delivered to agent like identity). Agent-setup now uses preloaded skills from payload when available, falls back to filesystem dirs.
**Files touched:** `src/host/ipc-handlers/skills.ts` (removed GCS+filesystem writes, DB is primary), `src/host/server-completions.ts` (load skills from DB, add to stdinPayload), `src/agent/runner.ts` (skills field in AgentConfig/StdinPayload/applyPayload), `src/agent/agent-setup.ts` (prefer payload skills over filesystem), `tests/host/ipc-handlers/skills.test.ts` (rewritten for DB assertions), `tests/sandbox-isolation.test.ts` (updated for new pattern)
**Outcome:** Success — skills stored in DB only, delivered via payload, no GCS or filesystem writes
**Notes:** The skill_install handler had 3 persistence paths (filesystem, GCS, DB). Now only DB. Agent loads skills from payload (like identity) with filesystem fallback for subprocess mode.

## [2026-03-25 19:45] — Fix session-long pod reuse: token keying + per-turn token update

**Task:** Sandbox pods were killed immediately after each turn instead of being reused across turns
**What I did:** Three fixes: (1) Changed work queue keying from per-turn token to sessionId in session-pod-manager. (2) Added authToken to SessionPod + reverse token→session map so pods authenticate with their original spawn token. (3) Fixed agent runner to update AX_IPC_TOKEN unconditionally from each turn's payload and removed stale env var override in work loop.
**Files touched:** `src/host/session-pod-manager.ts` (authToken field, tokenToSession map, queueWork/claimWork by sessionId, findSessionByToken), `src/host/server-k8s.ts` (authToken in registerSessionPod, findSessionByToken in /internal/work), `src/host/server-completions.ts` (queueWork by sessionId, skip kill when session pod tracked, pod reuse via getSessionPod/registerSessionPod), `src/agent/runner.ts` (unconditional AX_IPC_TOKEN update, removed stale setContext override)
**Outcome:** Success — one sandbox pod serves multiple turns, no pod per turn. Turn 2 skips spawn entirely.
**Notes:** The root cause was a per-turn token mismatch: each turn creates a new turnToken, but the pod keeps polling with its original token. Fix uses session-level auth (original token for authentication) + per-turn tokens (delivered in payload for IPC calls).

## [2026-03-25 19:15] — Fix k8s work dispatch: sessionPodManager.queueWork never called

**Task:** Debug chat UI stuck on "Starting sandbox" in kind-ax cluster
**What I did:** Traced the HTTP work dispatch flow: host spawns pod, pod polls GET /internal/work, but work was never queued. The session pod manager's `queueWork()` existed but was never wired into the completion pipeline. Added `queueWork` callback to `CompletionDeps`, passed it from `server-k8s.ts`, and called it in the k8s branch of `server-completions.ts` where stdin write is skipped.
**Files touched:** `src/host/server-completions.ts` (added `queueWork` to `CompletionDeps`, called it in k8s branch), `src/host/server-k8s.ts` (passed `queueWork` via `turnDeps`)
**Outcome:** Success — pod now fetches work and responds in ~5s
**Notes:** The simplification commit (c650600) implemented all the pieces (session pod manager, /internal/work endpoint, agent work loop) but missed wiring `queueWork()` into the completion pipeline. The three pieces were implemented in isolation.

## [2026-03-18 06:00] — Fix PR review: scheduler preProcessed reuse and LLM model precedence

**Task:** Address two code review comments on the k8s-scheduler-and-model-routing PR
**What I did:**
1. **P1 — Reuse preprocessed scheduler message**: Added `preProcessed` parameter to `processCompletionWithNATS()` and forwarded it to `processCompletion()`. Updated the scheduler callback to pass `{ sessionId, messageId, canaryToken }` so the message isn't scanned/enqueued a second time (matching server.ts behavior).
2. **P2 — Preserve explicit llm_call model overrides**: Changed model precedence in LLM handler from `configModel ?? req.model` to `req.model ?? configModel`, so delegation's per-request model override takes priority over the host's default.
**Files touched:** `src/host/host-process.ts`, `src/host/ipc-handlers/llm.ts`, `tests/host/ipc-handlers/llm-events.test.ts`
**Outcome:** Success — build clean, 2412 tests pass (2 new model precedence tests added)
**Notes:** The orphaned queue entry + canary bypass was a real security issue — without preProcessed, processCompletion re-enqueues with a different canary token, making the outbound scan compare against the wrong canary.

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
