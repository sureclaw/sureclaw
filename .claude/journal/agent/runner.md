# Agent: Runner

Agent runner implementations, process management, dev/production mode split.

## [2026-04-22 10:00] — Extend `reqId` binding to hot-path runners (`pi-session`, `claude-code`)

**Task:** Code-review fix for the prior Task 2 entry. The previous fix bound `reqId` only on `runner.ts`'s top-level logger, but the bulk of agent-execution chatter is emitted from `runners/pi-session.ts` and `runners/claude-code.ts`, each of which had their own `getLogger().child({ component: ... })` with no reqId. So `grep <reqId>` lit up the dispatcher and stopped — missing the actual chat turn.
**What I did:** Applied the same env-bound binding pattern from `runner.ts:15-22` at module load in both runner files: read `process.env.AX_REQUEST_ID?.slice(-8)` once and (if present) build the `logger` as `getLogger().child({ component, reqId })`, else the bare `{ component }`. No call-site changes. Extended `tests/agent/runner-correlation.test.ts` with a third test case that imports both runner modules with `AX_REQUEST_ID` set, drives one log emit through each (`runPiSession({userMessage:''})` -> `skip_empty`; `runClaudeCode({userMessage:'force log emit'})` -> `missing_proxy_socket` with stubbed exit), and asserts every `component: 'pi-session'` and `component: 'claude-code'` entry carries `reqId`.
**Files touched:** `src/agent/runners/pi-session.ts`, `src/agent/runners/claude-code.ts`, `tests/agent/runner-correlation.test.ts`
**Outcome:** Success — new test case passes alongside the existing two; agent + sandbox suites still green; build clean.
**Notes:** Same env-read-at-import trade-off as `runner.ts` — sandbox provider sets `AX_REQUEST_ID` before node imports the module. If the env-read pattern ever needs to change (e.g. centralize via a `getLogger()` helper), all three call sites move together.

## [2026-04-22 09:45] — Bind `reqId` on runner's top-level logger from `AX_REQUEST_ID`

**Task:** Task 2 of the chat-correlation-id plan — propagate the chat turn's correlation ID through the sandbox env and into the agent runner's logger so a single `grep <reqId>` reconstructs the chain across host -> sandbox provider -> agent runner.
**What I did:** At runner.ts module load, read `process.env.AX_REQUEST_ID?.slice(-8)` and (if present) initialize the top-level `logger` as a child with `{ component: 'runner', reqId }` instead of the bare `{ component: 'runner' }`. No call-site changes — every existing `logger.*` call now carries `reqId` automatically. Plumbed `AX_REQUEST_ID` from `SandboxConfig.requestId` into the container env in all three sandbox providers (k8s.ts pod env list, docker.ts/-e flags, apple.ts /-e flags). TDD test (`tests/agent/runner-correlation.test.ts`) drives `run()` with an invalid agent type to trigger `unknown_agent` log, then asserts every `component: 'runner'` JSON entry has `reqId === requestId.slice(-8)`. Negative case verifies `reqId` is omitted when `AX_REQUEST_ID` unset. Updated `.claude/skills/ax-agent/SKILL.md` (gotcha bullet) and `.claude/skills/ax-provider-sandbox/SKILL.md` (env var section) to document the propagation.
**Files touched:** `src/agent/runner.ts`, `src/providers/sandbox/k8s.ts`, `src/providers/sandbox/docker.ts`, `src/providers/sandbox/apple.ts`, `tests/agent/runner-correlation.test.ts` (new), `.claude/skills/ax-agent/SKILL.md`, `.claude/skills/ax-provider-sandbox/SKILL.md`
**Outcome:** Success — new test (2 cases) passes; full agent + sandbox suites (51 files, 455 tests) green; `npm run build` clean. Same pre-existing macOS Unix-socket-path failures in `tests/host/server*.test.ts` and `tests/integration/smoke*.test.ts` (33 cases) reproduce on baseline — unrelated to this change.
**Notes:** No `subprocess.ts` provider exists in this tree (only docker/apple/k8s) — skipped per plan instructions. Used vi.resetModules() in the test's beforeEach so runner.ts re-evaluates its top-level logger init against the freshly init'd singleton + current env. Stubbed `process.exit` in the test so the dispatch error path doesn't terminate vitest.

