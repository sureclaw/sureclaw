# Agent: Tools

Tool catalog consolidation, MCP server tools, tool definition generation, prompt module updates.

## [2026-03-31 10:00] — Add dedicated grep and glob tools to agent

**Task:** Add structured `grep` and `glob` tools to pi-coding-agent, replacing raw bash `rg`/`find` usage with context-window-safe alternatives
**What I did:** Full-stack implementation across 10 files:
- IPC schemas: `SandboxGrepSchema` and `SandboxGlobSchema` in ipc-schemas.ts, updated SandboxApprove/Result enums
- Tool catalog: two new singleton tools in `sandbox` category (tool-catalog.ts)
- Host handlers: `sandbox_grep` (spawns `rg` with streaming truncation) and `sandbox_glob` (spawns `rg --files --glob`) in sandbox-tools.ts
- Local sandbox: `grep()` and `glob()` methods with audit gate pattern in local-sandbox.ts
- IPC routing: two new switch cases in ipc-tools.ts
- MCP server: two new `tool()` definitions for claude-code runner in mcp-server.ts
- Prompt: tool-style.ts updated to guide agent to prefer grep/glob over bash
- Tests: 9 new handler tests (5 grep, 4 glob), updated tool counts in 4 test files (18→20)
**Files touched:** Modified: src/ipc-schemas.ts, src/agent/tool-catalog.ts, src/host/ipc-handlers/sandbox-tools.ts, src/agent/local-sandbox.ts, src/agent/ipc-tools.ts, src/agent/mcp-server.ts, src/agent/prompt/modules/tool-style.ts, tests/host/ipc-handlers/sandbox-tools.test.ts, tests/agent/ipc-tools.test.ts, tests/agent/tool-catalog.test.ts, tests/agent/mcp-server.test.ts, tests/sandbox-isolation.test.ts
**Outcome:** Success — all 2762 tests passing
**Notes:** Both tools use ripgrep (`rg`) as backend. Key feature is `max_results` (default 100) with `truncated` flag to protect context window. Tool counts went from 18 to 20 in 5 separate test files — lesson reinforced: tool count is hardcoded in many places.

## [2026-03-15 15:30] — Implement local sandbox execution (Tasks 1-11)

**Task:** Implement unified agent container architecture — agents execute tools locally with host audit gate
**What I did:** Added audit gate IPC schemas (sandbox_approve/sandbox_result), host-side audit gate handlers, agent-side local executor (local-sandbox.ts), workspace provisioning CLI, wired local sandbox into all three tool dispatch paths (ipc-tools, pi-session, claude-code/MCP), three-phase container orchestration, resource tiers for delegation, removed legacy providers (seatbelt/nsjail/bwrap), removed ephemeral container and NATS dispatch infrastructure, updated Dockerfile/CI/Helm, updated docs.
**Files touched:** ~40 files created/modified/deleted across src/agent/, src/host/, src/providers/, src/config.ts, src/ipc-schemas.ts, container/, charts/, flux/, .github/, docs/, README.md, and their tests
**Outcome:** Success — all 202 test files, 2396 tests passing. Build clean.
**Notes:** Three separate tool creation paths needed sandbox wiring (ipc-tools.ts, pi-session.ts, mcp-server.ts). The MCP server uses a ternary pattern while the others use switch statements. Tool-catalog-sync tests caught missing registrations immediately.

## [2026-03-14 12:00] — Restore workspace tool in agent catalog (lazy-sandbox Task 3)

**Task:** Add a `workspace` tool to the agent tool catalog so the LLM can write files to persistent workspace tiers (agent/user) without requiring a sandbox.
**What I did:** Added `'workspace'` to ToolCategory union, added workspace tool entry to TOOL_CATALOG with `Type.Union([write])` and `actionMap: { write: 'workspace_write' }`, added `'workspace'` case to `filterTools` gated on `hasWorkspaceScopes`, added matching MCP tool in `mcp-server.ts`, updated tool counts from 14 to 15 in 5 test files, added workspace tool test, removed `'workspace_write'` from knownInternalActions in sync test since it's now catalog-mapped.
**Files touched:** Modified: src/agent/tool-catalog.ts, src/agent/mcp-server.ts, tests/agent/tool-catalog.test.ts, tests/agent/tool-catalog-sync.test.ts, tests/agent/mcp-server.test.ts, tests/agent/ipc-tools.test.ts, tests/sandbox-isolation.test.ts
**Outcome:** Success — all 321 agent tests + 33 sandbox-isolation tests pass
**Notes:** Workspace tool uses `Type.Union([...])` even with one member for future extensibility. Category is `'workspace'` (distinct from `'workspace_scopes'`). Both gate on `ctx.hasWorkspaceScopes`.

