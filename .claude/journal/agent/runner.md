# Agent: Runner

Agent runner implementations, process management, dev/production mode split.

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
