# Remove skill_list/skill_read IPC and Workspace GCS Provisioning

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove dead IPC actions (skill_list, skill_read) and dead workspace GCS provisioning code from the agent, since skills are now DB-backed + payload-delivered and workspace ops go through IPC tools.

**Architecture:** Skills are stored in DB and delivered to the agent via stdinPayload. The runner writes them to the workspace skills/ directory for runners to read. The agent uses skill_install/skill_update/skill_delete IPC tools for mutations. Workspace GCS provisioning (provision/cleanup) is dead code — the agent uses workspace_* IPC tools for all workspace operations. Only workspace-cli.ts `release` is still used.

**Tech Stack:** TypeScript, vitest, Zod schemas

---

### Task 1: Remove skill_list and skill_read from IPC schemas

**Files:**
- Modify: `src/ipc-schemas.ts:162-166`

**Step 1: Remove the schema definitions**

Delete these lines from `src/ipc-schemas.ts`:

```typescript
export const SkillListSchema = ipcAction('skill_list', {});

export const SkillReadSchema = ipcAction('skill_read', {
  slug: safeString(200),
});
```

**Step 2: Run build to verify no compile errors**

Run: `npm run build`

**Step 3: Commit**

```bash
git add src/ipc-schemas.ts
git commit -m "refactor: remove skill_list and skill_read IPC schemas"
```

---

### Task 2: Remove skill_list and skill_read handlers

**Files:**
- Modify: `src/host/ipc-handlers/skills.ts:107-136`

**Step 1: Remove the handler implementations**

In `createSkillsHandlers()`, remove the `skill_list` handler (lines ~107-121) and the `skill_read` handler (lines ~123-136). Keep `skill_install`, `skill_update`, `skill_delete`, `audit_query`, and `credential_request`.

Also remove unused imports: `getSkill` and `listSkills` from the storage/skills import (keep `upsertSkill`, `deleteSkill`, `inferMcpApps`).

**Step 2: Run build**

Run: `npm run build`

**Step 3: Commit**

```bash
git add src/host/ipc-handlers/skills.ts
git commit -m "refactor: remove skill_list and skill_read handlers — skills loaded via payload"
```

---

### Task 3: Remove list/read from tool catalog and MCP server

**Files:**
- Modify: `src/agent/tool-catalog.ts:200-243`
- Modify: `src/agent/mcp-server.ts:188-212`

**Step 1: Update tool-catalog.ts**

In the `skill` tool definition, remove the `list` and `read` type variants and their actionMap entries. The description, parameters union, and actionMap should only include `install`, `update`, and `delete`.

Updated description:
```
'Install, update, and delete skills.\n\nUse `type` to select:\n' +
'- install: Install a skill from ClawHub by slug or search query\n' +
'- update: Update a specific file in a skill\n' +
'- delete: Uninstall a skill by slug'
```

Updated parameters — remove the `Type.Object({ type: Type.Literal('list') })` and `Type.Object({ type: Type.Literal('read'), slug: ... })` variants from the union.

Updated actionMap — remove `list: 'skill_list'` and `read: 'skill_read'` entries.

**Step 2: Update mcp-server.ts**

Update the `skill` MCP tool:
- Change `z.enum` from `['install', 'list', 'read', 'update', 'delete']` to `['install', 'update', 'delete']`
- Update description to match tool-catalog
- Remove `list: 'skill_list'` and `read: 'skill_read'` from SKILL_ACTIONS

**Step 3: Run build**

Run: `npm run build`

**Step 4: Commit**

```bash
git add src/agent/tool-catalog.ts src/agent/mcp-server.ts
git commit -m "refactor: remove list/read from skill tool — agent reads skills from filesystem"
```

---

### Task 4: Remove skill_list/skill_read from capabilities template and manifest generator

**Files:**
- Modify: `templates/capabilities.yaml:10` (remove `skill_list` line)
- Modify: `src/utils/manifest-generator.ts:87` (remove `skill_read`, `skill_list` from internal actions set)

**Step 1: Edit capabilities.yaml**

Remove `- skill_list` from the capabilities list. Check if `skill_read` is also listed and remove it.

**Step 2: Edit manifest-generator.ts**