## [2026-03-04 19:05] — Move bash/file tools from local to IPC (Phase 1, Task 3)

**Task:** Move bash, read_file, write_file, edit_file tools from local (in-process) execution to IPC routing through the host process, as groundwork for k8s sandbox pod dispatch.
**What I did:** Added 4 sandbox tools to TOOL_CATALOG (tool-catalog.ts), 4 Zod schemas (ipc-schemas.ts), created host-side IPC handlers (sandbox-tools.ts) with safePath containment, registered handlers in ipc-server.ts with shared workspaceMap, wired workspace registration/deregistration in server-completions.ts and server.ts, removed local-tools.ts (now unused), updated pi-session.ts to pass tools: [] (no built-in coding tools), added sandbox tools to mcp-server.ts, and updated all affected tests.
**Files touched:** Created: src/host/ipc-handlers/sandbox-tools.ts, tests/host/ipc-handlers/sandbox-tools.test.ts. Deleted: src/agent/local-tools.ts, tests/agent/local-tools.test.ts. Modified: src/agent/tool-catalog.ts, src/ipc-schemas.ts, src/host/ipc-server.ts, src/host/server-completions.ts, src/host/server.ts, src/agent/runners/pi-session.ts, src/agent/mcp-server.ts, tests/agent/tool-catalog.test.ts, tests/agent/ipc-tools.test.ts, tests/sandbox-isolation.test.ts, tests/agent/mcp-server.test.ts, tests/integration/cross-component.test.ts, tests/agent/runners/pi-session.test.ts
**Outcome:** Success — build passes, 2332/2335 tests pass (3 pre-existing failures in skills-install unrelated to this change)
**Notes:** Key design decision: shared workspaceMap (Map<string, string>) flows from server.ts to both completionDeps (register/deregister) and createIPCHandler (consume). The requestId used in processCompletion becomes sessionId in IPC context. Pi-session tests needed tool name updates (write -> write_file) and mock IPC servers for sandbox_write_file.

## [2026-02-28 22:30] — Update prompt modules with consolidated tool names

**Task:** Update 6 prompt modules in `src/agent/prompt/modules/` to reference new consolidated tool names instead of old individual IPC tool names
**What I did:** Updated tool name references in all 6 prompt module files:
- `memory-recall.ts`: `memory_query`/`memory_read`/`memory_write` -> `memory({ type: "query" })` etc.
- `skills.ts`: `skill_read`/`skill_propose` -> `skill({ type: "read" })` etc.
- `heartbeat.ts`: `scheduler_add_cron`/`scheduler_run_at`/`scheduler_remove_cron`/`scheduler_list_jobs` -> `scheduler({ type: "add_cron" })` etc.
- `delegation.ts`: `agent_delegate` -> `delegate`
- `runtime.ts`: `workspace_write`/`identity_propose`/`proposal_list` -> `workspace({ type: "write" })`/`governance({ type: "propose" })`/`governance({ type: "list_proposals" })`
- `identity.ts`: `identity_write`/`user_write` -> `identity({ type: "write" })`/`identity({ type: "user_write" })`
**Files touched:** `src/agent/prompt/modules/memory-recall.ts`, `src/agent/prompt/modules/skills.ts`, `src/agent/prompt/modules/heartbeat.ts`, `src/agent/prompt/modules/delegation.ts`, `src/agent/prompt/modules/runtime.ts`, `src/agent/prompt/modules/identity.ts`
**Outcome:** Success — all old tool names replaced with consolidated syntax
**Notes:** Found an additional `user_write` reference in `security.ts` line 45 that was not in the task scope. Left it for a follow-up since instructions said to only modify the 6 listed files.

## [2026-02-28 22:48] — Update all tests for consolidated tool names (Task 6)

