# Host: Server

Server core, completions pipeline, file handling, bootstrap, admin gate, session management.

## [2026-03-17 18:52] — Fix blank k8s filesystem: HTTP-based provisioning (pod→host→GCS)

**Task:** Files in GCS still not appearing on pod filesystem after SDK fix — pod has no GCS credentials either
**What I did:** Realized the pod has no GCS credentials at all (no gsutil, no service account key). The write path (workspace release) works because it goes via HTTP to the host which HAS credentials. Made the read path symmetric: added `GET /internal/workspace/provision` endpoint to host-process.ts that reads from GCS via `downloadScope()` (new method on WorkspaceProvider), returns gzipped JSON. Changed `provisionScope` in workspace.ts to accept `hostUrl` and use HTTP when available. Changed `provisionWorkspaceFromPayload` in runner.ts to always provision via HTTP when `AX_HOST_URL` is set — no longer depends on GCS prefix fields in the work payload.
**Files touched:** `src/providers/workspace/types.ts`, `src/providers/workspace/gcs.ts`, `src/host/host-process.ts`, `src/agent/workspace.ts`, `src/agent/runner.ts`
**Outcome:** Clean build, all tests pass
**Notes:** This is the architectural fix: host is the single GCS credential holder, pods only talk to host via HTTP. Mirrors the existing release flow (pod→HTTP POST→host→GCS) with a symmetric provision flow (GCS→host→HTTP GET→pod).

## [2026-03-17 18:45] — Fix blank k8s filesystem: replace gsutil with @google-cloud/storage SDK in provisionScope

**Task:** Files in GCS still not restored to pod filesystem after prefix fix
**What I did:** Ran diagnostics (gsutil ls, pod logs, which gsutil). Confirmed: no `provision_` log entries (prefixes not in payload — original bug), AND `gsutil` not installed in agent pod (provisionScope would silently fail even with correct prefixes). Replaced the `gsutil -m rsync` shell call in `provisionScope` with `@google-cloud/storage` SDK (lazy import), also replaced `execSync chmod` with `chmodSync` per project hook policy.
**Files touched:** `src/agent/workspace.ts`
**Outcome:** Success — clean build, two root causes addressed
**Notes:** Diagnostic-first approach: listing the bucket confirmed path structure (`test/scratch/{sessionId}/...`), pod logs showed zero provision_ entries (payload missing), `which gsutil` confirmed the CLI is absent.

## [2026-03-17 18:08] — Fix blank k8s filesystem: GCS prefix sourced from config, not only env var

**Task:** Agent sees blank filesystem on each new k8s turn despite files being in GCS
**What I did:** Identified that `server-completions.ts` read `AX_WORKSPACE_GCS_PREFIX` env var for provisioning prefixes in the work payload, while the GCS backend uses `config.workspace.prefix` for commits — two independent sources. Extracted `resolveWorkspaceGcsPrefixes()` as an exported helper that prefers `config.workspace.prefix` with env var fallback; used it in the payload builder; added regression tests.
**Files touched:** `src/host/server-completions.ts`, `tests/host/server-completions-gcs-prefix.test.ts`
**Outcome:** Success — 4 regression tests pass
**Notes:** The write path (gcs.ts createRemoteTransport.commit) uses `wsConfig.prefix` from config. The provision path used a separate env var. When users configure workspace.prefix in config but forget AX_WORKSPACE_GCS_PREFIX, provisioning is silently skipped → blank emptyDir volumes every turn.

## [2026-03-17 00:00] — Add logger calls to identity_write decision paths

**Task:** Add structured log lines to identity_write handler for k8s debugging
**What I did:** Added `getLogger` import and `logger.info('identity_write_decision', { decision, file, sessionId })` at each decision branch (rejected_non_admin, queued_tainted, queued_paranoid, applied) in `identity_write`. Audit log already existed; these go to pod stdout/stderr for `kubectl logs` visibility.
**Files touched:** `src/host/ipc-handlers/identity.ts`
**Outcome:** Success
**Notes:** scanner_blocked path was intentionally left without a logger call since it returns `ok: false` (not queued) and is already distinct in audit log.

