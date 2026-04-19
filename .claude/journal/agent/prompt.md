# Agent: Prompt

Prompt builder, identity module, bootstrap prompt fixes, delegation module, prompt optimizations.

## [2026-04-18 14:35] — Tool-modules Task 6: agent loads tool index from committed `.ax/tools/`

**Task:** Task 5 dropped the per-turn `toolModuleIndex` stdin payload. Task 6 re-adds the render block to the Runtime prompt module, but now sourced agent-side from the `_index.json` files that `syncToolModulesForSkill` commits to the workspace repo during skill approval / admin refresh.
**What I did:** TDD — wrote 10 failing tests in `tests/agent/prompt/tool-index-loader.test.ts` covering: empty index when workspace or `.ax/tools/` missing, single-skill render with camelCased names and `?`-marked optionals, multi-skill one-line-per-skill render, tool without `parameters` field, malformed-JSON skill skipped (others still load), missing `tools` field skipped, empty `tools[]` skipped, subdirs without `_index.json` ignored, property ordering preserved. Implemented `src/agent/prompt/tool-index-loader.ts` — `readdirSync` + explicit path joins (no glob lib), per-skill fail-open (log + skip), inline 3-line `snakeToCamel` duplicate to keep agent code free of host-layer imports. Added `toolModuleIndex?: string` back to `PromptContext`, re-added the render block to `runtime.ts` (under the `hasWorkspace` branch, only the new PTC block — no legacy CLI fallback; wording changed to "committed to git per skill" and "Read /workspace/.ax/tools/<skill>/index.js"). Wired `loadToolIndex(config.workspace)` into `buildSystemPrompt` in `agent-setup.ts`, passing `toolIndex.render || undefined` into the `PromptBuilder.build` context. Added 2 agent-setup integration tests exercising the full path end-to-end.
**Files touched:** src/agent/prompt/tool-index-loader.ts (new), tests/agent/prompt/tool-index-loader.test.ts (new), src/agent/prompt/types.ts (+1 field), src/agent/prompt/modules/runtime.ts (re-added render block), src/agent/agent-setup.ts (wired loader), tests/agent/agent-setup.test.ts (+2 integration tests)
**Outcome:** Success — `npm run build` clean, all 367 agent tests green (10 new loader tests + 2 new agent-setup tests + pre-existing 355). Pre-existing failures in `tests/host/server*.test.ts` + `tests/integration/smoke.test.ts` confirmed to also fail on `main` pre-change; unrelated.
**Notes:** Decisions on the 3 pre-flight questions: (1) Group by skill (matches `_index.json` shape — one JSON per skill, no per-tool server info to preserve). (2) Duplicate `snakeToCamel` (3 lines) rather than import from `src/host/toolgen/` — keeps agent-side loader free of host-layer cross-imports. (3) Confirmed: `_index.json.tools[].parameters` is the full `inputSchema` (`tool-module-sync.ts:97` writes `parameters: t.inputSchema`), so `parameters.properties` / `parameters.required` are used the same way `generateCompactIndex` used the schema.


## [2026-04-17 22:15] — Fix empty host skills_index masking filesystem-resident skills

**Task:** Even with the skill-creator seed file present at `.ax/skills/skill-creator/SKILL.md` in the user's agent workspace, the agent reported "no skills" when asked. The prompt's "Available skills" section rendered as empty, so the LLM never learned skill-creator was an option and went on improvising `execute_script` + npm install flows for Linear.
**Root cause:** `src/agent/agent-setup.ts:57` used `config.skills ?? fallbackScan()`. The host's `skills_index` IPC (`src/host/ipc-handlers/skills.ts:26`) returns `{ skills: [] }` whenever the reconciler state store is empty — which happens when the reconciler hasn't run (push hook no-op, host restart before rehydrate completes, existing agent whose repo predates a newly-added seed skill). An empty array is not nullish, so `??` kept it, and the filesystem-scan fallback never ran. The seeded `.ax/skills/skill-creator/SKILL.md` was invisible to the prompt.
**What I did:** Switched the guard to `config.skills?.length ? config.skills : fallbackScan()`. Empty array now triggers the scan, matching the intent ("use host data when present, fall back to filesystem otherwise"). Updated the sole test that codified the old short-circuit behavior (`tests/agent/agent-setup.test.ts:82`) — it now asserts the new fallback behavior by seeding a valid SKILL.md on disk and verifying it surfaces in the prompt when `config.skills: []`.
**Files touched:** `src/agent/agent-setup.ts`, `tests/agent/agent-setup.test.ts`
**Outcome:** Success — `npm run build` clean; `tests/agent/agent-setup.test.ts` 9/9 pass.
**Notes:** We also discussed a parallel fix — making `seedRemoteRepo` always run (not gated on `repoCreated`) so existing git-http agents backfill newly-added seed skills. User opted to destroy+recreate their agent manually for now; the seeding-always-runs change was reverted. Worth picking up as a follow-up when we add the next default seed skill.

## [2026-04-17 21:40] — Fix prompt misdirecting agent away from .ax/skills/ and skill-creator

