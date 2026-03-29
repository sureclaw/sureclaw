# Agent: Prompt

Prompt builder, identity module, bootstrap prompt fixes, delegation module, prompt optimizations.

## [2026-03-29 11:50] — Add CommandsModule for plugin slash commands

**Task:** Implement Task 10 of the Cowork plugin integration plan — create a commands prompt module to surface installed plugin slash commands.
**What I did:**
1. Added `commands` field to `PromptContext` interface in `types.ts`
2. Created `CommandsModule` in `src/agent/prompt/modules/commands.ts` (priority 72, optional, renders markdown table of commands)
3. Registered `CommandsModule` in `builder.ts` between skills (70) and delegation (75)
4. Created comprehensive test file `tests/agent/prompt/modules/commands.test.ts` (6 tests)
5. Verified integration test module count unaffected (commands field absent = shouldInclude returns false)
**Files touched:** src/agent/prompt/types.ts, src/agent/prompt/modules/commands.ts (new), src/agent/prompt/builder.ts, tests/agent/prompt/modules/commands.test.ts (new)
**Outcome:** Success — all 239 test files pass (2691 tests), including new commands tests.
**Notes:** Module is optional and only activates when `ctx.commands` is non-empty, so existing tests pass unchanged.

## [2026-03-26 07:00] — Credential flow investigation and skill prompt fixes

