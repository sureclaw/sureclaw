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

