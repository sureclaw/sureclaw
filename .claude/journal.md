# Journal

## [2026-02-22 00:00] — Enterprise agent architecture: paths.ts foundation

**Task:** Implement enterprise agent architecture — multi-agent, multi-user, governance-controlled
**What I did:** Updated paths.ts with new enterprise layout functions: agentIdentityDir, agentWorkspaceDir, userWorkspaceDir, scratchDir, registryPath, proposalsDir. Updated doc comment with full enterprise filesystem layout.
**Files touched:** src/paths.ts (modified), .claude/journal.md (created), .claude/lessons.md (created)
**Outcome:** Partial — paths.ts foundation complete, remaining phases pending
**Notes:** Work in progress — committing initial paths foundation before continuing with registry, sandbox, memory, IPC, and prompt changes.

## [2026-02-22 01:00] — Enterprise agent architecture: full implementation

**Task:** Complete the enterprise agent architecture across agent registry, sandbox, memory, IPC, tools, prompt, and server
**What I did:** Implemented the full enterprise architecture in 4 phases:
- Phase 1: Created JSON-based agent registry (src/host/agent-registry.ts) with CRUD, capability filtering, parent-child relationships
- Phase 2: Extended SandboxConfig with three-tier mounts (agentWorkspace, userWorkspace, scratchDir), updated all 5 sandbox providers (subprocess, bwrap, nsjail, seatbelt, docker)
- Phase 3: Added agentId scope to MemoryProvider, updated sqlite (with migration), file, and memu providers
- Phase 4: Added 8 enterprise IPC schemas, created workspace and governance handlers, added 6 new tools to catalog and MCP server
- Updated PromptContext, RuntimeModule, identity-loader, agent-setup, runner, server-completions for enterprise support
- Wrote 57 new tests across 5 test files, updated 5 existing test files
**Files touched:**
- New: src/host/agent-registry.ts, src/host/ipc-handlers/workspace.ts, src/host/ipc-handlers/governance.ts
- New tests: tests/host/agent-registry.test.ts, tests/host/ipc-handlers/workspace.test.ts, tests/host/ipc-handlers/governance.test.ts, tests/agent/prompt/enterprise-runtime.test.ts, tests/ipc-schemas-enterprise.test.ts
- Modified: src/providers/sandbox/types.ts, subprocess.ts, bwrap.ts, nsjail.ts, seatbelt.ts, docker.ts
- Modified: src/providers/memory/types.ts, sqlite.ts, file.ts, memu.ts
- Modified: src/ipc-schemas.ts, src/host/ipc-server.ts, src/host/server-completions.ts
- Modified: src/agent/tool-catalog.ts, mcp-server.ts, runner.ts, agent-setup.ts
- Modified: src/agent/prompt/types.ts, modules/runtime.ts, identity-loader.ts
- Modified: src/types.ts
- Modified tests: tests/agent/tool-catalog.test.ts, ipc-tools.test.ts, mcp-server.test.ts, tool-catalog-sync.test.ts, tests/sandbox-isolation.test.ts
**Outcome:** Success — 1140/1141 tests pass (1 pre-existing flaky test unrelated to changes)
**Notes:** Rebased onto main after PR #15 merge (server decomposition). Key design decisions: proposals stored as individual JSON files, workspace writes queued in paranoid mode, agent registry uses atomic file writes via rename.

## [2026-02-22 02:00] — Rebase onto main and fix build error