**Task:** Agent couldn't use Linear skill — made 10+ tool calls to find SKILL.md, then failed to use credentials
**What I did:**
1. Updated SkillsModule prompt to explicitly instruct `read_file` with concrete path examples, ban `workspace_read`/`bash`/`find`
2. Updated `request_credential` tool description with imperative "MUST stop" when `available: false`
3. Fixed `applyPayload()` in `runner.ts` to always overwrite credential env vars (defensive — placeholders rotate per-turn)
4. Improved credential pre-loading in `server-completions.ts`: removed `web_proxy` gate, added global scope
5. Verified via kind cluster: credential flow works e2e — pod has placeholder, proxy replaces it, API call reaches Linear
**Files touched:** src/agent/runner.ts, src/host/server-completions.ts, src/agent/prompt/modules/skills.ts, src/agent/tool-catalog.ts, tests/*, etc.
**Outcome:** Credential flow confirmed working. Root cause of original issue not conclusively identified — likely in the skill script content or `web_fetch` fallback (which bypasses MITM proxy, so no credential injection).
**Notes:** `web_fetch` IPC goes to host directly — no placeholder replacement. If agent falls back from bash to web_fetch, credentials won't work.

## [2026-03-22 07:18] — Conditionally show skill install instructions based on user message intent

**Task:** Make install instructions conditional in skills prompt module to prevent agent confusion between "use existing skill" and "install new one"
**What I did:** Added `detectSkillInstallIntent()` function in skills.ts with regex-based intent detection (install actions + skill nouns, inquiry patterns, clawhub refs). Added `skillInstallEnabled` field to PromptContext. Wired intent detection in agent-setup.ts from `config.userMessage`. Made install instructions conditional in render(). Simplified "Creating Skills" section. Updated renderMinimal() to remove install hint when no skills. Added 13 new tests for intent detection + conditional rendering.
**Files touched:** src/agent/prompt/modules/skills.ts, src/agent/prompt/types.ts, src/agent/agent-setup.ts, tests/agent/prompt/modules/skills.test.ts
**Outcome:** Success — all 2550 tests pass, build clean
**Notes:** Part of Task 3 (simplify agent skill tool and prompt). The SKILL_NOUNS regex is intentionally broad to catch varied user phrasing.

## [2026-03-15 19:33] — Fix Gemini sending "operation" instead of "type" for multi-op tools

**Task:** Agent hallucinates website content when asked to fetch URLs — tool call visible in logs but no IPC web_fetch call
**What I did:** Root-caused to Gemini Flash sending `{"operation":"fetch","url":"..."}` instead of `{"type":"fetch","url":"..."}` for the `web` multi-op tool. The pi-session executor destructures `type` which was `undefined`, so `actionMap[undefined]` → error → LLM hallucinates. Added `extractTypeDiscriminator()` normalizer in tool-catalog.ts that checks common aliases (operation, action, op, command, method). Updated pi-session.ts executor to use it. Added 8 regression tests.
**Files touched:** src/agent/tool-catalog.ts, src/agent/runners/pi-session.ts, tests/agent/tool-catalog.test.ts
**Outcome:** Success — all tests pass, build clean
**Notes:** Initial misdiagnosis: assumed agent wasn't calling the tool at all. Server logs revealed the tool call happened but with wrong param name. The tool description saying "Operations:" likely caused Gemini to name the field "operation". Already had normalizeOrigin/normalizeIdentityFile for similar Gemini issues — this is the same pattern at the discriminator level.

## [2026-03-02 11:03] — Fix /scratch path mismatch and remove redundant workspace.read/list

**Task:** Fix fictional paths in agent system prompt, remove stale ./workspace references, remove redundant workspace_read/workspace_list IPC operations
**What I did:** (1) Removed sanitizeWorkspacePath dead code from runtime.ts, replaced with static "Working Directory: ." label. (2) Replaced fictional /scratch, /agent, /user path literals with functional tier descriptions. (3) Removed workspace_read and workspace_list from: tool-catalog, IPC handlers, IPC schemas, MCP server, manifest generator, skill format parser. (4) Updated all corresponding tests across 5 test files.
**Files touched:** src/agent/prompt/modules/runtime.ts, src/agent/tool-catalog.ts, src/host/ipc-handlers/workspace.ts, src/ipc-schemas.ts, src/agent/mcp-server.ts, src/utils/manifest-generator.ts, src/utils/skill-format-parser.ts, tests/agent/prompt/modules/runtime.test.ts, tests/agent/prompt/enterprise-runtime.test.ts, tests/host/ipc-handlers/workspace.test.ts, tests/ipc-schemas-enterprise.test.ts, tests/e2e/scenarios/workspace-ops.test.ts
**Outcome:** Success — build passes, all 2004 tests pass, no stale references remain
**Notes:** Missed enterprise-runtime.test.ts on first pass — it had assertions on '### Workspace' heading and /agent, /user paths. Lesson: always grep for related test assertions before running.

## [2026-02-25 16:33] — Add minimal-context guidance to DelegationModule

**Task:** Tell the LLM to keep delegation context lean — no dumping SOUL.md or full conversation history
**What I did:** Added "Writing good delegation calls" section to DelegationModule explaining that sub-agents only see task+context, with explicit "Do NOT paste your entire SOUL.md, IDENTITY.md, or conversation history" guidance and good/bad examples. Added sync test assertion.
**Files touched:** src/agent/prompt/modules/delegation.ts, tests/agent/tool-catalog-sync.test.ts
**Outcome:** Success — all tests pass
**Notes:** Key insight: sub-agents go through processCompletion which rebuilds the full prompt (identity, security, etc.) from the child config. The parent doesn't need to re-inject any of that — just the task-specific context.

## [2026-02-25 16:28] — Add DelegationModule system prompt for agent_delegate

**Task:** Add system prompt guidance so the LLM knows when/how to use agent_delegate, and recommend claude-code for coding tasks
**What I did:**
1. Created `DelegationModule` prompt module (priority 75, optional) with runner selection table recommending claude-code for coding tasks
2. Registered it in builder.ts between SkillsModule (70) and HeartbeatModule (80)
3. Added sync test verifying agent_delegate and claude-code are mentioned in the module output
4. Updated integration test: module count 7→8, ordering check includes delegation, token breakdown check includes delegation
**Files touched:**
- New: src/agent/prompt/modules/delegation.ts
- Modified: src/agent/prompt/builder.ts, tests/agent/tool-catalog-sync.test.ts, tests/agent/prompt/integration.test.ts
**Outcome:** Success — 151/151 test files pass, 1518/1518 tests pass
**Notes:** Module includes a runner selection table, parameter reference, and graceful error handling guidance. renderMinimal() provides a compact 4-line version for tight budgets.

## [2026-02-25 19:00] — Research OpenClaw/Claude Code skills architecture

**Task:** Comprehensive research into how OpenClaw and Claude Code handle extensibility through skills, custom commands, hooks, plugins, and external script execution
**What I did:** Conducted extensive web research across 11+ search queries, fetched 3 official documentation pages (skills, hooks, plugins), and synthesized findings covering: SKILL.md manifest format, frontmatter specification, discovery/auto-invocation mechanisms, hook lifecycle events, plugin distribution system, security models (Claude Code sandboxing vs OpenClaw ClawHub vulnerabilities), Agent Skills open standard, and OpenClaw's ClawHavoc supply chain attack.
**Files touched:** .claude/journal.md (this entry)
**Outcome:** Success — comprehensive summary produced covering all 7 requested research areas
**Notes:** Key finding for AX: Claude Code's skill system is purely prompt-based (no code execution in the skill itself — scripts are run via Bash tool), while OpenClaw's ClawHub had catastrophic supply chain issues (341-1,184 malicious skills, 12-20% of registry). The Agent Skills open standard (agentskills.io) is cross-platform and worth tracking for AX compatibility. Claude Code's plugin system (.claude-plugin/plugin.json) handles distribution — something AX doesn't have yet.

## [2026-02-23 11:00] — Copy OpenClaw prompt optimizations into AX

**Task:** Adopt OpenClaw's key prompt optimizations: progressive skill disclosure, memory recall, tool call narration, SILENT_REPLY, identity file cap, minimal renders, concise wording, and workspace templates.
**What I did:**
1. **Skills progressive disclosure**: Changed `SkillSummary` type (name+description+path) replacing `string[]`. Updated `loadSkills()` to extract H1 title + first paragraph. Rewrote `SkillsModule` to render compact table + `skill_read` instructions. Added `renderMinimal()`.
2. **Memory recall module** (new, priority 60): Teaches agent to search memory before answering about prior work.
3. **Tool style module** (new, priority 12): OpenClaw-style narration rules.
4. **SILENT_REPLY**: Added to reply-gate and heartbeat modules.
5. **Security renderMinimal()**: Compact 5-line version.
6. **Identity file cap**: 65536 char limit with logger warning.
7. **Cache-stable time**: Rounds minutes to nearest 5, zeroes seconds.
8. **Injection defense wording**: Tightened attack recognition section.
9. **Template files**: Rewrote AGENTS.md and BOOTSTRAP.md, created SOUL.md, IDENTITY.md, USER.md, TOOLS.md from OpenClaw templates.
**Files touched:** 12 source files modified/created, 6 template files modified/created, 9 test files modified/created
**Outcome:** Success — zero type errors, 312 tests pass (2 pre-existing timeout failures in unrelated tests)
**Notes:** Biggest optimization is progressive skill disclosure: ~24 tokens per skill instead of potentially thousands. Module count went from 7 to 9.

## [2026-02-22 19:20] — Fix bootstrap: include tool guidance and user context

**Task:** Bootstrap only creates IDENTITY.md (not SOUL.md), and agent doesn't remember user's name
**What I did:** Root cause: during bootstrap mode, the identity module returned ONLY the BOOTSTRAP.md content — no evolution guidance (tool usage instructions) and no user context (USER.md / USER_BOOTSTRAP.md). The agent didn't know HOW to use identity_write vs user_write, and couldn't see previously written user observations. Fixed by including evolution guidance and user context sections during bootstrap mode.
**Files touched:** src/agent/prompt/modules/identity.ts, tests/agent/prompt/modules/identity.test.ts
**Outcome:** Success — 84/84 prompt tests pass, 15/15 identity module tests pass
**Notes:** The BOOTSTRAP.md template mentions "use your identity tools to write SOUL.md, IDENTITY.md, USER.md" but doesn't explain the tool API. The evolution guidance section explains identity_write (for SOUL.md/IDENTITY.md) vs user_write (for per-user USER.md). Without this, the agent was guessing from tool schemas alone and often only wrote one file.