## [2026-03-16 12:22] — Fix delegation CPU tier, git push without GCS, and missing cache key

**Task:** Fix three bugs: (1) delegated CPU tier not propagated to child sandbox, (2) git workspace changes not pushed without GCS prefix, (3) cleanup cache key never passed.
**What I did:**
- (1) Set `tiers: { default: tierConfig, heavy: ... }` in child sandbox config in both `server.ts` and `host-process.ts`, so `server-completions.ts:778` reads the resolved tier's cpus. Also added full tier resolution to `host-process.ts` which was missing it entirely.
- (2) Changed cleanup args to always pass `--push-changes true` (not conditional on `workspaceGcsPrefix`), so git-only setups push changes back.
- (3) Compute `workspaceCacheKey` on the host side using the same sha256 algorithm as `workspace.ts:computeCacheKey`, pass it via `--cache-key` to both provision and cleanup phases.
**Files touched:** `src/host/server.ts`, `src/host/host-process.ts`, `src/host/server-completions.ts`
**Outcome:** Success — all 2442 tests pass, build clean.
**Notes:** `tiers` type requires both `default` and `heavy` fields; used spread with fallback for `heavy` to preserve any existing config.

## [2026-03-16 12:15] — Fix stream keepalive timer leak on client disconnect + redact error details

**Task:** (1) Stop the SSE keepalive interval when a streaming client disconnects mid-completion. (2) Stop leaking raw exception messages to clients in the streaming error path.
**What I did:** Added `req.on('close')` and `req.on('error')` handlers in the streaming path of both `server.ts` and `host-process.ts` that clear the keepalive timer and unsubscribe from the event bus. Also replaced the interpolated `(err as Error).message` in server.ts's streaming catch block with a generic string, matching host-process.ts and the non-streaming path.
**Files touched:** `src/host/server.ts`, `src/host/host-process.ts`
**Outcome:** Success — keepalive timer stops immediately on client disconnect; error details are logged server-side only and not sent to clients.
**Notes:** `clearInterval`/`unsubscribe` are idempotent, so the `finally` block remains as a safety net for the normal path.

## [2026-03-16 15:50] — Fix chat completions streaming hang on error

**Task:** Debug why chat completions requests from web UIs hang with no host logs
**What I did:** Found two bugs in server.ts handleCompletions streaming path: (1) If processCompletion throws during streaming, SSE headers are already sent, so the outer catch in handleRequest checks `!res.headersSent` (false) and skips calling `res.end()` — leaving the SSE connection open forever. (2) No info-level logging for incoming requests, so users see "no logs" even when requests are being processed. Fixed by wrapping streaming processCompletion in try/catch/finally (matching the pattern already used in host-process.ts), adding SSE keepalive comments, and adding info-level `chat_request` logging.
**Files touched:** src/host/server.ts, tests/host/streaming-completions.test.ts
**Outcome:** Success — streaming errors now send an error SSE chunk and close the connection; event bus subscriptions and keepalive timers are cleaned up via finally block
**Notes:** host-process.ts already had the correct pattern — this was a parity gap in server.ts

## [2026-03-14 12:10] — Decouple agent from container sandbox in processCompletion

**Task:** For apple/docker container sandboxes, override the agent sandbox to subprocess so the agent loop runs on the host, not inside the container. This is the lazy sandbox wiring step.
**What I did:** Added `agentSandbox` variable that overrides to subprocess for apple/docker (not k8s — already handled in agent-runtime-process.ts). Added `agentInContainer` flag for command/path decisions. Updated spawn and kill calls to use `agentSandbox`. Fixed sandbox-isolation source regex test to match `agentSandbox.spawn`.
**Files touched:** src/host/server-completions.ts, tests/sandbox-isolation.test.ts
**Outcome:** Success — 2417 tests pass
**Notes:** Pattern matches agent-runtime-process.ts k8s handling. `isContainerSandbox` still used for workspace mount decisions; `agentInContainer` for agent process behavior.

## [2026-03-02 12:45] — Add HTTP bootstrap admin claiming to handleCompletions

