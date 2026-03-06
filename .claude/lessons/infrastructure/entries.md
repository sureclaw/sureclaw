### k8s init should use single secret for all API credentials
**Date:** 2026-03-06
**Context:** FIX-2 — k8s init created separate secrets for LLM and embeddings API keys, but the Helm chart's `apiCredentials.envVars` maps all env vars from a single `existingSecret`.
**Lesson:** Keep all API credentials (LLM, embeddings, etc.) in the single `ax-api-credentials` secret via `apiCredentials.envVars`. Don't create separate per-provider secrets with `agentRuntime.env` — it diverges from the chart's native pattern and causes mismatch with kind-values.yaml. When providers share the same secret key name (e.g., both use openai), skip the duplicate literal.
**Tags:** k8s-init, helm, secrets, apiCredentials, embeddings

### Calico DNAT means ClusterIP port != actual port for NetworkPolicy
**Date:** 2026-03-05
**Context:** Agent-runtime pod couldn't reach k8s API (10.96.0.1:443) despite port 443 egress being allowed in NetworkPolicy
**Lesson:** With Calico CNI, egress NetworkPolicy port checks may apply after DNAT. The k8s API ClusterIP service forwards 443→6443. Add BOTH port 443 and port 6443 to egress rules for k8s API access. External HTTPS endpoints (port 443 end-to-end) work fine.
**Tags:** calico, networkpolicy, dnat, k8s-api, kind

### Agent-runtime must use subprocess sandbox for the agent loop in k8s
**Date:** 2026-03-05
**Context:** processCompletion uses providers.sandbox to spawn the agent subprocess. When sandbox=k8s-pod, it creates a new k8s pod that can't connect back via Unix socket IPC.
**Lesson:** In agent-runtime-process.ts, always override providers.sandbox to subprocess for the agent conversation loop. The k8s-pod provider is only for tool dispatch to sandbox worker pods. The agent loop runs in-process (as a subprocess within the agent-runtime pod), not in a separate k8s pod.
**Tags:** k8s, sandbox, agent-runtime, ipc, subprocess

### k8s labels must start/end with alphanumeric characters
**Date:** 2026-03-05
**Context:** Pod creation failed with "Invalid value" for label derived from Unix socket path
**Lesson:** When using user-controlled strings as k8s label values, sanitize with regex: replace invalid chars with `_`, then strip leading/trailing non-alphanumeric with `.replace(/^[^a-zA-Z0-9]+/, '').replace(/[^a-zA-Z0-9]+$/, '')`. Labels must match `(([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9])?`.
**Tags:** k8s, labels, validation, sanitization

### Helm subchart dependencies should be gitignored
**Date:** 2026-03-05
**Context:** Creating Helm chart with NATS and PostgreSQL subcharts
**Lesson:** Add `charts/*/charts/` and `charts/*/Chart.lock` to .gitignore. These are downloaded by `helm dependency update` and should not be committed. The Chart.yaml specifies the version ranges.
**Tags:** helm, gitignore, subcharts

### ConfigMap-mounted config reuses loadConfig() via AX_CONFIG_PATH
**Date:** 2026-03-05
**Context:** Replacing scattered env vars with a single ax.yaml ConfigMap
**Lesson:** Adding `AX_CONFIG_PATH` env var to `configPath()` in paths.ts is all that's needed to support ConfigMap-mounted config in k8s. The existing loadConfig() reads from configPath() and handles all parsing/validation. No changes needed to config.ts itself.
**Tags:** config, helm, k8s, configmap

### Helm `default` treats false as empty — use `ne` for boolean guards
**Date:** 2026-03-06
**Context:** Pool-controller `enabled: false` had no effect because `default true false` returns `true`
**Lesson:** Helm's `default` function treats `false`, `0`, `""`, and `nil` as empty. For boolean opt-out guards, use `{{- if ne .Values.foo.enabled false }}` instead of `{{- if (default true .Values.foo.enabled) }}`.
**Tags:** helm, boolean, guard, template

### Bitnami PostgreSQL subchart only creates postgres-password key
**Date:** 2026-03-06
**Context:** Chart expected a `url` key with full connection string, but bitnami only creates `postgres-password`
**Lesson:** When using bitnami PostgreSQL subchart, construct DATABASE_URL from PGPASSWORD using `$(VAR_NAME)` env var expansion. Define PGPASSWORD first from secretKeyRef, then reference it in DATABASE_URL value field.
**Tags:** helm, postgresql, bitnami, database-url