**Task:** Update all test files in `tests/agent/` to match the 10-tool consolidated catalog
**What I did:** Updated 10 test files across the agent test suite:
- `tool-catalog.test.ts`: Count 28->10, updated expected names, param key tests for union schemas, category `'skills'->'skill'`, injectUserId on `identity` instead of `user_write`, filterTools assertions use consolidated names
- `tool-catalog-sync.test.ts`: MCP sync uses superset check for union params, prompt sync checks type values not old tool names, IPC schema sync checks actionMap/singletonAction values against IPC_SCHEMAS
- `ipc-tools.test.ts`: All tool references updated (memory/web/identity/scheduler/delegate/image), count 28->10, filter tests use consolidated names, multi-op dispatch tests use type param
- `mcp-server.test.ts`: All tool lookups use consolidated names, count 28->10, handler calls include type param
- `prompt/modules/heartbeat.test.ts`: `scheduler_add_cron` etc. -> check for `scheduler` + type values
- `prompt/modules/skills.test.ts`: `skill_read`/`skill_propose` -> check for `skill` + `read`/`propose`
- `prompt/modules/memory-recall.test.ts`: `memory_query`/`memory_write`/`memory_read` -> check for `memory` + type values
- `prompt/modules/identity.test.ts`: `identity_write`/`user_write` -> check for `identity` + type values
- `prompt/enterprise-runtime.test.ts`: `identity_propose`/`proposal_list` -> `governance` + `propose`/`list_proposals`
- `runners/pi-session.test.ts`: Updated tool name assertions and mock LLM tool_use payload to use consolidated names
**Files touched:** 10 files in `tests/agent/`
**Outcome:** Success — all 324 agent tests pass across 34 test files
**Notes:** IPC client tests (`ipc-client.test.ts`) and host tests were left untouched since they test transport/IPC actions which haven't changed.

## [2026-02-28 22:30] — Consolidate MCP server tools (28 -> 10)

**Task:** Rewrite the `allTools` array in `src/agent/mcp-server.ts` to replace 28 individual `tool()` calls with 10 consolidated ones, matching the tool catalog consolidation.
**What I did:**
- Replaced 28 individual Zod `tool()` calls with 10 consolidated tool definitions
- Multi-op tools use `z.enum()` for the `type` field with all operation-specific fields made optional
- Each multi-op handler strips undefined optional fields before dispatching: `Object.fromEntries(Object.entries(rest).filter(([_, v]) => v !== undefined))`
- Added `SCHEDULER_ACTIONS` and `GOVERNANCE_ACTIONS` lookup maps for irregular IPC action name mappings
- Identity tool handler includes origin normalization and userId injection for `user_write` operations
- Governance `propose` handler includes origin normalization
- Singleton tools (audit, delegate, image) pass args directly to their fixed IPC action
- `allowedNames` filtering unchanged -- still uses `filterTools().map(s => s.name)` which now returns the 10 consolidated names
**Files touched:** `src/agent/mcp-server.ts`
**Outcome:** Success — file compiles clean, no `mcp-server.ts` errors in `npx tsc --noEmit`
**Notes:** The Zod `tool()` helper takes a flat schema shape (not `z.object()`), so discriminated unions aren't usable. Instead, `type` is a `z.enum()` and all operation-specific fields are `.optional()`. The handler strips undefineds before calling IPC.

## [2026-02-28 22:00] — Consolidate tool-catalog.ts from 28 tools to 10

**Task:** Rewrite `src/agent/tool-catalog.ts` to consolidate 28 separate ToolSpec entries into 10 consolidated tools using a `type` discriminator pattern for multi-op tools and `singletonAction` for single-op tools.
**What I did:**
- Replaced the entire `TOOL_CATALOG` array: 28 entries -> 10 entries (memory, web, identity, scheduler, skill, workspace, governance, audit, delegate, image)
- Added `actionMap` and `singletonAction` fields to the `ToolSpec` interface
- Changed `ToolCategory` from `'skills'` to `'skill'` (singular)
- Updated `filterTools()` to use `'skill'` instead of `'skills'`
- Updated `getToolParamKeys()` to handle TypeBox `Type.Union()` schemas (collects all keys across union members, excluding `type`)
- Added `timeoutMs: 600_000` to delegate tool and `timeoutMs: 120_000` to image tool
- Multi-op tools use `Type.Union([Type.Object({type: Type.Literal(...), ...}), ...])` pattern
- All 28 original IPC action names preserved in actionMap/singletonAction fields
**Files touched:** `src/agent/tool-catalog.ts`
**Outcome:** Success — TypeScript compiles clean (`npx tsc --noEmit` passes), all 28 IPC actions accounted for
**Notes:** The `actionMap` field maps `type` discriminator values to flat IPC action names (e.g. `{write: 'memory_write', query: 'memory_query'}`). Some mappings are irregular: scheduler `remove` -> `scheduler_remove_cron`, scheduler `list` -> `scheduler_list_jobs`, governance `propose` -> `identity_propose`.