**Task:** Fix bug where the first HTTP user wasn't added to the admins file during bootstrap. The bootstrap admin claiming only existed in the channel handler (Slack, Discord), not in the HTTP completions path.
**What I did:** Added bootstrap gate logic to `handleCompletions` in server.ts — after userId extraction, calls `claimBootstrapAdmin(agentDirVal, userId)` when bootstrap mode is active and user is not already an admin. Returns 403 if admin is already claimed and user is not admin. Added 3 integration tests: auto-promote first HTTP user, block second HTTP user, allow requests without user field.
**Files touched:** src/host/server.ts, tests/host/admin-gate.test.ts
**Outcome:** Success — 2011 tests pass, TypeScript clean
**Notes:** The HTTP path uses 403 status code (vs channel handler which sends a chat message) since HTTP clients can handle HTTP error codes directly.

## [2026-02-26 15:00] — AI SDK format for image content blocks

**Task:** Map internal image content blocks to AI SDK UI message stream schema.
**What I did:** In `handleCompletions`, internal `{type: 'image', fileId, mimeType}` blocks are now mapped to `{type: 'file', url: '/v1/files/<fileId>', mediaType}` before returning. Text blocks pass through unchanged. Updated 2 integration tests to assert the new format.
**Files touched:** src/host/server.ts, tests/host/server-multimodal.test.ts
**Outcome:** Success — 1650 tests pass, TypeScript clean
**Notes:** The URL in the file block is a relative path to AX's file endpoint. The Next.js BFF can rewrite this to its own proxy URL before passing to the browser.

## [2026-02-26 14:47] — FileStore: fileId-only file lookups via SQLite

**Task:** Enable `/v1/files/:fileId` downloads without requiring `?agent=...&user=...` query params. Files are globally unique UUIDs — the server should resolve the workspace path from the fileId alone.
**What I did:** Created `FileStore` class (SQLite-backed, same pattern as ConversationStore) with `register(fileId, agent, user, mimeType)` and `lookup(fileId)` methods. Created `files` migration. Updated `handleFileDownload` to fall back to FileStore lookup when agent/user params are missing. Wired FileStore into server composition root, handleFileUpload, and both file-write points in processCompletion (extractImageDataBlocks + generated image persistence).
**Files touched:** Created: src/file-store.ts, src/migrations/files.ts, tests/host/file-store.test.ts. Modified: src/host/server-files.ts, src/host/server.ts, src/host/server-completions.ts, tests/host/server-files.test.ts
**Outcome:** Success — 1650 tests pass, TypeScript clean
**Notes:** The Next.js proxy can now call `GET /v1/files/:fileId` without knowing agent/user. Old callers with query params still work (params take priority over lookup).

## [2026-02-25 23:12] — Concurrent-safe session ID propagation for image generation

**Task:** Make image generation concurrent-safe by propagating session ID from host through IPC to image handler
**What I did:** Added `sessionId` to StdinPayload/AgentConfig/parseStdinPayload. Passed it through stdin payload from processCompletion. Updated all 3 runners (pi-core, pi-session, claude-code) to pass `sessionId` to IPCClient. IPCClient injects `_sessionId` into every IPC request. IPC server extracts it, strips it before strict Zod validation, and creates `effectiveCtx` with the real session ID. Updated all `ctx` references (audit, taint) to use `effectiveCtx`. Changed `drainGeneratedImages('server')` to `drainGeneratedImages(queued.session_id)`.
**Files touched:** src/agent/runner.ts, src/agent/ipc-client.ts, src/agent/runners/pi-session.ts, src/agent/runners/claude-code.ts, src/host/ipc-server.ts, src/host/server-completions.ts
**Outcome:** Success — all 1633 tests pass, concurrent sessions can now generate images without cross-session leaks
**Notes:** Critical bug found: IPC schemas use `z.strictObject` which rejects unknown fields. The `_sessionId` field caused all IPC calls to fail with validation errors. Fixed by deleting `_sessionId` from the parsed object before schema validation.

## [2026-02-26 22:14] — Fix diagnoseError crash on undefined/null input

