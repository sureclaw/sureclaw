## [2026-03-16 00:00] — Host RBAC for sandbox pod management

**Task:** Create RBAC resources so the host pod can manage sandbox pods in Kubernetes
**What I did:**
1. Created `charts/ax/templates/host/serviceaccount.yaml` — dedicated ServiceAccount for the host
2. Created `charts/ax/templates/host/role.yaml` — Role granting pods CRUD, pods/log read, pods/attach+exec
3. Created `charts/ax/templates/host/rolebinding.yaml` — binds the ServiceAccount to the Role
4. Modified `charts/ax/templates/host/deployment.yaml`:
   - Added `serviceAccountName` at pod spec level
   - Added `K8S_NAMESPACE` and `K8S_POD_IMAGE` env vars for the k8s sandbox provider
   - Changed `terminationGracePeriodSeconds` from configurable value to hardcoded `600` (host runs long sessions)
**Files touched:** Created 3 new files, modified `charts/ax/templates/host/deployment.yaml`
**Outcome:** Success — host deployment now has full RBAC to create/manage sandbox pods
**Notes:** The Role is namespace-scoped (not ClusterRole), which limits blast radius. The sandbox image is resolved via the same `ax.image` helper used elsewhere.
