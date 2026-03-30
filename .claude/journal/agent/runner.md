# Agent: Runner

Agent runner implementations, process management, dev/production mode split.

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