### Security contexts must stay hardcoded in k8s-client.ts
**Date:** 2026-03-05
**Context:** Making sandbox tier configs Helm-configurable via SANDBOX_TEMPLATE_DIR
**Lesson:** The sandbox templates (light.json, heavy.json) mounted via ConfigMap should ONLY control resources (CPU, memory), image, command, and NATS config. Security context (gVisor runtime, readOnlyRootFilesystem, drop ALL capabilities, runAsNonRoot) must remain hardcoded in `k8s-client.ts:createPod()` — never make security hardening configurable.
**Tags:** security, helm, sandbox, k8s

### Kind cluster pods use app.kubernetes.io/name not component labels
**Date:** 2026-03-05
**Context:** Running KT-3 acceptance test, the label selector `app.kubernetes.io/component=host` returned zero pods
**Lesson:** AX Helm chart labels use `app.kubernetes.io/name=ax-host` and `app.kubernetes.io/name=ax-agent-runtime` for pod selection. The `app.kubernetes.io/component` label is only set on subchart pods (e.g., NATS, PostgreSQL). Always check `kubectl get pods --show-labels` before writing label selectors.
**Tags:** kubernetes, labels, helm, kind, acceptance-tests

### AX container images have no wget or curl — use Node.js for HTTP checks
**Date:** 2026-03-05
**Context:** Running KT-4 health check, both `wget` and `curl` were not found in the host container
**Lesson:** The AX container images are minimal and do not include wget or curl. For HTTP checks inside pods, use `node -e` with the built-in `http` module: `node -e "const http=require('http');http.get('http://localhost:8080/health',(r)=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>console.log('HTTP '+r.statusCode+' '+d))}).on('error',e=>console.error('ERROR: '+e.message))"`.
**Tags:** container, health-check, node, kubernetes, acceptance-tests

### Helm values.yaml must match the Zod config schema exactly
**Date:** 2026-03-05
**Context:** Host pod CrashLoopBackOff due to loadConfig() failing with Zod validation errors
**Lesson:** The AX config uses `z.strictObject()` — any extra keys cause validation failure. Before deploying, render the ConfigMap (`helm template -s templates/configmap-ax-config.yaml`) and validate all fields against the `ConfigSchema` in `src/config.ts`. Common mismatches: `scheduler.active_hours.start/end` must be "HH:MM" strings (not integers), `providers.scanner` must be `patterns` (not `regex`), `providers.scheduler` must be `plainjob` (not `sqlite`), and `models.default` array is required for the LLM router.
**Tags:** config, helm, zod, validation, k8s

### NATS subchart defaults memoryStore.enabled=false
**Date:** 2026-03-05
**Context:** NATS init job failed with "insufficient memory resources" when creating JetStream streams
**Lesson:** The NATS Helm chart (nats-io/nats v1.2.x) defaults `config.jetstream.memoryStore.enabled: false`. Memory-backed streams require explicitly setting `enabled: true` AND a sufficient `maxSize` (256Mi works for 5 streams). Also, `nats server ping` requires a system account — use `nats stream ls` as the readiness check instead.
**Tags:** nats, jetstream, helm, memory-store, kind

### Make gVisor runtimeClassName conditional for dev/test
**Date:** 2026-03-05
**Context:** Pool controller couldn't create sandbox pods on kind: "RuntimeClass gvisor not found"
**Lesson:** gVisor is not available on kind clusters. Make `runtimeClassName` conditional: use spread operator `...(runtimeClass ? { runtimeClassName: runtimeClass } : {})` so it's omitted when empty. The `K8S_RUNTIME_CLASS` env var already exists — set it to empty string to disable. Keep security contexts (readOnlyRootFS, runAsNonRoot, drop ALL) hardcoded regardless.
**Tags:** gvisor, kind, sandbox, k8s, security

### Bitnami subchart values are top-level under the chart alias
**Date:** 2026-03-05
**Context:** PostgreSQL auth failed because password was set at `postgresql.internal.auth.password`
**Lesson:** Helm subchart values are passed at the top level under the chart's alias key, not under custom keys. For the Bitnami PostgreSQL subchart, use `postgresql.auth.password` (NOT `postgresql.internal.auth.password`). The `internal` key is an AX-specific wrapper for the condition flag. Check the subchart's `values.yaml` for the actual schema.
**Tags:** helm, subchart, bitnami, postgresql, values