## [2026-04-18 14:30] — Remove orphaned imports in runner.ts (Task 5 follow-up)

**Task:** Code reviewer flagged 4 named imports with zero remaining usages after Task 5's deletion of per-turn tool-module generation: `mkdirSync`, `rmSync` from `node:fs`, and `dirname`, `resolve` from `node:path`. TypeScript didn't catch them because `noUnusedLocals` is off. Violated CLAUDE.md "no dead code."
**What I did:** Word-bounded grep confirmed all 4 appeared only on their import lines (11–12); remaining names (writeFileSync, readFileSync, existsSync, readdirSync, join) all had real call sites. Narrowed import statements to only the in-use names. `npm run build` clean; all 355 tests in tests/agent/ pass. Amended commit afbce180 in place.
**Files touched:** src/agent/runner.ts
**Outcome:** Success — import block now reflects actual usage; dead-code invariant restored for this file.
**Notes:** `noUnusedLocals` is still off in tsconfig.json — broader hygiene work, out of Task 5 scope.

## [2026-04-18 11:58] — Move `/workspace/tools/` → `/workspace/.ax/tools/`

**Task:** Auto-generated MCP tool modules were polluting the user's workspace root alongside user-authored content. Move them under `.ax/` so all AX-managed artifacts live in one directory.
**What I did:** (1) runner writes tool modules to `resolve(config.workspace, '.ax', 'tools')` instead of `'tools'`. (2) Prompt runtime module + tool-catalog + mcp-server descriptions all reference the new path. (3) `seedAxDirectory` now writes a tiny `.ax/.gitignore` with `tools/` so the auto-generated modules never end up committed (they're regenerated every turn). (4) Local-sandbox test updated to assert on the new path. User-authored `.ax/skills/` stays committed; auto-generated `.ax/tools/` stays ignored — the distinction is load-bearing.
**Files touched:** src/agent/runner.ts, src/agent/prompt/modules/runtime.ts, src/agent/tool-catalog.ts, src/agent/mcp-server.ts, src/host/server-completions.ts, tests/agent/local-sandbox.test.ts
**Outcome:** Success — `npm run build` clean, 495/495 targeted tests pass across tests/agent + tests/host/skills + tests/host/server-completions* + tests/host/server-admin-skills.

## [2026-04-01 01:20] — Fix multipart message display in chat history

**Task:** User messages with file/image attachments displayed as raw JSON in chat history (e.g., `[{"type":"text","text":"Describe..."}]`) instead of clean text.
**What I did:**
- Root-caused to three layers: (1) history API returned raw serialized content strings, (2) history adapter wrapped all content as a single text part, (3) UserMessage component had no Image part renderer
- Fixed `server-chat-api.ts` to use `deserializeContent()` when returning history, so `ContentBlock[]` arrays are returned as structured JSON instead of stringified JSON
- Fixed `history-adapter.ts` to handle both string and array content, mapping AX block types (`image_data` → `image`, `file_data` → `file`) to assistant-ui part types
- Added `UserImagePart` component and `Image` slot to `UserMessage`'s `MessagePrimitive.Parts`
**Files touched:** src/host/server-chat-api.ts, ui/chat/src/lib/history-adapter.ts, ui/chat/src/components/thread.tsx
**Outcome:** Success — user messages with attachments now render as clean text in history, all 2792 tests pass
**Notes:** `image_data`/`file_data` blocks are intentionally stripped by `serializeContent()` before storage (to avoid storing large base64 data in DB), so only text parts survive in history. The Image part renderer is for future cases where images might be stored (e.g., via URLs).

## [2026-04-01 01:10] — Fix image attachments dropped by pi-session runner and proxy-stream

**Task:** Image attachments (PNG, JPEG) uploaded via chat UI were silently dropped by the agent. The agent responded "I cannot see the image" despite the host correctly resolving the image to `image_data` content blocks.
**What I did:**
- Root-caused to pi-session.ts only extracting `file_data` blocks (for PDFs) but not `image_data` blocks (for images) from `rawMsg` — the same pattern as the PDF fix but for images
- Fixed pi-session.ts to filter `b.type === 'file_data' || b.type === 'image_data'` when extracting media blocks
- Fixed proxy-stream.ts `fileBlocksToAnthropicDocs()` to also handle `image_data` → Anthropic `image` blocks with `base64` source
- Added 2 tests for image_data injection in stream-utils tests
- Rebuilt Docker image, loaded into kind, verified via Playwright
**Files touched:** src/agent/runners/pi-session.ts, src/agent/proxy-stream.ts, tests/agent/stream-utils.test.ts
**Outcome:** Success — agent correctly described screenshot content, all 2792 tests pass
**Notes:** claude-code runner already handled both `image_data` and `file_data` (line 108) — this was only missing in pi-session runner and proxy-stream. Same pattern as the PDF fix: each runner/path must handle ALL ContentBlock media types.

## [2026-04-01 00:54] — Fix PDF file attachments dropped by OpenAI-compat LLM provider

**Task:** PDF file attachments were still not being summarized by the agent despite runner-side fixes. Debugging via k8s cluster + Playwright showed the agent received `file_data` blocks and injected them into IPC messages, but the LLM responded as if no PDF was attached.
**What I did:**
- Root-caused to `toOpenAIMessages()` in `src/providers/llm/openai.ts` — the OpenAI-compatible provider (used by OpenRouter/Gemini) only extracted `text` blocks, silently dropping `image_data` and `file_data`
- Added multipart content handling for user messages: `image_data` → `image_url` with data URI, `file_data` → OpenAI `file` content part with `file_data` data URI
- Verified end-to-end via Playwright: chat UI → file upload → agent → LLM → PDF summary response
**Files touched:** src/providers/llm/openai.ts
**Outcome:** Success — all 2790 tests pass, PDF summarization works in k8s cluster via browser
**Notes:** The Anthropic provider already handled `file_data` via `toAnthropicContent()`, but the deployed config used `openrouter/google/gemini-3-flash-preview` which routes through the OpenAI-compat provider. Two separate debugging red herrings: (1) stale Vite proxy from worktree returning 500, (2) sandbox pods using old Docker image without runner fixes.

## [2026-03-31 18:31] — Fix PDF file attachments not reaching LLM in pi-session/claude-code runners

**Task:** PDF file attachments uploaded via chat UI were silently dropped by agent runners. Markdown files worked because the server converts them to `text` blocks, but PDFs became `file_data` blocks which runners discarded.
**What I did:**
- Added `file_data` block extraction in pi-session and claude-code runners
- Created `injectFileBlocks()` helper in stream-utils.ts to inject file content into user messages
- Updated proxy-stream.ts to convert `file_data` → Anthropic `document` blocks for direct SDK calls
- Updated `buildSDKPrompt()` in claude-code runner to handle `file_data` alongside `image_data`
- Fixed frontend `ax-chat-transport.ts` to send array content when non-text parts exist (was dropping file-only attachments)
- Added 9 tests for new functionality
**Files touched:** src/agent/runners/pi-session.ts, src/agent/runners/claude-code.ts, src/agent/proxy-stream.ts, src/agent/stream-utils.ts, src/ipc-schemas.ts, ui/chat/src/lib/ax-chat-transport.ts, tests/agent/stream-utils.test.ts, tests/agent/runners/claude-code.test.ts, tests/ipc-schemas.test.ts
**Outcome:** Success — all 2789 tests pass including new tests
**Notes:** Three issues: (1) runners dropped `file_data` blocks, (2) IPC Zod schema for `contentBlock` was missing `file_data` variant causing strict validation rejection, (3) frontend condition dropped file-only attachments. The proxy path needed explicit conversion to Anthropic `document` format.

## [2026-03-30 13:45] — Fix MCP tool stubs for HTTP IPC (k8s mode)

**Task:** Fix "get all linear issues in this cycle" prompt making 40+ tool calls. Tool stubs in `./agent/tools/` couldn't execute because they only supported Unix socket IPC, but k8s uses HTTP IPC.
**What I did:** Three-part fix:
1. `codegen.ts` — Updated `_runtime.ts` template to auto-detect transport: uses `AX_HOST_URL` → HTTP fetch to `/internal/ipc`, or falls back to Unix socket IPC. Both paths use the `tool_batch` action.
2. `codegen.ts` — Changed import extensions from `.js` to `.ts` so `node --experimental-strip-types` can resolve them.
3. `runtime.ts` (prompt) — Added explicit instructions: use `node --experimental-strip-types script.ts` to execute, with example import path.
4. `ipc-schemas.ts` — Increased `tools` array max 50→200 and description limit 2000→10000.
**Files touched:** src/host/capnweb/codegen.ts, src/agent/prompt/modules/runtime.ts, src/ipc-schemas.ts
**Outcome:** Success — LLM now discovers stubs, writes a script, executes it via bash. Queries return real Linear data. Tool call count varies (6-17 depending on LLM iteration) vs 40+ before (all failing).
**Notes:** Must clear `tool-stubs` cache in DB after changing runtime template (schema hash doesn't include template changes). First attempt (registering MCP tools as first-class LLM tools) was wrong — stubs exist to save tokens by keeping 43 tool schemas out of every LLM turn.

## [2026-03-29 21:30] — Add skill_create with user-scoped skills

**Task:** Allow users to create, test, and debug personal skills (/workspace/user/skills/) before an admin promotes them to agent scope. The skill_create tool auto-detects scope: non-admin users in DM/web get user-scoped, admins get agent-scoped.
**What I did:** Added user-scoped skill support across the full stack:
- DB: Added `scope`/`userId` fields to SkillRecord, user-scoped key format `{agentId}/users/{userId}/{slug}`, `listUserSkills()` function
- IPC: Added `skill_create` schema and handler with admin/scope auto-detection
- Tool catalog + MCP server: Added `create` action type
- Host payload: Loads user skills separately, sends as `userSkills` field
- Agent runner: Writes `userSkills` to userWorkspace/skills/
- Prompt: Updated skill creation guidance to reference the tool
**Files touched:** `src/providers/storage/skills.ts`, `src/ipc-schemas.ts`, `src/host/ipc-handlers/skills.ts`, `src/agent/tool-catalog.ts`, `src/agent/mcp-server.ts`, `src/host/server-completions.ts`, `src/agent/runner.ts`, `src/agent/prompt/modules/skills.ts`
**Outcome:** Success — build passes, all existing tests pass (265/265 storage+IPC)

## [2026-03-29 21:00] — Fix skills and tools sandbox paths

**Task:** Skills and tools were being written to wrong locations in the sandbox. Skills went to userWorkspace/skills/ but should go to agentWorkspace/skills/ (agent-level, installed via plugins/admin). Tools went to AX_WORKSPACE/tools/ (read-only root in k8s) instead of agentWorkspace/tools/.
**What I did:** Updated applyPayload() in runner.ts to write DB-loaded skills to config.agentWorkspace/skills/ and tool stubs to config.agentWorkspace/tools/. Updated doc comments in runner.ts, generate-and-cache.ts, and canonical-paths.ts.
**Files touched:** `src/agent/runner.ts`, `src/host/capnweb/generate-and-cache.ts`, `src/providers/sandbox/canonical-paths.ts`
**Outcome:** Success — build passes, sandbox layout now: agent skills at /workspace/agent/skills/, user skills at /workspace/user/skills/, tools at /workspace/agent/tools/
**Notes:** In k8s (emptyDir), /workspace/agent is writable. In Docker, agentWorkspace mount is ro by default — may need follow-up to ensure agent can write skills/tools at bootstrap.

## [2026-03-25 21:00] — Fix session pod work-fetch token rotation bug

**Task:** Chat UI gets stuck on "Thinking..." after 3 turns against kind-ax cluster
**What I did:** Diagnosed that `HttpIPCClient.fetchWork()` used `this.token` which got overwritten by `setContext()` on each turn's `applyPayload()`. After turn 2, the token changed from the original pod auth token to a per-turn IPC token that the session-pod-manager doesn't recognize. Added a separate `readonly authToken` field initialized once from `AX_IPC_TOKEN` env, used exclusively by `fetchWork()`.
**Files touched:** `src/agent/http-ipc-client.ts` (fix), `tests/agent/http-ipc-client.test.ts` (regression test)
**Outcome:** Success — verified 5+ consecutive turns work in the chat UI against kind-ax cluster
**Notes:** Sandbox pods use the Docker image, not host volume mounts for dist/. Must rebuild image and `kind load docker-image ghcr.io/project-ax/ax:latest --name ax` for sandbox code changes.

## [2026-03-19 09:24] — Review PR 106 skill auto-install runner changes

**Task:** Perform a code review of PR #106 adding automatic skill dependency installation in agent runners
**What I did:** Fetched the PR into a separate worktree, reviewed the runner and installer diff in context, traced workspace/session behavior through server-completions and prompt modules, and identified concrete security and behavior regressions.
**Files touched:** .claude/journal/agent/runner.md, .claude/journal/agent/index.md
**Outcome:** Success — found three review findings: unscreened auto-execution from user-writable skill files, wrong install prefix selection for non-DM sessions, and missing proxy env wiring in the claude-code runner.
**Notes:** The review used the PR worktree at /tmp/ax-pr106 so findings could reference exact changed lines without disturbing the main checkout.

## [2026-03-19 08:20] — Add skill dependency installer

**Task:** Auto-install skill-declared package manager dependencies (npm, pip, cargo, go, uv) into persistent workspace directories
**What I did:** Fixed pip install to use --user flag for PYTHONUSERBASE compat. Created `src/agent/skill-installer.ts` that reads SKILL.md files from workspace skill dirs, parses install specs via parseAgentSkill(), checks binExists() for each declared binary, and runs missing installs with prefix env vars redirecting output to workspace paths. Wired into both pi-session and claude-code runners after web proxy bridge setup (so HTTP_PROXY is available for downloads) and before agent loop starts. Added 7 tests covering skip-existing, install-missing, OS filtering, directory-based skills, error resilience, no-install skills, and missing dirs.
**Files touched:** src/utils/skill-format-parser.ts, tests/utils/skill-format-parser.test.ts, src/agent/skill-installer.ts, tests/agent/skill-installer.test.ts, src/agent/runners/pi-session.ts, src/agent/runners/claude-code.ts
**Outcome:** Success — all 2405 tests pass
**Notes:** Uses execFileSync('/bin/sh', ['-c', cmd]) rather than execSync to make shell invocation explicit. Install commands come from screened SKILL.md files. The existing web proxy provides network access — no sandbox changes needed.

## [2026-03-16 15:00] — Runner NATS work subscription mode (replace stdin)

**Task:** In NATS/k8s mode, runner subscribes to agent.work.{POD_NAME} for work instead of reading stdin
**What I did:** Added `waitForNATSWork()` function that connects to NATS, subscribes to `agent.work.{POD_NAME}` with max=1, returns the work payload as string. Extracted `applyPayload()` helper to deduplicate stdin/NATS payload parsing. Restructured main block: NATS mode uses waitForNATSWork(), subprocess mode still uses readStdin(). Also modified agent-setup.ts to accept buffer array for text buffering (instead of stdout), and both runners (pi-session, claude-code) to send buffered text via `agent_response` IPC call in NATS mode.
**Files touched:** src/agent/runner.ts, src/agent/agent-setup.ts, src/agent/runners/pi-session.ts, src/agent/runners/claude-code.ts
**Outcome:** Success — all tests pass
**Notes:** The waitForNATSWork uses `{ max: 1 }` subscription — one message per pod lifetime. After receiving work, the runner processes it and exits. This makes runner.js itself the warm pool standby process.

## [2026-03-16 10:00] — Add NATS IPC transport support in runner.ts

**Task:** Support AX_IPC_TRANSPORT=nats env var in runner.ts so k8s pods can use NATSIPCClient instead of IPCClient
**What I did:**
- Added `IIPCClient` interface to runner.ts that both IPCClient and NATSIPCClient satisfy (call, connect, setContext)
- Changed `AgentConfig.ipcClient` type from `IPCClient` to `IIPCClient`
- Updated `compactHistory` param type from `IPCClient` to `IIPCClient`
- Relaxed `parseArgs()` validation: when `AX_IPC_TRANSPORT=nats`, `ipcSocket` is not required (only workspace)
- Added three-way branch in `if (isMain)` block: NATS mode (dynamic import + connect), listen mode (Apple Container), default (runners create their own)
- NATS client uses top-level `await` (ESM) for `import()` and `connect()`, session context set later via `setContext()` after stdin parse
**Files touched:** `src/agent/runner.ts`
**Outcome:** Success — all 359 agent tests pass (1 pre-existing failure unrelated: macOS /private/var symlink)
**Notes:** NATSIPCClient is dynamically imported to avoid pulling in nats dependency in non-k8s environments

## [2026-03-14 10:15] — Fix: Apple Container sandbox_bash "No workspace registered" error

**Task:** Debug "No workspace registered for session" error in sandbox_bash IPC handler when using Apple Container sandbox
**What I did:**
- Traced IPC flow: workspace registered with `requestId` but looked up by `effectiveCtx.sessionId`
- Found root cause: In Apple Container listen mode, IPCClient is created BEFORE stdin is parsed (to start listener early), so it has no sessionId. Since `config.ipcClient` is already set, runners skip creating a new client with sessionId. Agent never sends `_sessionId` in IPC messages.
- Added `setContext()` method to IPCClient for post-construction session context updates
- Called `setContext()` in runner.ts after stdin parsing to inject sessionId/userId/sessionScope into the early client
- Added test verifying `_sessionId` is sent after `setContext()` is applied to a listen-mode client
**Files touched:** `src/agent/ipc-client.ts`, `src/agent/runner.ts`, `tests/agent/ipc-client.test.ts`
**Outcome:** Success — all 2395 tests pass, build clean
**Notes:** This bug only affects Apple Container sandbox (the only sandbox with `bridgeSocketPath`). Subprocess and seatbelt sandboxes connect directly to the IPC server and use `defaultCtx`, so the lookup path is different.

## [2026-03-13 09:00] — Phase 1C: Agent reads identity/skills from stdin payload

**Task:** Modify agent-side code to read identity and skills from the stdin payload (sent by the host) instead of from the filesystem.
**What I did:**
- Updated `StdinPayload` and `AgentConfig` in runner.ts: added `identity` (IdentityFiles) and `skills` (SkillPayload[]), removed `userBootstrapContent` and `skills: string`
- Updated `parseStdinPayload` to parse identity and skills objects from JSON
- Updated `parseArgs` to stop reading `AX_SKILLS` env var
- Updated `identity-loader.ts` to accept `preloaded` identity data (skips filesystem reads)
- Updated `agent-setup.ts` to use payload skills/identity directly, with filesystem fallback
- Updated all tests (dispatch, runner, identity-loader) to match new types
**Files touched:** src/agent/runner.ts, src/agent/identity-loader.ts, src/agent/agent-setup.ts, tests/agent/runner.test.ts, tests/agent/runners/dispatch.test.ts, tests/agent/identity-loader.test.ts
**Outcome:** Success — TypeScript compiles, all 2394 tests pass (206 test files)
**Notes:** `loadSkills()` in stream-utils.ts kept for backward compat but no longer called when payload skills are available. `AX_AGENT_DIR` env var still read for filesystem fallback.

## [2026-02-27 12:30] — Remove pi-agent-core as a user-facing agent type

**Task:** Collapse pi-agent-core and pi-coding-agent into a single agent type, retire runPiCore(), make pi-coding-agent the default
**What I did:** Removed pi-agent-core from all AgentType unions (types.ts, config.ts, runner.ts, onboarding/prompts.ts, ipc-schemas.ts, mcp-server.ts). Deleted runPiCore() (~100 lines) from runner.ts. Updated dispatch to only have pi-coding-agent and claude-code. Changed all profile defaults from pi-agent-core to pi-coding-agent. Updated delegation prompt module. Fixed agent-registry default. Updated ~50 test files. Left @mariozechner/pi-agent-core npm dep intact (still used for type imports: AgentMessage, AgentTool, StreamFn).
**Files touched:** src/types.ts, src/config.ts, src/ipc-schemas.ts, src/agent/runner.ts, src/agent/agent-setup.ts, src/agent/proxy-stream.ts, src/agent/ipc-transport.ts, src/agent/tool-catalog.ts, src/agent/mcp-server.ts, src/agent/prompt/modules/delegation.ts, src/onboarding/prompts.ts, src/host/server-completions.ts, src/host/agent-registry.ts, 20+ test files
**Outcome:** Success — clean TypeScript build, 167/167 test files pass, 1721/1722 tests (1 skipped macOS seatbelt)
**Notes:** The npm package @mariozechner/pi-agent-core is still a direct dependency for type imports (AgentMessage, AgentTool, StreamFn). These types are not re-exported by pi-coding-agent. A follow-up could re-export them from a local barrel file and drop the direct dep.

## [2026-02-27 09:35] — Dev/production mode split for agent runner

**Task:** Use .ts source (via tsx ESM loader) during development but compiled dist/*.js in production.
**What I did:** Added `DEV_MODE` detection in assets.ts using `import.meta.url.endsWith('.ts')`. When host runs via tsx, `runnerPath()` returns `src/agent/runner.ts` and the spawn command includes `--import <tsx-esm-loader>`. When host runs from dist/, `runnerPath()` returns `dist/agent/runner.js` with no tsx dependency. Also added `tsxLoader()` (absolute path to tsx ESM loader) and `isDevMode()` exports.
**Files touched:** src/utils/assets.ts, src/host/server-completions.ts
**Outcome:** Success — all 1729 tests pass. Dev mode gets hot-reload-like behavior, production gets zero tsx overhead.
**Notes:** The tsx ESM loader path must be absolute (not just `tsx/esm`) because agents run with cwd=workspace which has no node_modules.

## [2026-02-27 09:00] — Fix agent delegation EPERM crash / retry loop

**Task:** Diagnose and fix cascading failures when agents delegate to subagents — EPERM crashes, invalid retries, and orphaned processes.
**What I did:** Root-caused the issue through the full process chain: enforceTimeout → SIGTERM → tsx signal relay → EPERM → exit code 1 → retry loop. Implemented 5 fixes: (1) EPERM error pattern in diagnosis, (2) try/catch in enforceTimeout kill calls, (3) accept valid output despite non-zero exit, (4) classify kill EPERM as permanent failure, (5) eliminate tsx binary wrapper entirely — replaced `tsx runner.ts` with `node --import tsx/esm runner.ts` to run in a single process.
**Files touched:** src/errors.ts, src/host/server-completions.ts, src/providers/sandbox/utils.ts, src/utils/assets.ts, src/providers/sandbox/bwrap.ts, tests/errors.test.ts, tests/host/fault-tolerance.test.ts, tests/providers/sandbox/utils.test.ts
**Outcome:** Success — all 1729 tests pass. Root cause was tsx binary creating an extra process layer with a broken macOS signal relay.
**Notes:** The tsx binary wrapper (spawns cross-spawn child with inherited stdio) was the fundamental issue. Its `relaySignalToChild` has no error handling, so EPERM from macOS kernel causes unhandled exception → exit code 1, while the actual Node.js agent process becomes an orphan. Using `--import tsx/esm` eliminates the wrapper entirely.