Remove `'skill_read'` and `'skill_list'` from the internal actions set (line ~87). Keep `'skill_propose'` if present (or remove if it's also dead).

**Step 3: Run build**

Run: `npm run build`

**Step 4: Commit**

```bash
git add templates/capabilities.yaml src/utils/manifest-generator.ts
git commit -m "refactor: remove skill_list/skill_read from capabilities and manifest generator"
```

---

### Task 5: Remove workspace GCS provisioning from agent

**Files:**
- Modify: `src/agent/workspace-cli.ts` (remove `provision()` and `cleanup()` functions)
- Modify: `src/agent/workspace.ts` (remove `provisionWorkspace`, `provisionScope`, `diffScope`, `tryGCSRestore`, `updateGCSCache`)

**Step 1: Remove provision() and cleanup() from workspace-cli.ts**

In `workspace-cli.ts`, remove the `provision()` function (~lines 43-83) and `cleanup()` function (~lines 85-132). Keep the `release()` function — it's still used by workspace-release.ts. Update the CLI dispatch switch/if at the bottom to only handle `release` (and show an error for `provision`/`cleanup`).

**Step 2: Remove dead functions from workspace.ts**

Remove `provisionWorkspace()`, `provisionScope()`, `diffScope()`, `tryGCSRestore()`, `updateGCSCache()` from workspace.ts. If the entire file becomes empty (only these functions), delete it and update the import in workspace-cli.ts.

Check what workspace-cli.ts `release()` still imports from workspace.ts — likely `diffScope()` is used for release. If so, keep that one function. Read workspace-cli.ts release() carefully before removing.

**Step 3: Run build**

Run: `npm run build`

**Step 4: Commit**

```bash
git add src/agent/workspace-cli.ts src/agent/workspace.ts
git commit -m "refactor: remove workspace GCS provision/cleanup — agent uses workspace_* IPC tools"
```

---

### Task 6: Remove GCS prefix fields from stdinPayload

**Files:**
- Modify: `src/agent/runner.ts` (StdinPayload interface, parseStdinPayload)
- Modify: `src/host/server-completions.ts` (resolveWorkspaceGcsPrefixes, stdinPayload construction)

**Step 1: Remove GCS fields from StdinPayload interface**

In `src/agent/runner.ts`, remove from StdinPayload:
- `workspaceCacheKey?: string`
- `agentGcsPrefix?: string`
- `userGcsPrefix?: string`
- `sessionGcsPrefix?: string`

Remove the corresponding lines from `parseStdinPayload()` that parse these fields.

**Step 2: Remove resolveWorkspaceGcsPrefixes and GCS prefix from stdinPayload**

In `src/host/server-completions.ts`:
- Remove the `resolveWorkspaceGcsPrefixes()` function (~lines 150-171)
- Remove the call to it (~line 897: `const gcsPrefixes = ...`)
- Remove `...gcsPrefixes,` from the stdinPayload object

**Step 3: Run build**

Run: `npm run build`

**Step 4: Commit**

```bash
git add src/agent/runner.ts src/host/server-completions.ts
git commit -m "refactor: remove GCS prefix fields from stdinPayload"
```

---

### Task 7: Update tests

**Files:**
- Modify: `tests/agent/tool-catalog.test.ts` (tool count, skill actionMap assertions)
- Modify: `tests/host/ipc-handlers/skills.test.ts` (remove skill_list/skill_read test if any remain)
- Modify: `tests/integration/cross-component.test.ts` (remove skill_list/skill_read references)
- Modify: `tests/agent/ipc-client.test.ts:89-92` (change skill_list to a valid action)
- Modify: `tests/sandbox-isolation.test.ts` (tool count if asserted)
- Delete: `tests/host/server-completions-gcs-prefix.test.ts` (tests for removed resolveWorkspaceGcsPrefixes)
- Modify: `tests/agent/workspace-release-hashes.test.ts` (remove references to provision/cleanup)

**Step 1: Update tool-catalog.test.ts**

- Line 6: Change tool count from `18` to `18` (tool count doesn't change — skill is still one tool, just with fewer operations)
- Lines 75-76: Remove assertions for `list` and `read` in actionMap
- Line 83: Update param keys — remove `slug` if it's only used by read (but install/update/delete all use slug, so it stays). Actually `'query'` is install-only, keep all.

**Step 2: Update cross-component.test.ts**

Remove `skill_list` and `skill_read` from the action loop (~lines 455-456). These actions no longer exist in the schema registry.

**Step 3: Update ipc-client.test.ts**

Change `skill_list` to `skill_delete` (or another valid action) in the test at line 89.

**Step 4: Delete GCS prefix test file**

```bash
rm tests/host/server-completions-gcs-prefix.test.ts
```

(If this file exists. Check first.)

**Step 5: Update workspace-release-hashes.test.ts**

Remove any assertions about `provision` or `cleanup` in workspace-cli.ts source. Keep assertions about `release`.

**Step 6: Run all tests**

Run: `npm test`
Expected: All tests pass

**Step 7: Commit**

```bash
git add tests/
git commit -m "test: update tests for skill_list/skill_read removal and GCS provisioning removal"
```

---

### Task 8: Update skills documentation

**Files:**
- Modify: `.claude/skills/ax-provider-skills/SKILL.md`
- Modify: `.claude/skills/ax-agent/SKILL.md`
- Modify: `.claude/skills/ax-host/SKILL.md`

**Step 1: Update ax-provider-skills skill**

Remove references to `skill_list` and `skill_read` IPC handlers. Update the skill install lifecycle to reflect DB-only persistence and payload delivery.

**Step 2: Update ax-agent skill**

Remove references to workspace-cli.ts provision/cleanup. Note that only release is still used.

**Step 3: Update ax-host skill**

Remove references to workspace provision endpoint if applicable. Update skill tool description.

**Step 4: Update journal and lessons**

Append journal entry and lesson to `.claude/journal/host/k8s-deployment.md` and `.claude/lessons/host/entries.md`.

**Step 5: Commit**

```bash
git add .claude/
git commit -m "docs: update skills for removed skill_list/skill_read and GCS provisioning"
```
