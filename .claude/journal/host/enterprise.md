# Host: Enterprise Architecture

Enterprise agent architecture: multi-agent, multi-user, governance, registry, workspace tiers.

## [2026-03-14 12:00] — Add workspace_write IPC handler

**Task:** Implement workspace_write IPC handler for sandbox-free file writes to workspace tiers
**What I did:** Added workspace_write handler to createWorkspaceHandlers in workspace.ts. The handler auto-mounts the requested tier, uses safePath() for traversal protection, creates nested directories as needed, writes the file, and audits the operation. Created comprehensive test suite with 6 tests covering basic writes, nested dirs, audit logging, mount failure, path traversal protection, and user tier writes.
**Files touched:** src/host/ipc-handlers/workspace.ts (modified), tests/host/ipc-handlers/workspace.test.ts (created)
**Outcome:** Success — all 6 new tests pass, all 50 IPC server tests still pass
**Notes:** Schema was already added in Task 1 (WorkspaceWriteSchema). Handler is automatically wired into createIPCHandler via the existing spread of createWorkspaceHandlers.

## [2026-03-13 08:40] — Phase 1B: Host loads identity/skills from DB, sends via stdin

**Task:** Modify server-completions.ts to load identity and skills from DocumentStore instead of filesystem, include in stdin payload sent to agent.
**What I did:**
- Added loadIdentityFromDB() and loadSkillsFromDB() helpers to server-completions.ts
- Added extractSkillMeta() (exported) for skill name/description extraction from content
- Replaced mergeSkillsOverlay() call with DB-based loading
- Replaced USER_BOOTSTRAP.md filesystem read with DB-based identity loading
- Added identity and skills fields to stdin payload JSON
- Removed `skills` field from SandboxConfig interface
- Removed skills symlink, AX_SKILLS env var, and mergeSkillsOverlay() from canonical-paths.ts
- Updated all 6 sandbox providers (subprocess, seatbelt, docker, bwrap, nsjail, k8s)
- Updated tests: canonical-paths, sandbox-isolation, subprocess, k8s
- Added new test file: server-completions-db.test.ts (6 tests for extractSkillMeta)
**Files touched:** src/host/server-completions.ts, src/providers/sandbox/types.ts, src/providers/sandbox/canonical-paths.ts, src/providers/sandbox/{subprocess,seatbelt,docker,bwrap,nsjail,k8s}.ts, tests/providers/sandbox/{canonical-paths,k8s,subprocess}.test.ts, tests/sandbox-isolation.test.ts, tests/host/server-completions-db.test.ts
**Outcome:** Success — build passes, 206 test files / 2391 tests pass
**Notes:** AgentConfig on agent-side still has skills field — that's Phase 1C (Task 3). Seatbelt still passes SKILLS=/dev/null for seatbelt policy compatibility.

## [2026-02-22 02:00] — Rebase onto main and fix build error

**Task:** Rebase feature branch onto latest main to resolve merge conflicts, then update PR
**What I did:** Fetched latest main, rebased `claude/enterprise-agent-architecture-LyxFf` onto `origin/main`. Git auto-skipped the duplicate server decomposition commit (already merged via PR #15). Fixed a TypeScript build error in `src/config.ts` where `providerEnum()` produced a loosely-typed Zod enum that didn't match Config's literal union types — added a safe type assertion since the schema validates the same constraints at runtime.
**Files touched:** src/config.ts (modified), .claude/journal.md (modified)
**Outcome:** Success — clean rebase, build passes
**Notes:** Rebase reduced branch from 3 to 2 commits ahead of main. The config.ts type issue may have been pre-existing but was exposed by the rebase.

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

## [2026-02-22 00:00] — Enterprise agent architecture: paths.ts foundation

**Task:** Implement enterprise agent architecture — multi-agent, multi-user, governance-controlled
**What I did:** Updated paths.ts with new enterprise layout functions: agentIdentityDir, agentWorkspaceDir, userWorkspaceDir, scratchDir, registryPath, proposalsDir. Updated doc comment with full enterprise filesystem layout.
**Files touched:** src/paths.ts (modified), .claude/journal.md (created), .claude/lessons.md (created)
**Outcome:** Partial — paths.ts foundation complete, remaining phases pending
**Notes:** Work in progress — committing initial paths foundation before continuing with registry, sandbox, memory, IPC, and prompt changes.
