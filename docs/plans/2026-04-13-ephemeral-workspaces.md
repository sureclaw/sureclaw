# Ephemeral Workspaces Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make all workspaces ephemeral — clone from `~/.ax/repos/{agentName}` into `/tmp/` each turn, commit+push back, delete. Eliminates `~/.ax/data/workspaces/` entirely.

**Architecture:** The git bare repo (`~/.ax/repos/{agentName}`) is the source of truth. Each turn creates a fresh temp clone, the agent works in it, changes are committed+pushed back, and the temp dir is deleted. Conversation history is already DB-persisted and unaffected. The `workspaceMap` (sessionId → path) provides runtime lookup for IPC handlers.

**Tech Stack:** Node.js fs, git CLI, existing Kysely conversation store

---

### Task 1: Remove isPersistent workspace branch in processCompletion

**Files:**
- Modify: `src/host/server-completions.ts:560-583`

**Step 1: Replace the workspace creation branch**

Change:
```typescript
// OLD
const isPersistent = !!persistentSessionId;
// ...
if (persistentSessionId) {
  workspace = workspaceDir(persistentSessionId);
  mkdirSync(workspace, { recursive: true });
} else {
  workspace = mkdtempSync(join(tmpdir(), 'ax-ws-'));
}
```

To:
```typescript
// All workspaces are ephemeral — git repo is the source of truth
workspace = mkdtempSync(join(tmpdir(), 'ax-ws-'));
```

Remove the `isPersistent` variable entirely.

**Step 2: Always delete workspace in finally block**

Change:
```typescript
// OLD
if (workspace && !isPersistent) {
  try { rmSync(workspace, { recursive: true, force: true }); } catch {
    reqLogger.debug('workspace_cleanup_failed', { workspace });
  }
}
```

To:
```typescript
if (workspace) {
  try { rmSync(workspace, { recursive: true, force: true }); } catch {
    reqLogger.debug('workspace_cleanup_failed', { workspace });
  }
}
```

**Step 3: Always do git commit before cleanup (not just when hostManagedGit)**

The existing code only commits when `hostManagedGit` is true (file:// URLs). Now that all workspaces are ephemeral, we must always commit if a git repo was synced, otherwise changes are lost.

No change needed — the `hostManagedGit` flag is already set when git sync succeeds, and the commit block already checks it. The flag works correctly.

**Step 4: Remove the `workspaceDir` import**

Remove `workspaceDir` from the import line (keep `agentDir`):
```typescript
import { agentDir } from '../paths.js';
```

**Step 5: Run tests**

Run: `npx tsc --noEmit` — should compile clean.
Run: `npm test -- --run tests/host/server-completions.test.ts` (if exists) or related tests.

**Step 6: Commit**

```bash
git add src/host/server-completions.ts
git commit -m "feat: make all workspaces ephemeral (clone from git, delete after turn)"
```

---

### Task 2: Remove workspaceDir from paths.ts and all callers

**Files:**
- Modify: `src/paths.ts:97-107`
- Modify: `src/host/ipc-handlers/llm.ts:9,43`

**Step 1: Update llm.ts image resolver to use workspaceMap**

The LLM handler resolves images from workspace paths. Currently uses `workspaceDir(ctx.sessionId)` which points to the old persistent path. Change to use the `workspaceMap` from CompletionDeps.

Check if `workspaceMap` is already available to the LLM handler. If not, pass it through. The handler should look up `workspaceMap.get(ctx.sessionId)` instead of calling `workspaceDir()`.

**Step 2: Remove workspaceDir from paths.ts**

Delete the `workspaceDir` function (lines 97-107). Also remove the "workspaces" line from the `dataDir()` docstring if present.

**Step 3: Run tests**

Run: `npx tsc --noEmit`
Run: `npm test -- --run tests/host/ipc-handlers/`

**Step 4: Commit**

```bash
git add src/paths.ts src/host/ipc-handlers/llm.ts
git commit -m "refactor: remove workspaceDir — ephemeral workspaces use workspaceMap"
```

---

### Task 3: Remove cleanStaleWorkspaces

**Files:**
- Delete contents of: `src/host/server-lifecycle.ts` (keep file, remove `cleanStaleWorkspaces`)
- Modify: `src/host/server-local.ts:24,281`

**Step 1: Remove cleanStaleWorkspaces function from server-lifecycle.ts**

Delete the entire `cleanStaleWorkspaces` function. If the file has no other exports, leave it empty or with just the imports needed by other functions.

**Step 2: Remove the call in server-local.ts**

Remove the import of `cleanStaleWorkspaces` and the call at line 281.

**Step 3: Run tests**

Run: `npx tsc --noEmit`
Run: `npm test -- --run tests/host/`

**Step 4: Commit**

```bash
git add src/host/server-lifecycle.ts src/host/server-local.ts
git commit -m "refactor: remove cleanStaleWorkspaces — no persistent workspace dirs to clean"
```

---

### Task 4: Ensure git sync always runs for persistent sessions

**Files:**
- Modify: `src/host/server-completions.ts:585-597`

**Step 1: Initialize git repo if no workspace provider**

Currently git sync only runs if `providers.workspace` exists. For local mode without an explicit workspace provider, the git-local workspace is auto-created via `getRepoUrl()`. Verify that the workspace provider is always available for persistent sessions.

If the workspace provider might be missing, add a fallback that initializes a bare repo at `~/.ax/repos/{agentName}` directly:

```typescript
if (persistentSessionId) {
  // Git repo is the persistence layer — always sync for persistent sessions
  const repoPath = join(dataDir(), 'repos', agentName);
  const repoUrl = `file://${repoPath}`;
  if (!existsSync(repoPath)) {
    mkdirSync(repoPath, { recursive: true });
    execFileSync('git', ['init', '--bare'], { cwd: repoPath, stdio: 'pipe' });
  }
  try {
    hostGitSync(workspace, repoUrl, reqLogger);
    hostManagedGit = true;
  } catch (err) {
    reqLogger.warn('host_git_sync_failed', { error: (err as Error).message });
  }
}
```

This ensures persistent sessions always have git backing, even without an explicit workspace provider.

**Step 2: Run tests**

Run: `npm test -- --run tests/providers/scheduler/plainjob.test.ts`

**Step 3: Commit**

```bash
git add src/host/server-completions.ts
git commit -m "feat: always init git repo for persistent sessions"
```

---

### Task 5: Add test for ephemeral workspace lifecycle

**Files:**
- Create or modify: `tests/host/workspace-lifecycle.test.ts`

**Step 1: Write test verifying workspace is deleted after completion**

```typescript
test('workspace is deleted after turn completes', async () => {
  // Use a mock sandbox that records the workspace path
  // Verify the workspace dir no longer exists after processCompletion returns
});
```

**Step 2: Write test verifying git commit preserves files across turns**

```typescript
test('files created in workspace persist via git across turns', async () => {
  // Turn 1: create a file in workspace
  // Verify workspace is deleted after turn
  // Turn 2: verify the file exists (cloned from git)
});
```

**Step 3: Run tests**

Run: `npm test -- --run tests/host/workspace-lifecycle.test.ts`

**Step 4: Commit**

```bash
git add tests/host/workspace-lifecycle.test.ts
git commit -m "test: add ephemeral workspace lifecycle tests"
```

---

### Task 6: Update journal and lessons

**Files:**
- Modify: `.claude/journal/providers/scheduler.md`
- Modify: `.claude/lessons/index.md`

Document the architectural change: workspaces are now ephemeral, git repo is source of truth, `~/.ax/data/workspaces/` eliminated.
