# Host: Server

Server core, completions pipeline, file handling, bootstrap, admin gate, session management.

## [2026-03-21 07:20] — Fix chat UI: custom OpenAI SSE transport, session ID flow, default user

**Task:** Fix three chat UI issues: empty thread list, broken chat, and missing default user
**What I did:**
- Created `ui/chat/src/lib/ax-chat-transport.ts` — custom `ChatTransport` that extends `HttpChatTransport` to parse OpenAI SSE streaming format (the AI SDK's `DefaultChatTransport` expects its own JSON event stream format)
- Replaced `AssistantChatTransport` with `AxChatTransport` in `useAxChatRuntime.tsx`, eliminating the dynamic transport proxy pattern
- Fixed session ID flow: transport embeds thread ID in `user` field ("chat-ui/{threadId}") so the server derives a deterministic session ID, avoiding `isValidSessionId` rejections
- Added default `userId = 'local-user'` in `parseChatRequest` when no JWT/user is present
- Simplified thread list adapter: `initialize()` returns immediately (server auto-creates sessions via `chatSessions.ensureExists()` during completion)
**Files touched:** `ui/chat/src/lib/ax-chat-transport.ts` (new), `ui/chat/src/lib/useAxChatRuntime.tsx`, `ui/chat/src/lib/thread-list-adapter.ts`, `src/host/server-request-handlers.ts`
**Outcome:** Success — all three issues resolved. Chat sends/receives messages with streaming, thread list shows sessions, default user ID applied. All 2516 tests pass.
**Notes:** Root cause of broken chat was protocol mismatch — `AssistantChatTransport` → `DefaultChatTransport` → `parseJsonEventStream2` expects AI SDK data stream format, not OpenAI SSE.

## [2026-03-21 04:10] — Address PR #114 coderabbitai review comments

**Task:** Fix all 14 coderabbitai review comments on the chat UI PR
**What I did:** Added DELETE endpoint, fixed SPA fallback (404 for assets with extensions), atomic upsert for ensureExists, title gating on !session.title, PII fix in generateTitle (neutral placeholder), ChatSessionStatus union type, HistoryMessage interface, markdown lint fixes, build scripts cleanup, arrow function style, stronger test assertions, URL-encoded session ID test
**Files touched:** server-chat-api.ts, server-chat-ui.ts, server-completions.ts, database.ts, types.ts, thread-list-adapter.ts, history-adapter.ts, App.tsx, useAxChatRuntime.tsx, package.json, 2 doc files, 3 test files
**Outcome:** Success — all 2493 tests pass
**Notes:** 9 pre-existing Playwright failures unrelated (missing @playwright/test in dashboard)

## [2026-03-20 19:35] — Update credential_request IPC handler to return availability status

**Task:** Implement Task 9 of web provider split plan: update credential_request IPC handler to check credential availability via resolveCredential
**What I did:** Modified the credential_request handler in src/host/ipc-handlers/skills.ts to import and call resolveCredential() after recording the request. The handler now resolves the credential using user scope (ctx.userId) then agent scope (ctx.agentId), returning `available: boolean` in the response alongside `ok: true`. Also includes the `available` field in the audit log args. Created tests covering: missing credential (available: false), agent-scope hit (available: true), user-scope hit (available: true), and requestedCredentials map tracking.
**Files touched:** src/host/ipc-handlers/skills.ts (modified), tests/host/ipc-handlers/skills-credential.test.ts (created)
**Outcome:** Success — all 4 tests pass, build compiles cleanly
**Notes:** IPCContext already had agentId and userId fields, so no type changes were needed. The resolveCredential function tries user:<agentName>:<userId> first, then agent:<agentName>.

## [2026-03-20 19:30] — Thread agentName/userId through credential lookup in server-completions.ts

**Task:** Implement Task 6 of web provider split plan: replace raw `providers.credentials.get()` calls in server-completions.ts with scoped `resolveCredential()` lookups
**What I did:** Imported `resolveCredential` and `credentialScope` from credential-scopes.ts. Replaced all three `providers.credentials.get()` calls (OAuth credential lookup, pre-agent env credential lookup, post-agent env credential lookup) with `resolveCredential(providers.credentials, envName, agentName, currentUserId)`. Also updated both `credential.required` event emissions to include `agentName` and `userId: currentUserId` in the data payload. Changed post-agent `let realValue` to `const realValue` since it's no longer reassigned.
**Files touched:** src/host/server-completions.ts (modified)
**Outcome:** Success — build compiles cleanly with no type errors
**Notes:** `agentName` and `currentUserId` were already defined earlier in the function (lines 394-395). The `credentialScope` import is unused directly in this file but included per plan spec.

## [2026-03-20 19:10] — Update credential provide HTTP endpoints and SSE events for scoped credentials

**Task:** Implement Tasks 7 and 8 of web provider split plan: update credential provide endpoints and SSE credential_required event to support agentName/userId scoping
**What I did:** Updated `/v1/credentials/provide` handler in server-request-handlers.ts and `/admin/api/credentials/provide` handler in server-admin.ts to accept agentName and userId fields. Both endpoints now store credentials at user scope (if userId+agentName provided) and agent scope (if agentName provided), with backward compat for unscoped global storage. Also updated the SSE credential_required event emission to include agentName and userId fields from the event data.
**Files touched:** src/host/server-request-handlers.ts (modified), src/host/server-admin.ts (modified)
**Outcome:** Success — build compiles cleanly
**Notes:** The credentialScope helper is dynamically imported to keep top-level imports clean. Both endpoints follow the same pattern: store at user scope first (most specific), then always at agent scope, with global fallback when no agentName is provided.

## [2026-03-20 18:54] — Create scoped credential resolution helper

**Task:** Implement Task 5 of web provider split plan: scoped credential resolution helper
**What I did:** Created `src/host/credential-scopes.ts` with `credentialScope()` and `resolveCredential()` functions. Credentials are scoped per-agent and per-user, with lookup order: user:agentName:userId -> agent:agentName. Created comprehensive tests covering user override, agent fallback, null return, and multi-user scenarios.
**Files touched:** src/host/credential-scopes.ts (new), tests/host/credential-scopes.test.ts (new)
**Outcome:** Success — all 7 tests pass
**Notes:** CredentialProvider.get() signature is `(service, scope?)` — scope is the second arg, not the first.

## [2026-03-20 00:40] — Fix skill installation credential detection

**Task:** Skill installation was broken — agent never called request_credential, host never detected new skill credentials
**What I did:**
1. Added `skill_download` IPC action — downloads ClawHub ZIP, extracts all files, returns requires.env
2. Removed `credential_request` gate — host now auto-scans skills after EVERY agent turn
3. Added ClawHub fallback — when SKILL.md lacks frontmatter, host queries ClawHub by slug to discover requires.env
4. Made SkillsModule always render (even with no skills) so agents get ClawHub install guidance
5. Extended credential scan to session/scratch workspace (not just agent/user)
6. Removed `config.web_proxy` gate on post-agent credential loop
**Files touched:** src/clawhub/registry-client.ts, src/ipc-schemas.ts, src/host/ipc-handlers/skills.ts, src/host/server-completions.ts, src/agent/tool-catalog.ts, src/agent/mcp-server.ts, src/agent/prompt/modules/skills.ts, + 5 test files
**Outcome:** Code correct, 2479 tests pass. E2E validation blocked by npm install hanging in sandbox (web_proxy not configured in kind cluster)
**Notes:** The LLM (Gemini Flash) doesn't reliably follow tool instructions — may not use skill.download or call request_credential. The ClawHub fallback + auto-scan addresses this by detecting credentials server-side.

## [2026-03-19 19:20] — Mid-request credential collection via event bus

**Task:** Allow agents to request credentials mid-request after installing a skill. Host collects them via SSE, then re-spawns agent.
**What I did:** Replaced in-memory promise map in credential-prompts.ts with event bus coordination. Added credential_request IPC schema/handler. Updated POST /v1/credentials/provide endpoints (server.ts, server-admin.ts) to emit via event bus. Updated oauth-skills.ts to use event bus. Added post-agent credential collection loop in processCompletion. Added request_credential action to skill tool catalog and MCP server. Updated skills prompt module with credential guidance.
**Files touched:** src/ipc-schemas.ts, src/host/credential-prompts.ts, src/host/server.ts, src/host/server-admin.ts, src/host/oauth-skills.ts, src/host/server-completions.ts, src/host/ipc-server.ts, src/host/ipc-handlers/skills.ts, src/host/host-process.ts, src/agent/tool-catalog.ts, src/agent/mcp-server.ts, src/agent/prompt/modules/skills.ts, tests/ipc-schemas-credential.test.ts, tests/host/credential-prompts.test.ts, tests/host/credential-provide-endpoint.test.ts, tests/host/oauth-skills.test.ts, tests/host/credential-request-integration.test.ts, tests/agent/tool-catalog-credential.test.ts, tests/agent/tool-catalog.test.ts
**Outcome:** Success — all 2471 tests pass, build compiles clean
**Notes:** Key design: credential-prompts.ts now subscribes to event bus per-request instead of maintaining in-memory promise map, eliminating session affinity requirement.

## [2026-03-19 14:10] — Skill OAuth credential support (PKCE flow, auto-refresh, SSE events)

**Task:** Add OAuth authentication support for skills so users can authenticate via browser redirect instead of pasting API keys
**What I did:** Implemented the full OAuth PKCE flow for skill credentials:
1. Extended `ParsedAgentSkill.requires` with `oauth: OAuthRequirement[]` type and parser in `skill-format-parser.ts`
2. Created `src/host/oauth-skills.ts` — PKCE flow initiation, callback resolution with token exchange, token refresh with auto-expiry, session cleanup
3. Updated credential resolution loop in `server-completions.ts` — OAuth credentials are resolved first (with auto-refresh), then falls back to plain env prompts; renamed `collectSkillEnvRequirements` → `collectSkillCredentialRequirements`
4. Added `GET /v1/oauth/callback/:provider` route in `server.ts` for browser redirect handling
5. Added `oauth.required` → `oauth_required` SSE event for web chat UIs
**Files touched:** `src/providers/skills/types.ts`, `src/utils/skill-format-parser.ts`, `src/host/oauth-skills.ts` (new), `src/host/server-completions.ts`, `src/host/server.ts`, `tests/host/collect-skill-env.test.ts`, `tests/host/oauth-skills.test.ts` (new), `tests/host/server-credentials-sse.test.ts`
**Outcome:** Success — 2467 tests pass, clean type-check
**Notes:** Reuses PKCE helpers from `oauth.ts` (Claude Max auth) and pending/resolve pattern from `credential-prompts.ts`. OAuth blobs are stored as JSON in the credential provider under `oauth:<name>` keys.

## [2026-03-18 12:15] — Fix opaque "fetch failed" errors in HTTP IPC client

**Task:** Make `ipc_llm_stream_error: fetch failed` errors actionable by extracting the real cause
**What I did:** The root problem was `HttpIPCClient.call()` doing a raw `fetch()` with zero error handling. Node.js `fetch()` throws opaque "fetch failed" errors — the real cause (ECONNREFUSED, ECONNRESET, ETIMEDOUT, DNS failure) is buried in the `.cause` chain. Fixed at two levels:
1. `HttpIPCClient.call()` — wrapped `fetch()` in try/catch that extracts `.cause.code` and `.cause.message`, re-throws with full context (action, URL, timeout, cause). Also added HTTP status error handling for non-2xx responses.
2. Both stream error handlers (`pi-session.ts` and `ipc-transport.ts`) — extract `.cause` from errors when logging to stderr `[diag]` lines and structured logs.
**Files touched:**
- `src/agent/http-ipc-client.ts` — Wrapped fetch() with cause extraction and HTTP status handling
- `src/agent/runners/pi-session.ts` — Extract .cause in ipc_llm_stream_error handler
- `src/agent/ipc-transport.ts` — Extract .cause in stream_error handler
**Outcome:** Success — all 2412 tests pass, clean build
**Notes:** Before: `[diag] ipc_llm_stream_error: fetch failed`. After: `[diag] ipc_llm_stream_error model=claude-sonnet-4-5-20250929 messages=18 duration=5000ms: IPC llm_call failed: fetch failed (ECONNRESET: read ECONNRESET) [url=http://ax-host.ax.svc/internal/ipc, timeout=600000ms]`

## [2026-03-18 12:00] — Improve logging detail across host and agent

**Task:** Add more context to log messages that were too terse to diagnose issues
**What I did:** Enhanced logging at 12+ log sites across host (server-completions, host-process, k8s sandbox) and agent (pi-session IPC model, tool execution). Added: timing data (duration for LLM calls, tool execution, prompt cycles, session completion, agent attempts), token usage (input/output counts), missing identifiers (sessionId, messageId, sender, pod phase), tool execution results (action, result length), and pod failure details (exit code, reason, last phase).
**Files touched:**
- `src/agent/runners/pi-session.ts` — Added timing + token usage to ipc_llm_result, tool_execute/tool_result, prompt/idle cycle; improved ipc_llm_stream_error with model context
- `src/host/server-completions.ts` — Added messageId + maxRetries to agent_failed, timing to agent_complete (was hardcoded durationSec:0)
- `src/host/host-process.ts` — Added sessionId + duration to session_completed, sender + sessionId to scheduler_message_processed
- `src/host/server.ts` — Added sender + sessionId to scheduler_message_processed
- `src/providers/sandbox/k8s.ts` — Added lastPhase + elapsed to pod_timeout, pod_failed log with exit reason
**Outcome:** Success — all 2412 tests pass, clean build
**Notes:** The structured logger sends full detail to ~/.ax/data/ax.log (always debug level); stderr [diag] lines now include timing and tokens for k8s observability

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