**Task:** User's chat agent was asked for Linear tickets and responded by doing `ls /workspace/tools/` and looking for a pre-existing `/workspace/tools/linear.js` — totally missing the new skill-creator we seeded. Two prompt bugs surfaced.
**What I did:**
1. `runtime.ts:61` said `/workspace/skills/ — installed skills` — stale from the pre–phase 6/7 era. Skills actually land at `/workspace/.ax/skills/<name>/SKILL.md` (seeded by `seedAxDirectory` in `server-completions.ts`). Fixed the line to point at the real path and parameterize the name.
2. `runtime.ts:64` describing `/workspace/tools/` is accurate (MCP tool-wrapper modules written by `runner.ts:533`), but the phrasing "importable tool modules" invited the agent to hand-write files there. Clarified to "MCP tool wrapper modules (auto-generated; do NOT hand-write files here)".
3. `skills.ts:50-56` "Creating Skills" still said "commit and push" — contradicting the git-sidecar auto-commit model the user asked me to respect (and the sandbox pod can't even run git). Rewrote to: (a) point at the `skill-creator` seed skill as the starting trigger, (b) say the sidecar auto-commits at end-of-turn, (c) mention the admin approval gate, (d) warn that the proxy denies undeclared hostnames so ad-hoc `fetch()` won't work.
4. Updated 2 assertion strings in `tests/agent/prompt/modules/skills.test.ts` and `tests/agent/tool-catalog-sync.test.ts` that were pinned on the old wording (`commit and push`, `Creating Skills`).
**Files touched:** `src/agent/prompt/modules/runtime.ts`, `src/agent/prompt/modules/skills.ts`, `tests/agent/prompt/modules/skills.test.ts`, `tests/agent/tool-catalog-sync.test.ts`
**Outcome:** Success — `npm run build` clean; 122/122 prompt + tool-catalog-sync tests pass.
**Notes:** The prompt fix alone won't make the user's existing agent find skill-creator. Seeding only runs on `repoCreated=true` (`server-completions.ts:767`), so agents created before the skill-creator commit don't have it. User is going to test by destroying+recreating the agent for now; idempotent backfill-on-startup is the proper fix and is deferred.

## [2026-04-17 06:45] — Phase 3 PR #178 review fixes: SkillsModule render + git-native Creating Skills

**Task:** Address two CodeRabbit review comments on PR #178 and the sandbox-isolation test that broke when we added `skills?:` to `AgentConfig`.
**What I did:**
1. Guard `s.description` in `SkillsModule.render` — legacy/invalid rows can arrive without a description. Output now drops the trailing em dash cleanly when both prefix and description are empty, so no more `— undefined` leaking into the prompt.
2. Rewrote the "Creating Skills" section copy to the git-native flow: "write `SKILL.md` to `.ax/skills/<name>/SKILL.md` using your file-edit tools, then commit and push" (reconciler takes over). Replaces the legacy `skill({type:'create'}) → /workspace/skills/` guidance.
3. Tightened the brittle `tests/sandbox-isolation.test.ts::StdinPayload does not include skills field` check so it scans only the `StdinPayload` interface body (not the whole file) — AgentConfig legitimately carries `skills?:` as the host-supplied index.
4. Added `SkillsModule` test case for the undefined-description path (asserts no `undefined`, no trailing em dash, no extra whitespace).
5. Updated `tests/agent/tool-catalog-sync.test.ts::skill creation instructions` to assert the new `.ax/skills/` + commit-and-push copy and that `/workspace/skills/` is gone.
6. Updated `tests/agent/prompt/modules/skills.test.ts::includes skill creation instructions` similarly.

**Files touched:**
- src/agent/prompt/modules/skills.ts
- tests/agent/prompt/modules/skills.test.ts
- tests/agent/tool-catalog-sync.test.ts
- tests/sandbox-isolation.test.ts
- .claude/journal/agent/prompt.md

**Outcome:** Success — 632/632 affected tests pass, `npm run build` clean.
**Notes:** The `workspace/skills/` path referenced the pre-git-native `skill_create` IPC (still lives in `src/host/ipc-handlers/skills.ts` until phase 7 cleanup). Not deleting that handler in this PR — just fixing the prompt so the agent's default authoring flow is git-native.

## [2026-04-17 06:26] — Phase 3 Task 7: runner fetches skills_index before prompt build

**Task:** Git-native skills phase 3 Task 7 — wire the runner to fetch `skills_index` via IPC before building the system prompt, so the host-authoritative skill list (with `kind`, `pendingReasons`) wins over the workspace filesystem scan.
**What I did:**
1. Added `skills?: SkillSummary[]` to `AgentConfig` in `src/agent/runner.ts` (inline `import('./prompt/types.js')` type to avoid circular).
2. Rewrote the skill load in `src/agent/agent-setup.ts` `buildSystemPrompt` to `config.skills ?? (() => loadSkillsMultiDir(...))()` — still sync, still falls back to the filesystem scan when absent.
3. Added `fetchSkillsIndex(client)` helper in `agent-setup.ts`: calls `client.call({action:'skills_index'})`, returns `res.skills` on success, returns `undefined` on any throw/malformed shape (with a `logger.warn` on transport failure).
4. Wired both runners (`pi-session.ts`, `claude-code.ts`) to call `fetchSkillsIndex` right after `await client.connect()` (and guarded on `config.skills === undefined` so injected skills from tests win).
5. Added 7 new tests to `tests/agent/agent-setup.test.ts`: `buildSystemPrompt` short-circuits scan with `config.skills`, falls back to filesystem when undefined, empty-array skills short-circuits the scan, and 4 `fetchSkillsIndex` tests (success, throw, malformed, non-array).

**Files touched:**
- src/agent/runner.ts
- src/agent/agent-setup.ts
- src/agent/runners/pi-session.ts
- src/agent/runners/claude-code.ts
- tests/agent/agent-setup.test.ts

**Outcome:** Success. `npx vitest run tests/agent/agent-setup.test.ts` → 9/9 pass. `npx vitest run tests/agent/runners/` → 29/29 pass. `npx vitest run tests/agent/ tests/host/` → 1458 pass / 29 fail — identical to base (the 29 failing are pre-existing socket-path-too-long EINVAL failures in `tests/host/server.test.ts`, unchanged by this patch). `npm run build` clean.

**Notes:** The pi-session mock IPC server returns `{ok:true}` for unknown actions — that lands as a malformed response for `skills_index` and the helper correctly returns `undefined`, so the fallback filesystem scan runs. No mock updates needed. The listen-mode race I was asked to investigate is a non-issue: `applyPayload` runs `setContext` on the IPC client BEFORE dispatching into `run(config)`, so when the runner calls `fetchSkillsIndex` the session context is already applied.

## [2026-04-17 06:20] — Phase 3 Tasks 5+6: SkillSummary extension + SkillsModule bullet format

**Task:** Git-native skills phase 3 Tasks 5 (extend `SkillSummary`) + 6 (rewrite `SkillsModule.render` to design-doc bullet format).
**What I did:**
1. Extended `SkillSummary` in `src/agent/prompt/types.ts`: made `path` optional (host-indexed skills synthesize paths at render), added `kind?: 'enabled' | 'pending' | 'invalid'` and `pendingReasons?: string[]`.
2. Rewrote `SkillsModule.render()` in `src/agent/prompt/modules/skills.ts` to emit the design-doc bullet list (`- **name** — [(setup pending: ...) | (invalid) ]description`) with `kind ?? 'enabled'` defaulting legacy rows to enabled. Dropped the markdown table and the "Missing Dependencies" block; left warnings as a compat-bridge `(missing: ...)` parenthetical until phase 4 migrates them to `pendingReasons`.
3. Updated `renderMinimal` to reference `.ax/skills/<name>/SKILL.md` instead of "the skill path".
4. Rewrote skill render tests in `tests/agent/prompt/modules/skills.test.ts` (deleted table-format assertions, added 5 new tests: pending-with-reasons, invalid marker, legacy-no-kind, pending-no-reasons fallback, renderMinimal path reference).
5. Fixed two sibling-suite breaks: `tests/agent/prompt/builder.test.ts` matched the old "## Available Skills" title (updated to new "Available skills"); `tests/agent/tool-catalog-sync.test.ts` asserted `/workspace/skills/` in the no-workspace render (updated to set `hasWorkspace: true` + assert `.ax/skills/<name>/SKILL.md`). Also added `skills_index` to the known-internal IPC actions list (pre-existing failure from phase 3 Task 3 that my base commit inherited).

**Files touched:**
- src/agent/prompt/types.ts
- src/agent/prompt/modules/skills.ts
- tests/agent/prompt/modules/skills.test.ts
- tests/agent/prompt/builder.test.ts
- tests/agent/tool-catalog-sync.test.ts

**Outcome:** Success. `npx vitest run tests/agent/prompt/` → 130/130 pass. `npm run build` clean. Full suite: 33 pre-existing failures in host/server & integration/smoke (unchanged by this patch), 2 formerly-failing tool-catalog-sync tests now passing.

**Notes:** `path?` widening was low-risk — the only `.path` reader in src/ was `SkillsModule.render` itself; `loadSkills()`/`loadSkillsMultiDir()` still always set `path`. Runners keep using `loadSkillsMultiDir` until Task 7 wires the `skills_index` IPC call. The `(missing: ...)` compat bridge is deliberate and minimal — phase 4 will migrate it.

## [2026-03-31 12:00] — Add search tool guidance to ToolStyleModule

**Task:** Update ToolStyleModule to advise the agent to prefer grep/glob over bash for search and file discovery.
**What I did:** Added a new "Search" paragraph to `render()` after the "Errors" paragraph, instructing agents to prefer `grep` over `bash` + `rg`/`grep` for content search and `glob` over `bash` + `find`/`ls` for file discovery. Updated `renderMinimal()` to append "Use grep/glob instead of bash for search." to the compact guidance line.
**Files touched:** src/agent/prompt/modules/tool-style.ts
**Outcome:** Success — both render methods updated as specified.
**Notes:** Part of Task 7 (Tool Style Prompt Update). The guidance helps agents avoid flooding their context window with unbounded bash output.

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
