# Tool Modules as Git-Native Artifacts Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Move MCP tool-module generation from per-turn (current, auto-regenerated, now gitignored) to per-skill-approval (committed to git under `.ax/tools/<skill>/`). Fix the conceptual inconsistency that `.ax/skills/` is git-authoritative but `.ax/tools/` is ephemeral. Single source of truth — git.

**Architecture:** At skill approval time, the host discovers the skill's MCP server tool set, wraps each tool into an ES module, and commits the files into the agent's workspace repo under `.ax/tools/<skill>/`. The agent reads committed modules at turn start — no regeneration, no stdin-payload module-writing, no per-turn MCP discovery. An admin "refresh tools" action regenerates on demand (e.g., after an MCP server upgrade adds new tools).

**Tech Stack:** TypeScript, Kysely, git via `execFile` (use project's `execFileNoThrow` helper at `src/utils/execFileNoThrow.ts`), existing `toolgen/generate-and-cache.ts` helpers, existing `resolveMcpAuthHeaders` helper (from `server-completions.ts`, added in fix 1).

---

## Context

This plan is a follow-up to the just-completed **skills single-source-of-truth migration** (8 commits from `dc6cabba`..`bbb563ce` on `main`). Related commits to study before starting:

- `e27ee7b1` — fix(skills): MCP authForServer reads skill_credentials (added `resolveMcpAuthHeaders` helper)
- `56adaab5` — refactor(agent): move /workspace/tools/ → /workspace/.ax/tools/ (renamed path, added `.ax/.gitignore` with `tools/` entry — we UNDO the gitignore in this plan)
- `bbb563ce` — step 8 of the SSOT migration

**Why this matters:**
- Current per-turn flow: `server-completions.ts:1264-1332` runs `deps.mcpManager.discoverAllTools(agentId, ...)` → `prepareToolModules` → writes module files via the stdin payload → `runner.ts:533-565` unpacks them into `.ax/tools/`. Every turn. Gitignored.
- This violates the migration's thesis: git should be the single source of truth.
- It was the root cause of the step-8 regression we just patched (`authForServer` read the wrong credential table and silently returned zero tools → agent saw empty `.ax/tools/` and improvised).
- Linear's tool signatures don't change between turns. Regenerating ~8 files per turn to get identical content is wasted work.

**Design decisions already made** (don't re-litigate):

1. **Commit path:** Host writes modules directly into the workspace's canonical git repo. For `git-local`, write to the bare repo at `axHome/repos/<agentId>`. For `git-http`, push from the local mirror (already set up for fetch in `server.ts::getBareRepoPath`) to the canonical URL.
2. **Directory structure:** `.ax/tools/<skill-name>/<tool-name>.js` nested per skill. Plus `.ax/tools/<skill-name>/_index.json` listing exports. Clean deletion by skill-name on skill removal.
3. **Prompt index:** agent reads `.ax/tools/*/_index.json` files at turn start (filesystem scan, agent-side). No more `toolModuleIndex` in stdin payload.
4. **Regeneration triggers:** (a) admin skill approval via Approvals page, (b) explicit "refresh tools" admin action per-skill, (c) NOT on drift detection (out of scope — stretch item at end).
5. **Drift:** if the MCP server's tool set changes between approval + turn time, committed modules are stale. Mitigation: admin refresh button. No auto-regenerate-on-drift in v1.
6. **Credential resolution:** reuse `resolveMcpAuthHeaders` from `server-completions.ts` — don't re-invent.
7. **Commit messages:** `ax: regenerate tools for <skill>` (on approval) or `ax: refresh tools for <skill>` (on explicit refresh). Author: a synthetic `AX Host <host@ax>` identity, same as identity commits.

**Files that will shrink substantially:**
- `src/host/server-completions.ts:1264-1332` — entire MCP tool-gen block deletes.
- `src/agent/runner.ts:533-565` — module-writing + toolModuleIndex handling deletes.
- `src/agent/runner.ts` StdinPayload + AgentConfig — `toolModuleIndex?` field deletes.

**Files that grow:**
- New `src/host/skills/tool-module-sync.ts` — the approval-time generate-and-commit helper.
- New `src/agent/prompt/tool-index-loader.ts` — agent-side filesystem scan of `.ax/tools/*/_index.json`.

---

## Task 1: Extend workspace provider with `commitFiles` primitive

**Files:**
- Modify: `src/providers/workspace/types.ts` — add `commitFiles` method to `WorkspaceProvider` interface.
- Modify: `src/providers/workspace/git-local.ts` — implement for bare-repo-local deployments.
- Modify: `src/providers/workspace/git-http.ts` — implement for bare-repo-over-HTTP deployments.
- Modify: `src/providers/workspace/git-ssh.ts` — implement if this provider is still alive (grep first).
- Test: `tests/providers/workspace/commit-files.test.ts` — new.

**Step 1: Add to the interface**

```ts
// In WorkspaceProvider interface:
/** Commit a set of files into the agent's repo on refs/heads/main. Idempotent:
 *  re-committing identical content is a no-op. Files are an array of
 *  { path: string (repo-relative), content: Buffer | string }. Deleting a
 *  file means an entry with content === null (or use a separate `deletePaths`
 *  list — pick the simpler shape). */
commitFiles(agentId: string, input: {
  files: Array<{ path: string; content: Buffer | string | null }>;
  message: string;
  author?: { name: string; email: string };
}): Promise<{ commit: string; changed: boolean }>;
```

**Step 2: Implement for `git-local`**

The canonical bare repo is at `axHome/repos/<agentId>`. Use git plumbing commands via the project's safe `execFileNoThrow` helper:
1. `git read-tree refs/heads/main` to start from current state (or empty tree on first commit).
2. For each file: `git hash-object -w --stdin` (pipe content); `git update-index --add --cacheinfo 100644,<sha>,<path>` (or `--remove` for deletion).
3. `git write-tree` → new tree sha.
4. `git commit-tree <tree-sha> -p <parent> -m <msg>` with `GIT_AUTHOR_NAME`/`GIT_AUTHOR_EMAIL` env vars.
5. `git update-ref refs/heads/main <new-commit> <parent>` (atomic — fails if parent moved).

Idempotency: after step 3, if the tree sha matches the parent's tree, return `{ commit: parent, changed: false }` and skip 4-5.

**Step 3: Implement for `git-http`**

Use the existing local mirror at `axHome/repos/<agentId>` (set up by `server.ts::getBareRepoPath`). Do steps 1-5 from git-local on the mirror, then `git push origin refs/heads/main`. The push failing with "non-fast-forward" means another writer beat us — either retry with fresh fetch or surface the error (v1: surface).

**Step 4: Write tests**

Real SQLite + tempdir-backed git repo. Cases: initial commit to empty repo, subsequent commit updates file, identical re-commit is idempotent, delete path removes file, simultaneous commits conflict detection (git-http only if straightforward).

**Step 5: Commit**

```
feat(workspace): add commitFiles primitive for host-initiated commits
```

---

## Task 2: Tool-module generator helper

**Files:**
- Create: `src/host/skills/tool-module-sync.ts`
- Test: `tests/host/skills/tool-module-sync.test.ts`

**Step 1: Function signature**

```ts
export interface ToolModuleSyncDeps {
  mcpManager: McpConnectionManager;
  skillCredStore: SkillCredStore;
  workspace: WorkspaceProvider;
}

export interface ToolModuleSyncInput {
  agentId: string;
  skillName: string;
  mcpServers: Array<{ name: string; url: string; credential?: string }>;
  userId: string;  // for per-user credential resolution
}

export interface ToolModuleSyncResult {
  commit: string;
  changed: boolean;
  moduleCount: number;
  toolCount: number;
}

export async function syncToolModulesForSkill(
  deps: ToolModuleSyncDeps,
  input: ToolModuleSyncInput,
): Promise<ToolModuleSyncResult>;
```

**Step 2: Implementation outline**

1. For each MCP server in `input.mcpServers`, ask `mcpManager` to discover tools (use `resolveMcpAuthHeaders` from `server-completions.ts` — extract it to its own file first if needed, see Task 3).
2. Filter tools to only those from THIS skill's declared servers.
3. Call existing `prepareToolModules({ agentName: agentId, tools })` from `toolgen/generate-and-cache.ts` to get the file contents.
4. Rewrite paths from flat `<tool>.js` to nested `.ax/tools/<skillName>/<tool>.js`.
5. Add `_index.json` at `.ax/tools/<skillName>/_index.json` with `{ skill: <skillName>, tools: [{ name, description, parameters? }], generated_at: <iso> }`.
6. Call `deps.workspace.commitFiles(agentId, { files, message: 'ax: regenerate tools for <skillName>', author: { name: 'AX Host', email: 'host@ax' } })`.
7. Return `{ commit, changed, moduleCount: files.length - 1, toolCount: tools.length }`.

**Step 3: Tests**

Fixture: fake `mcpManager` returning a known tool set, in-memory `skillCredStore` with a matching cred, fake `workspace.commitFiles` that records calls. Assert the committed file paths + content shape.

**Step 4: Commit**

```
feat(skills): tool-module-sync helper (generates + commits per skill)
```

---

## Task 3: Hook `syncToolModulesForSkill` into `approveSkillSetup`

**Files:**
- Modify: `src/host/server-admin-skills-helpers.ts`
- Modify: `src/host/server-admin.ts` (thread deps into route)
- Modify: `src/host/server-init.ts` (construct syncToolModules deps)
- Test: `tests/host/server-admin-skills.test.ts` (extend)

**Step 1: Add `syncToolModules` to `ApproveDeps`**

```ts
export interface ApproveDeps {
  // ... existing ...
  syncToolModules: (input: ToolModuleSyncInput) => Promise<ToolModuleSyncResult>;
}
```

**Step 2: Call after credential + domain writes, before cache invalidation**

In `approveSkillSetup` after the dual-writes succeed and before `snapshotCache.invalidateAgent`:
```ts
// Look up the skill's declared MCP servers from the live snapshot.
const skills = await getAgentSkills(body.agentId, deps.agentSkillsDeps);
const state = skills.find(s => s.name === body.skillName);
if (state?.kind === 'enabled') {
  const snapshot = await loadSnapshot(body.agentId, deps.agentSkillsDeps);
  const entry = snapshot.find(e => e.ok && e.name === body.skillName);
  if (entry?.ok && entry.frontmatter.mcpServers.length > 0) {
    await deps.syncToolModules({
      agentId: body.agentId,
      skillName: body.skillName,
      mcpServers: entry.frontmatter.mcpServers,
      userId,
    });
  }
}
```

Error handling: if `syncToolModules` throws, LOG but don't fail the approval — the skill is already approved, the tools just aren't ready. Admin can retry via refresh button (Task 4). Include the error in the audit log.

**Step 3: Wire into composition root**

`server-init.ts` constructs a `syncToolModules` closure bound to the actual deps and threads it through `AdminDeps`.

**Step 4: Tests**

Extend the approve handler test to assert that after a successful approval of a skill with MCP servers, `syncToolModules` is called with the right inputs. Stub the implementation.

**Step 5: Commit**

```
feat(skills): generate tool modules on approval
```

---

## Task 4: Admin refresh-tools endpoint + UI button

**Files:**
- Modify: `src/host/server-admin.ts` (new route)
- Modify: `ui/admin/src/components/pages/agents-page.tsx` (Skills tab — add Refresh button per enabled skill)
- Modify: `ui/admin/src/lib/api.ts` (add `refreshTools` method)
- Modify: `ui/admin/src/lib/types.ts` (response type)
- Test: `tests/host/server-admin-refresh-tools.test.ts` (new)
- Test: `ui/admin/tests/agent-tabs.spec.ts` (extend with refresh-button test)

**Step 1: New route**

```
POST /admin/api/agents/:agentId/skills/:skillName/refresh-tools
```

Body: empty. Response: `{ ok: true, commit, moduleCount, toolCount }` or 404 if skill not enabled, 500 on sync error (which IS surfaced here, unlike the approval path).

Implementation: look up skill via `getAgentSkills`, find matching snapshot entry, call `syncToolModules` directly.

**Step 2: UI**

On the per-agent Skills tab, each enabled-skill card gains a "Refresh tools" button. On click → POST → show success/failure toast → no page reload needed (the committed files take effect on next turn).

**Step 3: Commit**

```
feat(admin): refresh-tools endpoint + UI button
```

---

## Task 5: Delete per-turn tool generation

**Files:**
- Modify: `src/host/server-completions.ts` — delete lines ~1264-1332 (the entire MCP tool-gen block + `toolModuleIndex` + `mcpCLIsPayload` if unused).
- Modify: `src/host/server-completions.ts` — drop `toolModuleIndex` from the stdin payload.
- Modify: `src/agent/runner.ts` — drop `StdinPayload.toolModuleIndex`, `StdinPayload.mcpCLIs` (if only tool-module-related), `AgentConfig.toolModuleIndex`, and the module-writing block at lines 533-565.
- Modify: `src/agent/agent-setup.ts` — drop `toolModuleIndex` from `buildSystemPrompt`'s config spread.
- Modify: `src/agent/prompt/types.ts` — drop `toolModuleIndex` from context.
- Modify: `src/agent/prompt/modules/runtime.ts` — stop reading `ctx.toolModuleIndex`; see Task 6 for the replacement.
- Delete: `src/host/toolgen/generate-and-cache.ts` if only used by deleted paths (check via grep — may still be called by Task 2's sync helper, in which case keep).
- Update tests that expected `toolModuleIndex` on stdin payload / AgentConfig.

**Step 1: Grep for all references**

```bash
rg 'toolModuleIndex|mcpCLIsPayload|prepareToolModules|prepareMcpCLIs' src/ tests/
```

Map each to: delete / move to Task 2's helper / keep (only the generator path).

**Step 2: Delete per-turn MCP generation**

The block at `server-completions.ts:1264-1332` — the `if (deps.mcpManager) { ... } else if (providers.mcp && providers.mcp.listTools) { ... }` — goes away entirely. Both the new manager path AND the deprecated legacy path, since neither is needed post-cutover.

**Step 3: Drop stdin-payload field**

`StdinPayload.toolModuleIndex` removed. `parseStdinPayload` no longer extracts it. `applyPayload` no longer sets `config.toolModuleIndex`.

**Step 4: Drop module-writing in runner.ts**

Lines 533-565 go. Now `.ax/tools/` exists in the workspace because it was cloned from git at workspace init, not because the runner wrote files.

**Step 5: Tests**

Delete `tests/host/server-completions-skills-payload.test.ts` if its only purpose was verifying the dropped payload (unlikely — that was for the `skills` field). If it asserted `toolModuleIndex` specifically, strip just those assertions.

**Step 6: Commit**

```
refactor(agent): remove per-turn tool-module generation
```

---

## Task 6: Agent reads committed tool index at turn start

**Files:**
- Create: `src/agent/prompt/tool-index-loader.ts`
- Modify: `src/agent/agent-setup.ts` (call the loader)
- Modify: `src/agent/prompt/modules/runtime.ts` (consume the loader's output)
- Test: `tests/agent/prompt/tool-index-loader.test.ts`

**Step 1: Loader**

```ts
export interface ToolIndex {
  /** Compact multi-line string for the prompt. */
  render: string;
  /** Structured form for programmatic access. */
  skills: Array<{ name: string; tools: Array<{ name: string; description?: string }> }>;
}

export function loadToolIndex(workspacePath: string): ToolIndex {
  // Scan workspacePath/.ax/tools/*/_index.json
  // Aggregate into a single render string matching the old `toolModuleIndex` format.
  // Return empty index ({render: '', skills: []}) if the dir doesn't exist.
}
```

The render format should match what `runtime.ts` previously expected from `ctx.toolModuleIndex` so the prompt doesn't shift — verify by reading the current `runtime.ts:62-70`.

**Step 2: Call in agent-setup**

```ts
// In buildSystemPrompt:
const toolIndex = loadToolIndex(config.workspace);
```

Pass `toolIndex.render` into the prompt builder as `toolModuleIndex`. (Rename the ctx field if it's clearer — optional.)

**Step 3: Tests**

Fixture: tempdir with two skills each having 2-3 `_index.json` files. Assert the render string has the expected shape.

**Step 4: Commit**

```
feat(agent): load tool index from committed .ax/tools/ at turn start
```

---

## Task 7: Undo fix 2's gitignore, update docs

**Files:**
- Modify: `src/host/server-completions.ts::seedAxDirectory` — remove the `.ax/.gitignore` write that fix 2 (commit `56adaab5`) added.
- Modify: any seeded template files that include `.ax/.gitignore`.
- Modify: `.claude/skills/ax-agent/SKILL.md`, `.claude/skills/ax-runners/SKILL.md`, `.claude/skills/ax-provider-skills/SKILL.md` — update any references to per-turn generation, gitignored tools, etc.

**Step 1: Remove the gitignore write**

Look at the lines added by commit `56adaab5` in `seedAxDirectory`. Remove the `.ax/.gitignore` creation. Don't leave a stale comment.

**Step 2: Update skill docs**

Journal + existing skill docs will have references to "auto-generated tool modules in `.ax/tools/`" — update to "committed tool modules regenerated on skill approval + explicit refresh."

**Step 3: Commit**

```
docs: tool modules are git-committed, not gitignored
```

---

## Task 8: Post-landing cleanup sweep

**Files:**
- Various — run a grep for residual references to the old model.

**Step 1: Residual grep**

```bash
rg 'per-turn.*tool|auto-generat.*tool|toolModuleIndex' src/ tests/ docs/ .claude/
```

Every remaining hit should be in plans, journal, or lessons (historical, fine). Anything in live code = bug.

**Step 2: Commit if anything needed**

```
chore: scrub residual per-turn-tool-generation references
```

---

## Stretch: drift detection (NOT in v1, deferred)

**If time permits after Tasks 1-8:**

- At MCP connect time in the turn-start flow (wherever `mcpManager` connects), hash the actual tool signatures.
- Compare to the hash stored in `.ax/tools/<skill>/_index.json` (add a `signature_hash` field).
- On mismatch: emit `skill.tools_drifted` event; surface in admin UI Approvals page as a "Tools out of date — click refresh" warning on the per-agent Skills tab.
- Do NOT auto-regenerate. Admin action is the cue.

Skip this if any of Tasks 1-8 takes longer than expected. Can land as its own plan later.

---

## Verification plan for end-to-end

After all 8 tasks land:

1. Start a fresh AX instance with a clean bare repo.
2. Create an agent; commit a Linear SKILL.md via sidecar.
3. Dashboard: approve the Linear skill with a `LINEAR_API_KEY`.
4. Observe: `.ax/tools/linear/*.js` + `.ax/tools/linear/_index.json` appear as a commit in the workspace repo authored by `AX Host`.
5. Agent turn: `execute_script` imports from `/workspace/.ax/tools/linear/list-issues.js` — works first try, no improvising.
6. Simulate MCP server upgrade (add a tool): verify existing modules still work (no regression). Click refresh → observe new commit with the new tool.
7. Delete a skill: verify `.ax/tools/<skill>/` is removed in the sidecar cleanup commit (if the sidecar handles skill deletion — may need a separate hook).

---

## Constraints carried forward from the main migration

- No narrative comments ("previously," "per-turn was," "migration complete," "phase N").
- CLAUDE.md: no error handling for scenarios that can't happen; no fallbacks with default values where a fail-fast would be more honest.
- Journal + lessons per CLAUDE.md BEFORE committing each task.
- Targeted tests green before each commit. `npm run build` clean.
- Each task = 1 commit. Don't bundle. If something unexpected comes up mid-task, land a separate commit for the surprise.

---

## What to DO FIRST when executing this plan

1. Read `docs/plans/2026-04-18-skills-single-source-of-truth-design.md` for the thinking behind the SSOT migration.
2. Read commit `bbb563ce` (step 8) and the fix-up commits `e27ee7b1` + `56adaab5` for the last state of the system.
3. Read `src/host/server-completions.ts:1264-1332` to see the current per-turn generation you're deleting.
4. Read `src/host/skills/get-agent-skills.ts` + `src/host/skills/skill-cred-store.ts` for the SSOT helpers this plan builds on.
5. Read `src/host/server.ts::getBareRepoPath` (~line 170) to understand the bare-repo plumbing.

Then start Task 1.