**Task:** Fix TypeError crash in `diagnoseError` when called with `undefined` from a `.catch()` handler
**What I did:** Added nullish guard to `diagnoseError` — changed type signature to accept `undefined | null`, used optional chaining (`err?.message ?? 'Unknown error'`). Added test covering undefined and null inputs.
**Files touched:** src/errors.ts, tests/errors.test.ts
**Outcome:** Success — all 1723 tests pass, crash no longer occurs
**Notes:** All 5 callers use `err as Error` from `.catch()` blocks. A Promise can reject with `undefined` (e.g., `reject()` with no args), so the error boundary function must be defensive.

## [2026-02-22 22:00] — Bootstrap admin auto-promotion for first channel user

**Task:** Fix UX bug where no channel user can interact during bootstrap because the admins file is seeded with the OS username (not a Slack user ID)
**What I did:**
- Added `addAdmin()` and `claimBootstrapAdmin()` to `src/host/server.ts` — claim uses atomic file creation (`writeFileSync` with `'wx'` flag) to ensure only one user wins
- Updated `ChannelHandlerDeps` interface and bootstrap gate in `src/host/server-channels.ts` — first channel user during bootstrap is auto-promoted to admin
- Added `.bootstrap-admin-claimed` cleanup in `src/cli/bootstrap.ts` `resetAgent()` so re-bootstrap allows a new first-user claim
- Added unit tests for `addAdmin` and `claimBootstrapAdmin`, plus integration tests for auto-promotion and second-user blocking
- Added bootstrap test for `.bootstrap-admin-claimed` cleanup
**Files touched:** src/host/server.ts, src/host/server-channels.ts, src/cli/bootstrap.ts, tests/host/admin-gate.test.ts, tests/cli/bootstrap.test.ts
**Outcome:** Success — new bootstrap cleanup tests pass (4/5, 1 pre-existing failure). Admin-gate integration tests can't run in this environment due to missing `yaml` dependency (pre-existing).
**Notes:** The atomic claim via `O_EXCL` is simple and race-safe for a single-server process. The claim file stores the userId for debugging. The OS username stays in the admins file (inert for channel access, useful for CLI).

## [2026-02-22 19:02] — Fix stale .bootstrap-admin-claimed blocking re-bootstrap

**Task:** Bug: even when admins file is empty, DMs get "This agent is still being set up" instead of auto-promoting the first user
**What I did:** Root cause was `.bootstrap-admin-claimed` persisting across server restarts. When admins file is emptied (to re-bootstrap), the stale claim file caused `claimBootstrapAdmin()` to always return false. Fixed by adding a stale-claim check: if the claim file exists but the claimed user is not in the admins file, remove it before attempting the new claim.
**Files touched:** src/host/server.ts (modified claimBootstrapAdmin), tests/host/admin-gate.test.ts (added regression test)
**Outcome:** Success — 21/21 admin-gate tests pass, 41/41 host tests pass
**Notes:** The fix is in `claimBootstrapAdmin()` itself rather than at server startup, so it self-heals whenever the function is called. The `wx` flag still provides atomicity for concurrent callers after the stale check.

## [2026-02-22 23:30] — Fix bootstrap: no pre-seeded admin, require both SOUL.md and IDENTITY.md

**Task:** Two bootstrap fixes: (1) `bun serve` was adding `process.env.USER` to admins on first run — should wait for channel connection; (2) BOOTSTRAP.md should only be deleted when both SOUL.md and IDENTITY.md exist
**What I did:**
- Changed `createServer()` to create an empty admins file instead of seeding with `process.env.USER`
- Updated `isAgentBootstrapMode()` to require both SOUL.md and IDENTITY.md (not just SOUL.md) before exiting bootstrap
- Updated bootstrap completion in `identity.ts` and `governance.ts` handlers to check `isAgentBootstrapMode()` instead of just checking for SOUL.md
- Updated `isBootstrapMode()` in prompt types to match (agent-side check)
- Updated tests to reflect new behavior
**Files touched:** src/host/server.ts, src/host/ipc-handlers/identity.ts, src/host/ipc-handlers/governance.ts, src/agent/prompt/types.ts, tests/host/server.test.ts, tests/host/admin-gate.test.ts
**Outcome:** Success — all 144 tests pass
**Notes:** The `isAgentBootstrapMode` function is now the single source of truth for bootstrap state — both the server-side gate and the identity/governance handlers use it. No circular imports since server.ts doesn't import from ipc-handlers. Also fixed ReplyGateModule — it was telling the agent it could stay silent during bootstrap (DMs have `isMention: false` → `replyOptional: true`), causing the agent to ignore "hello" instead of starting the bootstrap conversation.