## [2026-02-28 21:30] — Update pi-session.ts tool definition generation (Task 4)

**Task:** Update `createIPCToolDefinitions()` in pi-session.ts to use actionMap/singletonAction dispatch logic matching ipc-tools.ts
**What I did:** Rewrote the execute function body inside `createIPCToolDefinitions()` to:
- For multi-op tools (with `actionMap`): extract `type` from params, look up IPC action in `spec.actionMap[type]`, pass remaining params without `type`
- For singleton tools (with `singletonAction`): use `spec.singletonAction` as IPC action, pass all params
- For legacy tools (neither): fall back to `spec.name` as action
- Inject `userId` only when the resolved action is `user_write`
- Apply origin normalization when resolved action is in `TOOLS_WITH_ORIGIN` (now includes `identity_propose`)
- Apply file normalization when resolved action is `identity_write`
- Return error text if `type` value not found in `actionMap`
**Files touched:** `src/agent/runners/pi-session.ts`
**Outcome:** Success — `npm run build` compiles cleanly with zero errors
**Notes:** The dispatch logic now mirrors `ipc-tools.ts` — both resolve the IPC action name the same way before calling through to the host.

## [2026-02-26 14:00] — LLM tool call optimization: context-aware filtering

**Task:** Optimize LLM tool calls by adding context-aware filtering so only relevant tools are sent per session
**What I did:**
1. Added `ToolCategory` type and `category` field to `ToolSpec` — tagged all 25 tools across 9 categories (memory, web, audit, identity, scheduler, skills, delegation, workspace, governance)
2. Added `ToolFilterContext` interface and `filterTools()` function — excludes tools by category based on session flags (hasHeartbeat, hasSkills, hasWorkspaceTiers, hasGovernance)
3. Tightened verbose tool descriptions in TOOL_CATALOG and MCP server — reduced identity_write, user_write, skill_propose, agent_delegate, workspace/governance descriptions by 50-70%
4. Refactored `buildSystemPrompt()` to return `toolFilter` alongside `systemPrompt` — single derivation point for filter context
5. Wired filtering into all 3 tool consumers: ipc-tools.ts (pi-agent-core), pi-session.ts (pi-coding-agent), mcp-server.ts (claude-code)
6. Refactored claude-code.ts to use shared `buildSystemPrompt()` instead of manual PromptBuilder usage
7. Updated tests: fixed tool count assertions, added HEARTBEAT.md fixture to pi-session test, added filterTools test suite (12 tests), added filter tests to ipc-tools (3 tests) and mcp-server (2 tests), updated sandbox-isolation test
**Files touched:**
- Modified: src/agent/tool-catalog.ts, src/agent/ipc-tools.ts, src/agent/mcp-server.ts, src/agent/agent-setup.ts, src/agent/runner.ts, src/agent/runners/pi-session.ts, src/agent/runners/claude-code.ts
- Modified tests: tests/agent/tool-catalog.test.ts, tests/agent/ipc-tools.test.ts, tests/agent/mcp-server.test.ts, tests/agent/runners/pi-session.test.ts, tests/sandbox-isolation.test.ts
**Outcome:** Success — 151 test files, 1546 tests pass (1 skipped, pre-existing)
**Notes:** Without heartbeat/skills/enterprise, tool count drops from 25 to 11 per LLM call. Filter context aligns with prompt module shouldInclude() logic — if HeartbeatModule is excluded, scheduler tools are too. All existing sync tests still pass since they test against the unfiltered catalog.
