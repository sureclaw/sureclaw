# Agent: Runner

Agent runner implementations, process management, dev/production mode split.

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
