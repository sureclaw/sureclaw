## [2026-04-17 22:05] — Wire AX_HOOK_SECRET + AX_HOST_URL in chart so reconcile hook actually fires

**Task:** After a user drafted a new skill (agent wrote `.ax/skills/linear/SKILL.md`, sidecar committed + pushed), nothing appeared in the admin dashboard's Skills page. Traced to the post-receive reconcile hook being a silent no-op in k8s: neither `AX_HOOK_SECRET` nor `AX_HOST_URL` was set anywhere in the chart.
**Root cause:** `container/git-server/install-hook.js:33` short-circuits on unset secret (`if [ -z "${AX_HOOK_SECRET:-}" ]; then exit 0; fi`). And even if set, the hook's `AX_HOST_URL` defaulted to `http://localhost:8080` — which resolves to the git-server pod itself, not the host. So every push was a silent drop.
**What I did:**
1. New template `charts/ax/templates/hook-secret.yaml` — a Secret with `helm.sh/resource-policy: keep` that generates 64 random alphanumeric chars on first install and reuses the existing value across upgrades via `lookup "v1" "Secret"`. Keep-policy matters because each per-agent bare-repo hook script embeds the agent ID but reads the secret from env at runtime; if the secret rotates, all installed hooks break until re-installed.
2. `charts/ax/templates/host/deployment.yaml` — added `AX_HOOK_SECRET` via `secretKeyRef` just above the `ax.databaseEnv` include. The host already reads `process.env.AX_HOOK_SECRET` at `src/host/server.ts:165` (generating a random fallback with a warning if unset) — just wiring the env now makes the prior fallback path dead for k8s installs, which is the desired behavior.
3. `charts/ax/templates/git-server-deployment.yaml` — added both `AX_HOOK_SECRET` (from the same Secret) and `AX_HOST_URL` (`http://<fullname>-host`, the cluster-internal host service DNS name on port 80) to the container's env block, with a comment pointing back at `install-hook.js` so the wiring's reason survives.
**Files touched:** `charts/ax/templates/hook-secret.yaml` (new), `charts/ax/templates/host/deployment.yaml`, `charts/ax/templates/git-server-deployment.yaml`
**Outcome:** `helm template` against the user's `ax-values.yaml` renders all three correctly — Secret present, `AX_HOOK_SECRET` valueFrom on both pods, `AX_HOST_URL: http://test-ax-host` on git-server. User needs a `helm upgrade` to pick it up; new agents created after that will get hooks that actually fire.
**Notes:** NetworkPolicy-wise, the git-server pod has no matching policy (only `ax.io/plane: ingress` and `execution` planes have ones), so default-allow for egress — the POST from git-server → host service goes through without another chart change. Separate concern: existing bare repos pre-dating this change already have a post-receive hook installed with the agent ID baked in — those will start firing as soon as `AX_HOOK_SECRET` is visible in the git-server pod's env, no repo-level migration needed.

## [2026-03-06 00:00] — Helm Chart Deployment Improvements (5 fixes)

**Task:** Fix 5 deployment issues found during kind cluster deployment
**What I did:**
1. Added `global.imageTag` fallback in `ax.image` helper — single override for all components
2. Added `{{- if ne .Values.poolController.enabled false }}` guards to all 5 pool-controller templates
3. Fixed DATABASE_URL for internal PostgreSQL — construct from PGPASSWORD + inline string instead of requiring external secret
4. Made API credential secretKeyRefs optional (`optional: true`) to prevent CreateContainerConfigError
5. Updated kind-values.yaml to use `global.imageTag: test` instead of per-component overrides
**Files touched:** `_helpers.tpl`, `values.yaml`, 5 pool-controller templates, host/deployment.yaml, agent-runtime/deployment.yaml, kind-values.yaml
**Outcome:** Success — helm template verified for both kind-values (internal PG, pool-controller disabled) and defaults (external PG, pool-controller enabled)
**Notes:** Helm `default` function treats `false` as empty, so `default true false` returns `true`. Used `ne .Values.poolController.enabled false` pattern instead.