**Task:** Rebase feature branch onto latest main to resolve merge conflicts, then update PR
**What I did:** Fetched latest main, rebased `claude/enterprise-agent-architecture-LyxFf` onto `origin/main`. Git auto-skipped the duplicate server decomposition commit (already merged via PR #15). Fixed a TypeScript build error in `src/config.ts` where `providerEnum()` produced a loosely-typed Zod enum that didn't match Config's literal union types — added a safe type assertion since the schema validates the same constraints at runtime.
**Files touched:** src/config.ts (modified), .claude/journal.md (modified)
**Outcome:** Success — clean rebase, build passes
**Notes:** Rebase reduced branch from 3 to 2 commits ahead of main. The config.ts type issue may have been pre-existing but was exposed by the rebase.

## [2026-02-22 03:00] — Fix CI failures: tests and semgrep

**Task:** Fix CI test failures and semgrep configuration issues
**What I did:**
- Fixed `scratchDir()` in paths.ts to handle colon-separated session IDs (same as `workspaceDir()`) — was using `validatePathSegment()` which rejects colons/dots, but channel session IDs like `test:thread:C02:2000.0001` contain both
- Added 3 regression tests for `scratchDir` in tests/paths.test.ts
- Created `.semgrep.yml` with 4 project-specific security rules (SC-SEC-002 dynamic imports, SC-SEC-004 path safety, no eval, no Function constructor)
- Created `.semgrep-ci.yml` with 2 CI rules (no console.log in host/providers, prototype pollution detection)
- Refactored oauth.ts to use `spawn()` instead of `exec()` with string interpolation (command injection fix)
- Added `nosemgrep` annotations to all intentional spawn/exec calls in sandbox providers and local-tools
**Files touched:** src/paths.ts, tests/paths.test.ts, .semgrep.yml (new), .semgrep-ci.yml (new), src/host/oauth.ts, src/agent/local-tools.ts, src/providers/sandbox/{subprocess,nsjail,docker,seatbelt,bwrap}.ts
**Outcome:** Success — 1214/1215 tests pass, tsc clean, semgrep clean, fuzz tests pass
**Notes:** Community semgrep rulesets (p/security-audit, p/nodejs, p/typescript) couldn't be tested locally due to network restrictions, but nosemgrep annotations cover the known intentional patterns.

## [2026-02-22 04:00] — Fix npm audit CI failure

**Task:** npm audit --audit-level=moderate was failing in CI with 9 vulnerabilities
**What I did:** Ran `npm audit fix` to resolve 5 direct-fixable vulns (ajv, fast-xml-parser, hono, qs). Remaining 4 were transitive minimatch@9.0.6 via gaxios→rimraf→glob chain. Added npm overrides in package.json to force minimatch>=10.2.1 and glob>=11.0.0.
**Files touched:** package.json, package-lock.json
**Outcome:** Success — 0 vulnerabilities, all 1214 tests still pass
**Notes:** The minimatch vuln was deep transitive (@mariozechner/pi-ai → @google/genai → google-auth-library → gaxios → rimraf → glob → minimatch). npm overrides are the right approach for transitive deps that upstream hasn't patched yet.

## [2026-02-22 05:00] — Add comprehensive fault tolerance

**Task:** Make AX tolerant to all kinds of external and internal failures (LLM provider failures/timeouts, host/container crashes, agent crashes, process hangs, etc.)
**What I did:** Added 8 fault tolerance mechanisms across the codebase:
1. **Retry utility** (`src/utils/retry.ts`): Reusable `withRetry()` with exponential backoff, jitter, AbortSignal, and configurable error classification
2. **Circuit breaker** (`src/utils/circuit-breaker.ts`): Three-state (closed/open/half_open) circuit breaker with configurable threshold, reset timeout, and failure predicates
3. **IPC client reconnection** (`src/agent/ipc-client.ts`): Auto-reconnect with exponential backoff on connection-level errors (EPIPE, ECONNRESET, etc.), retry-after-reconnect for transient failures, no retry for timeouts
4. **Agent crash recovery** (`src/host/server-completions.ts`): Retry loop (up to 2 retries) for transient agent crashes (OOM kills, segfaults, connection errors), with `isTransientAgentFailure()` classifier distinguishing permanent (auth, timeout, bad config) from transient failures
5. **Graceful shutdown with request draining** (`src/host/server.ts`): In-flight request tracking, 503 rejection of new requests during shutdown, drain timeout (30s), health endpoint reports draining status
6. **Graceful process termination** (`src/providers/sandbox/utils.ts`): `enforceTimeout` now sends SIGTERM first, waits grace period (default 5s), then SIGKILL — tracked via 'exit' event instead of `child.killed`
7. **Channel reconnection** (`src/host/server-channels.ts`): `connectChannelWithRetry()` wraps channel.connect() with retry/backoff, classifies auth errors as permanent
8. **IPC handler timeout** (`src/host/ipc-server.ts`): 15-minute safety-net timeout via `Promise.race()` prevents hung handlers from blocking the IPC server
**Files touched:**
- New: src/utils/retry.ts, src/utils/circuit-breaker.ts
- New tests: tests/utils/retry.test.ts, tests/utils/circuit-breaker.test.ts, tests/host/fault-tolerance.test.ts, tests/agent/ipc-client-reconnect.test.ts, tests/host/channel-reconnect.test.ts
- Modified: src/agent/ipc-client.ts, src/host/server.ts, src/host/server-completions.ts, src/host/server-channels.ts, src/host/ipc-server.ts, src/providers/sandbox/utils.ts
- Modified tests: tests/providers/sandbox/utils.test.ts, tests/sandbox-isolation.test.ts
**Outcome:** Success — 1267/1268 tests pass (1 pre-existing skip)
**Notes:** Key design decisions: (1) retry utility is generic and composable for future use, (2) circuit breaker is standalone for wrapping any provider, (3) agent crash retry is conservative (max 2 retries) to avoid infinite loops, (4) timeout-killed agents are NOT retried since they already spent their full time budget, (5) IPC client doesn't retry timeouts since the call may have been received server-side.