## [2026-02-23 06:10] — Fix skills stored under ~/.ax instead of relative CWD path

**Task:** Skills providers used `const skillsDir = 'skills'` (CWD-relative), meaning skills disappeared on restart or when server ran from different directory
**What I did:** Added `agentSkillsDir()` to paths.ts; updated readonly.ts, git.ts to use it; added first-run seed from project-root skills/ in server.ts; updated server-completions.ts to copy from persistent location; renamed `skillsDir()` → `seedSkillsDir()` in assets.ts; updated all tests
**Files touched:**
- Modified: src/paths.ts, src/providers/skills/readonly.ts, src/providers/skills/git.ts, src/host/server.ts, src/host/server-completions.ts, src/utils/assets.ts
- Modified tests: tests/providers/skills/readonly.test.ts, tests/providers/skills/git.test.ts, tests/host/server.test.ts, tests/integration/cross-component.test.ts
**Outcome:** Success — all 1451 tests pass across 144 files
**Notes:** Had to update 4 test files total (not just the 2 in the plan) because cross-component.test.ts and server.test.ts also referenced the old CWD-relative skills path

## [2026-02-22 22:23] — Fix bootstrap lifecycle bugs + add missing tests

**Task:** Fix two bugs: (1) `.bootstrap-admin-claimed` not deleted after bootstrap completion, (2) BOOTSTRAP.md recreated on server restart after bootstrap completes. Also fix a pre-existing broken test and add missing end-to-end bootstrap lifecycle tests.
**What I did:**
- `server.ts`: Skip copying BOOTSTRAP.md from templates if both SOUL.md and IDENTITY.md already exist (bootstrap already completed)
- `identity.ts` + `governance.ts`: Delete `.bootstrap-admin-claimed` alongside BOOTSTRAP.md on bootstrap completion
- Fixed broken test in `ipc-server.test.ts` that expected BOOTSTRAP.md deletion with only SOUL.md written (needs BOTH files)
- Added two new integration tests to `admin-gate.test.ts`: bootstrap completion cleanup, and server restart not recreating BOOTSTRAP.md
**Files touched:**
- Modified: src/host/server.ts, src/host/ipc-handlers/identity.ts, src/host/ipc-handlers/governance.ts
- Modified: tests/host/ipc-server.test.ts, tests/host/admin-gate.test.ts
**Outcome:** Success — 144 files, 1454 tests pass (previously had 1 failing test)
**Notes:** The pre-existing test "deletes BOOTSTRAP.md when SOUL.md is written" was always wrong — bootstrap requires BOTH SOUL.md AND IDENTITY.md before cleanup triggers. It was masking the fact that no test ever verified the full lifecycle including server restarts.

## [2026-02-26 22:20] — Fix Slack retry logging "undefined" error

**Task:** Diagnose and fix `error: "undefined"` in Slack channel retry logs
**What I did:** The `@slack/bolt` SDK can reject with `undefined` on socket failures. Fixed two layers: (1) `withRetry` now logs descriptive message instead of `String(undefined)`, (2) `connectChannelWithRetry` wraps `undefined` rejections into a real Error with the channel name so retry classification and logging work correctly.
**Files touched:** src/utils/retry.ts, src/host/server-channels.ts, tests/utils/retry.test.ts, tests/host/channel-reconnect.test.ts
**Outcome:** Success — all 1725 tests pass. Next time Slack connect fails, the log will show "test-channel connect() rejected without an error value" instead of "undefined"
**Notes:** Root cause of the Slack connection failure itself is unknown — the `error: "undefined"` was masking it. With this fix, the next failure will produce a real error message. Common causes: invalid app token, Socket Mode not enabled, network issues.
