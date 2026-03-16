## [2026-03-16 13:00] — Add NATS static user authentication to Helm chart

**Task:** Add NATS static user authentication with two users: "host" (full access) and "sandbox" (restricted)
**What I did:**
1. Added `authorization` block to `charts/ax/values.yaml` under `nats.config` with two users:
   - `host`: full publish/subscribe access (`">"`)
   - `sandbox`: restricted to `ipc.request.*.*`, `ipc.llm.*.*`, `_INBOX.>` publish; denied `session.>`, `results.>`, `events.>` subscribe
2. Created `charts/ax/templates/nats-auth-secret.yaml` — K8s Secret with auto-generated passwords (via `randAlphaNum 32`) when values are empty, or user-supplied passwords otherwise
3. Modified `charts/ax/templates/host/deployment.yaml` — added `NATS_USER` and `NATS_PASS` env vars right after `NATS_URL`
4. Modified `charts/ax/templates/nats-stream-init-job.yaml` — added env vars for NATS auth, shell logic to conditionally pass `--user`/`--password` flags, updated all `nats` CLI calls to include `$NATS_AUTH`
**Files touched:** `charts/ax/values.yaml`, `charts/ax/templates/nats-auth-secret.yaml` (new), `charts/ax/templates/host/deployment.yaml`, `charts/ax/templates/nats-stream-init-job.yaml`
**Outcome:** Success — NATS now supports static user auth; sandbox pods get least-privilege access to NATS subjects
**Notes:** Passwords default to empty string in values.yaml (no auth in dev). The secret uses `dig "password"` with `randAlphaNum 32` fallback, so Helm generates random passwords when none are provided. The `optional: true` on secretKeyRef means pods still start even if the secret is missing.