### Helm presets can't override subchart conditions
**Date:** 2026-03-06
**Context:** Implementing preset-based defaults for NATS cluster mode and PostgreSQL internal/external
**Lesson:** Helm evaluates subchart `condition:` keys (from Chart.yaml dependencies) at the values level BEFORE template rendering. Template helpers in `_presets.tpl` can control our own templates but CANNOT affect whether subcharts deploy. For subchart-controlled settings (NATS cluster, PostgreSQL internal vs external), generate the correct values in the CLI tool's output file rather than relying on preset template logic.
**Tags:** helm, presets, subchart, conditions, nats, postgresql

### Use `kindIs "invalid"` to detect null values in Helm templates
**Date:** 2026-03-06
**Context:** Implementing user override > preset > chart default resolution in Helm
**Lesson:** In Go templates, `nil` (YAML null) has kind "invalid". Use `{{- if not (kindIs "invalid" .Values.foo) -}}` to detect user-provided values vs null defaults. This allows the pattern: null in values.yaml means "use preset or chart default", while any explicit value (including empty string or 0) is treated as a user override.
**Tags:** helm, template, null-detection, presets

### Host deployment needs API credentials for memory recall and extraction
**Date:** 2026-03-06
**Context:** Running k8s cortex acceptance tests -- memory recall and embedding calls returned empty because the host pod had no API keys
**Lesson:** The Helm chart only injects `ax-api-credentials` secret into the agent-runtime deployment. The host deployment also needs API credentials for: (1) embedding-based memory recall (DEEPINFRA_API_KEY for embedding client), and (2) LLM-based memory extraction in the memorize pipeline. Until the chart is fixed, manually patch the host deployment to add envFrom/env referencing the api-credentials secret.
**Tags:** k8s, helm, api-credentials, host, memory-recall, embeddings

### Bitnami PostgreSQL needs explicit auth.password for custom users
**Date:** 2026-03-06
**Context:** Host pod CrashLoopBackOff with "password authentication failed for user ax"
**Lesson:** The Bitnami PostgreSQL subchart only auto-generates `postgres-password` (superuser) in its secret. When using a custom username (e.g., `auth.username: ax`), you MUST also set `auth.password` explicitly, or the `ax` user will be created without a password while the chart's DATABASE_URL uses `postgres-password`. Fix: either set `postgresql.internal.auth.password` in values, or use `auth.username: postgres` to match the auto-generated password.
**Tags:** k8s, helm, postgresql, bitnami, auth, password

### sqlite-vec is not available in the AX container image
**Date:** 2026-03-06
**Context:** Embedding store returned available=false on host pod, preventing vector search
**Lesson:** The AX Docker image does not include the sqlite-vec native extension. In k8s mode, the EmbeddingStore's `findSimilar()` returns empty arrays and `available` is false. This means embedding-based memory recall and semantic search do not work in k8s. Consider adding pgvector to PostgreSQL for k8s vector search, or bundling sqlite-vec in the container image.
**Tags:** k8s, sqlite-vec, embeddings, container, vector-search

### Keyword search LIKE bug: OR-joined terms treated as literal string
**Date:** 2026-03-06
**Context:** Memory recall keyword fallback produced zero results despite matching items existing
**Lesson:** `items-store.ts:searchContent()` uses `WHERE content LIKE '%query%'` where query is the raw output of `extractQueryTerms()` (e.g., "set OR deployment OR pipeline"). This does a literal substring match for the entire string including " OR ". Fix: split on " OR " and generate multiple LIKE conditions joined with SQL OR.
**Tags:** cortex, memory, keyword-search, bug, sql, like

### NATS nc.request() returns JetStream stream ack instead of worker reply
**Date:** 2026-03-05
**Context:** NATSSandboxDispatcher.claimPod() used `nc.request('tasks.sandbox.light', ...)` to claim a sandbox pod. The TASKS JetStream stream covers `tasks.sandbox.*`. The `nc.request()` returned a 27-byte JetStream publish ack (`{"stream":"TASKS","seq":N}`) instead of the worker's `claim_ack` response.
**Lesson:** When using NATS `nc.request()` on a subject that's covered by a JetStream stream, the server sends a stream publish acknowledgment to the reply-to inbox BEFORE any subscriber responds. Since `nc.request()` returns the first response, it gets the JetStream ack, not the actual reply. **Fix:** Use manual `nc.publish()` with a custom reply-to inbox + `nc.subscribe()` on that inbox, filtering for the expected response type (e.g., `type: 'claim_ack'`) and skipping JetStream acks. Alternatively, avoid overlapping core NATS request/reply subjects with JetStream stream subjects.
**Tags:** nats, jetstream, request-reply, stream-ack, sandbox-dispatch
