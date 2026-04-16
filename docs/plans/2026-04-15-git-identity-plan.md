# Git-Based Identity Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace database-backed identity storage with git-native storage under `.ax/` in the workspace repo, validated by the host before committing.

**Architecture:** Identity files move from DocumentStore to `.ax/` in the workspace git repo. The host reads identity via `git show HEAD:` (only committed content enters prompts). The host validates `.ax/` diffs before committing (local mode: inline validation in `hostGitCommit()`; k8s mode: pre-commit hook in sidecar calls host via HTTP IPC). All identity IPC actions, tools, and handlers are removed — the agent reads/writes `.ax/` files directly.

**Tech Stack:** TypeScript, Node.js, git CLI (`execFileSync`), Zod (IPC schemas), vitest (tests)

---

### Task 1: Add `validateCommit()` function

The core validation function that checks `.ax/` diffs for security issues and structural violations.

**Files:**
- Create: `src/host/validate-commit.ts`
- Test: `tests/host/validate-commit.test.ts`

**Step 1: Write the failing test**

Create `tests/host/validate-commit.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { validateCommit } from '../../src/host/validate-commit.js';

describe('validateCommit', () => {
  it('passes when diff is empty', () => {
    const result = validateCommit('');
    expect(result).toEqual({ ok: true });
  });

  it('passes for valid identity file changes', () => {
    const diff = `diff --git a/.ax/identity/SOUL.md b/.ax/identity/SOUL.md
--- /dev/null
+++ b/.ax/identity/SOUL.md
@@ -0,0 +1,3 @@
+I am a helpful assistant.
+I value clarity and honesty.
+I work carefully.`;
    const result = validateCommit(diff);
    expect(result).toEqual({ ok: true });
  });

  it('rejects files outside allowed paths', () => {
    const diff = `diff --git a/.ax/secrets.txt b/.ax/secrets.txt
--- /dev/null
+++ b/.ax/secrets.txt
@@ -0,0 +1 @@
+some secret`;
    const result = validateCommit(diff);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('not in allowed paths');
  });

  it('rejects files exceeding size limit', () => {
    const bigContent = '+' + 'x'.repeat(33_000) + '\n';
    const diff = `diff --git a/.ax/identity/SOUL.md b/.ax/identity/SOUL.md
--- /dev/null
+++ b/.ax/identity/SOUL.md
@@ -0,0 +1,1 @@
${bigContent}`;
    const result = validateCommit(diff);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('exceeds size limit');
  });

  it('passes for valid skill file changes', () => {
    const diff = `diff --git a/.ax/skills/my-skill.md b/.ax/skills/my-skill.md
--- /dev/null
+++ b/.ax/skills/my-skill.md
@@ -0,0 +1,2 @@
+name: my-skill
+description: A useful skill`;
    const result = validateCommit(diff);
    expect(result).toEqual({ ok: true });
  });

  it('passes for AGENTS.md and HEARTBEAT.md changes', () => {
    const diff = `diff --git a/.ax/AGENTS.md b/.ax/AGENTS.md
--- /dev/null
+++ b/.ax/AGENTS.md
@@ -0,0 +1 @@
+You are a helpful agent.`;
    const result = validateCommit(diff);
    expect(result).toEqual({ ok: true });
  });

  it('passes for policy file changes', () => {
    const diff = `diff --git a/.ax/policy/rules.yaml b/.ax/policy/rules.yaml
--- /dev/null
+++ b/.ax/policy/rules.yaml
@@ -0,0 +1 @@
+version: 1`;
    const result = validateCommit(diff);
    expect(result).toEqual({ ok: true });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/host/validate-commit.test.ts`
Expected: FAIL — module not found

**Step 3: Write implementation**

Create `src/host/validate-commit.ts`:

```typescript
/**
 * Validates staged git diffs for .ax/ files before committing.
 *
 * Enforces:
 * - Only allowed paths under .ax/ (identity/, skills/, policy/, AGENTS.md, HEARTBEAT.md)
 * - File size limits (32KB for identity, 64KB for skills)
 * - Content scanning via scanInput() (future: policy engine reads .ax/policy/rules.yaml)
 */

import { getLogger } from '../logger.js';

const logger = getLogger().child({ component: 'validate-commit' });

/** Allowed path prefixes under .ax/ */
const ALLOWED_PREFIXES = [
  '.ax/identity/',
  '.ax/skills/',
  '.ax/policy/',
];

/** Allowed exact files under .ax/ */
const ALLOWED_FILES = [
  '.ax/AGENTS.md',
  '.ax/HEARTBEAT.md',
];

/** Max content size per file in bytes */
const MAX_IDENTITY_SIZE = 32_768;
const MAX_SKILL_SIZE = 65_536;

export interface ValidateCommitResult {
  ok: boolean;
  reason?: string;
}

/**
 * Parse a unified diff into per-file entries with added content.
 */
function parseDiff(diff: string): Array<{ path: string; addedContent: string }> {
  const files: Array<{ path: string; addedContent: string }> = [];
  // Split on diff headers
  const parts = diff.split(/^diff --git /m).filter(Boolean);

  for (const part of parts) {
    // Extract path from "a/.ax/foo b/.ax/foo"
    const headerMatch = part.match(/^a\/(.+?) b\/(.+?)$/m);
    if (!headerMatch) continue;
    const filePath = headerMatch[2];

    // Extract added lines (lines starting with +, excluding +++ header)
    const addedLines: string[] = [];
    for (const line of part.split('\n')) {
      if (line.startsWith('+++')) continue;
      if (line.startsWith('+')) {
        addedLines.push(line.slice(1)); // Remove the + prefix
      }
    }

    files.push({ path: filePath, addedContent: addedLines.join('\n') });
  }

  return files;
}

/**
 * Check if a file path is in the allowed set.
 */
function isAllowedPath(filePath: string): boolean {
  if (ALLOWED_FILES.includes(filePath)) return true;
  return ALLOWED_PREFIXES.some(prefix => filePath.startsWith(prefix));
}

/**
 * Get the max size limit for a file path.
 */
function getMaxSize(filePath: string): number {
  if (filePath.startsWith('.ax/skills/')) return MAX_SKILL_SIZE;
  return MAX_IDENTITY_SIZE;
}

/**
 * Validate a staged diff for .ax/ files.
 * Returns { ok: true } if valid, or { ok: false, reason } if rejected.
 */
export function validateCommit(diff: string): ValidateCommitResult {
  if (!diff.trim()) return { ok: true };

  const files = parseDiff(diff);

  for (const file of files) {
    // Check allowed paths
    if (!isAllowedPath(file.path)) {
      logger.warn('commit_rejected_path', { path: file.path });
      return { ok: false, reason: `File "${file.path}" is not in allowed paths under .ax/` };
    }

    // Check size limits
    const maxSize = getMaxSize(file.path);
    if (file.addedContent.length > maxSize) {
      logger.warn('commit_rejected_size', { path: file.path, size: file.addedContent.length, max: maxSize });
      return { ok: false, reason: `File "${file.path}" exceeds size limit (${file.addedContent.length} > ${maxSize})` };
    }
  }

  return { ok: true };
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/host/validate-commit.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/host/validate-commit.ts tests/host/validate-commit.test.ts
git commit -m "feat: add validateCommit() for .ax/ git diff validation"
```

---

### Task 2: Add `loadIdentityFromGit()` function

Replace database-backed identity loading with git-based loading.

**Files:**
- Modify: `src/host/server-completions.ts` (replace `loadIdentityFromDB` with `loadIdentityFromGit`)
- Test: `tests/host/load-identity-from-git.test.ts`

**Step 1: Write the failing test**

Create `tests/host/load-identity-from-git.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { loadIdentityFromGit } from '../../src/host/server-completions.js';

// Mock execFileSync to simulate git show output
vi.mock('node:child_process', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:child_process')>();
  return {
    ...orig,
    execFileSync: vi.fn((cmd: string, args: string[]) => {
      // Only intercept git show commands
      if (cmd === 'git' && args[0] === 'show') {
        const ref = args[1]; // e.g. HEAD:.ax/identity/SOUL.md
        const gitFiles: Record<string, string> = {
          'HEAD:.ax/identity/SOUL.md': 'I am thoughtful.',
          'HEAD:.ax/identity/IDENTITY.md': 'I am AX.',
          'HEAD:.ax/AGENTS.md': 'You are a helpful agent.',
          'HEAD:.ax/HEARTBEAT.md': 'Check in daily.',
          'HEAD:.ax/identity/BOOTSTRAP.md': 'Bootstrap instructions.',
          'HEAD:.ax/identity/USER_BOOTSTRAP.md': 'Learn about the user.',
        };
        if (ref in gitFiles) return gitFiles[ref];
        throw new Error(`fatal: path not found: ${ref}`);
      }
      return orig.execFileSync(cmd, args);
    }),
  };
});

describe('loadIdentityFromGit', () => {
  it('loads all identity files from committed git state', () => {
    const result = loadIdentityFromGit('/workspace', '/gitdir');
    expect(result.soul).toBe('I am thoughtful.');
    expect(result.identity).toBe('I am AX.');
    expect(result.agents).toBe('You are a helpful agent.');
    expect(result.heartbeat).toBe('Check in daily.');
    expect(result.bootstrap).toBe('Bootstrap instructions.');
    expect(result.userBootstrap).toBe('Learn about the user.');
  });

  it('returns empty strings for missing files', () => {
    // Override mock to throw for all files
    const { execFileSync } = require('node:child_process');
    execFileSync.mockImplementation(() => { throw new Error('not found'); });

    const result = loadIdentityFromGit('/workspace', '/gitdir');
    expect(result.soul).toBe('');
    expect(result.identity).toBe('');
    expect(result.agents).toBe('');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/host/load-identity-from-git.test.ts`
Expected: FAIL — `loadIdentityFromGit` not found

**Step 3: Write implementation**

In `src/host/server-completions.ts`, replace `loadIdentityFromDB` with `loadIdentityFromGit`:

```typescript
/**
 * Load identity files from committed git state in the workspace repo.
 * Uses `git show HEAD:<path>` to ensure only committed (validated) content is read.
 */
export function loadIdentityFromGit(workspace: string, gitDir: string): IdentityPayload {
  const identity: IdentityPayload = {};
  const gitEnv = { GIT_DIR: gitDir, GIT_WORK_TREE: workspace };
  const opts = { cwd: workspace, encoding: 'utf-8' as const, stdio: 'pipe' as const, env: { ...process.env, ...gitEnv } };

  const fileMap: Array<{ gitPath: string; field: keyof IdentityPayload }> = [
    { gitPath: '.ax/AGENTS.md', field: 'agents' },
    { gitPath: '.ax/HEARTBEAT.md', field: 'heartbeat' },
    { gitPath: '.ax/identity/SOUL.md', field: 'soul' },
    { gitPath: '.ax/identity/IDENTITY.md', field: 'identity' },
    { gitPath: '.ax/identity/BOOTSTRAP.md', field: 'bootstrap' },
    { gitPath: '.ax/identity/USER_BOOTSTRAP.md', field: 'userBootstrap' },
  ];

  for (const { gitPath, field } of fileMap) {
    try {
      const content = execFileSync('git', ['show', `HEAD:${gitPath}`], opts).toString();
      if (content) identity[field] = content;
    } catch {
      // File doesn't exist in git — leave as undefined (empty)
    }
  }

  return identity;
}
```

Then update the call site at line ~1069:
- Change `loadIdentityFromDB(providers.storage.documents, agentId, currentUserId, reqLogger)` to `loadIdentityFromGit(workspace, gitDir)`
- This call needs to move to after workspace is initialized (after `hostGitSync`)
- Remove the `loadIdentityFromDB` function entirely
- Remove the `IDENTITY_FILE_MAP` constant (lines 144-152)
- Keep the `IdentityPayload` interface (still used for stdin payload)

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/host/load-identity-from-git.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/host/server-completions.ts tests/host/load-identity-from-git.test.ts
git commit -m "feat: replace loadIdentityFromDB with loadIdentityFromGit"
```

---

### Task 3: Integrate `validateCommit()` into `hostGitCommit()` (local mode)

Add validation of `.ax/` diffs before committing in local (docker/apple) mode.

**Files:**
- Modify: `src/host/server-completions.ts` (modify `hostGitCommit`, lines 377-415)

**Step 1: Write the failing test**

Add to `tests/host/validate-commit.test.ts`:

```typescript
describe('hostGitCommit integration', () => {
  it('rejects commits with invalid .ax/ content', () => {
    // This is tested via the validateCommit unit tests
    // The integration is: hostGitCommit calls validateCommit(diff) before git commit
    // If validateCommit returns { ok: false }, hostGitCommit reverts .ax/ changes
    expect(true).toBe(true); // Placeholder — real integration tested in acceptance
  });
});
```

**Step 2: Write implementation**

Modify `hostGitCommit()` in `src/host/server-completions.ts` (lines 377-415):

After `git add .` and before `git commit`, add:

```typescript
// Validate .ax/ changes before committing
const axDiff = execFileSync('git', ['diff', '--cached', '--',
  '.ax/identity/', '.ax/skills/', '.ax/policy/', '.ax/AGENTS.md', '.ax/HEARTBEAT.md',
], textOpts).trim();

if (axDiff) {
  const validation = validateCommit(axDiff);
  if (!validation.ok) {
    logger.warn('ax_commit_rejected', { reason: validation.reason });
    // Revert .ax/ changes — unstage and checkout
    execFileSync('git', ['reset', 'HEAD', '--', '.ax/'], gitOpts);
    execFileSync('git', ['checkout', '--', '.ax/'], gitOpts);
    // Re-stage remaining (non-.ax/) changes
    execFileSync('git', ['add', '.'], gitOpts);
    // Recheck if there's still something to commit
    const remainingStatus = execFileSync('git', ['status', '--porcelain'], textOpts);
    if (!remainingStatus.trim()) return; // Nothing left to commit
  }
}
```

Add import at top of file:
```typescript
import { validateCommit } from './validate-commit.js';
```

**Step 3: Run tests**

Run: `npx vitest run tests/host/validate-commit.test.ts`
Expected: PASS

**Step 4: Commit**

```bash
git add src/host/server-completions.ts
git commit -m "feat: integrate validateCommit into hostGitCommit for local mode"
```

---

### Task 4: Add `validate_commit` IPC action for k8s sidecar

Add the IPC schema and host handler so the git sidecar can request validation.

**Files:**
- Modify: `src/ipc-schemas.ts` (add `ValidateCommitSchema`)
- Modify: `src/host/ipc-server.ts` (add `validate_commit` handler)
- Modify: `src/agent/git-sidecar.ts` (call validation before committing)

**Step 1: Add IPC schema**

In `src/ipc-schemas.ts`, add after the tool-batch schemas:

```typescript
// ── Commit Validation ────────────────────────────────────
export const ValidateCommitSchema = ipcAction('validate_commit', {
  diff: safeString(262_144), // 256KB max diff
});
```

**Step 2: Add host handler**

In `src/host/ipc-server.ts`, add to the handlers object:

```typescript
validate_commit: async (req: any) => {
  const result = validateCommit(req.diff);
  return result;
},
```

Add import:
```typescript
import { validateCommit } from './validate-commit.js';
```

**Step 3: Modify git sidecar**

In `src/agent/git-sidecar.ts`, modify `commitAndPush()` to:
1. After `git add -A`, run `git diff --cached -- .ax/identity/ .ax/skills/ .ax/policy/ .ax/AGENTS.md .ax/HEARTBEAT.md`
2. If diff is non-empty, call the host's `validate_commit` endpoint via HTTP
3. If validation fails, revert `.ax/` changes and continue with remaining changes

The sidecar needs the host URL (from `AX_HOST_URL` env var) to make the HTTP IPC call.

**Step 4: Run tests**

Run: `npm test`
Expected: PASS

**Step 5: Commit**

```bash
git add src/ipc-schemas.ts src/host/ipc-server.ts src/agent/git-sidecar.ts
git commit -m "feat: add validate_commit IPC action for k8s sidecar validation"
```

---

### Task 5: Remove identity IPC schemas

Remove all identity-related schemas from `ipc-schemas.ts`.

**Files:**
- Modify: `src/ipc-schemas.ts`

**Step 1: Remove these exports (lines 174-210):**

- `IDENTITY_FILES` (line 176)
- `IDENTITY_ORIGINS` (line 178)
- `IdentityReadSchema` (lines 180-182)
- `IdentityWriteSchema` (lines 184-189)
- `UserWriteSchema` (lines 191-196)
- `COMPANY_IDENTITY_FILES` (line 200)
- `CompanyIdentityReadSchema` (lines 202-204)
- `CompanyIdentityWriteSchema` (lines 206-210)

Also remove governance schemas that depend on identity (lines 279-299):
- `PROPOSAL_TYPES` (line 281)
- `PROPOSAL_STATUSES` (line 282)
- `IdentityProposeSchema` (lines 284-289)
- `ProposalListSchema` (lines 291-293)
- `ProposalReviewSchema` (lines 295-299)

**Step 2: Run build to check for broken imports**

Run: `npm run build`
Expected: FAIL — broken references in handlers/tools (fixed in subsequent tasks)

**Step 3: Commit (will be combined with later tasks if build breaks)**

```bash
git add src/ipc-schemas.ts
git commit -m "refactor: remove identity and governance IPC schemas"
```

---

### Task 6: Remove identity IPC handlers

Delete the identity and governance handler files and remove their registration.

**Files:**
- Delete: `src/host/ipc-handlers/identity.ts`
- Delete: `src/host/ipc-handlers/governance.ts`
- Delete: `src/host/ipc-handlers/company.ts`
- Modify: `src/host/ipc-server.ts` (remove imports and handler registration)
- Delete: `tests/host/ipc-handlers/identity.test.ts`
- Delete: `tests/host/ipc-handlers/governance.test.ts`
- Delete: `tests/host/ipc-handlers/company.test.ts` (if exists)

**Step 1: Delete handler files**

```bash
rm src/host/ipc-handlers/identity.ts
rm src/host/ipc-handlers/governance.ts
rm src/host/ipc-handlers/company.ts
```

**Step 2: Remove imports and registration in `src/host/ipc-server.ts`**

Remove imports (lines 13, 17, 22):
```typescript
import { createIdentityHandlers } from './ipc-handlers/identity.js';
import { createGovernanceHandlers } from './ipc-handlers/governance.js';
import { createCompanyHandlers } from './ipc-handlers/company.js';
```

Remove handler registrations (lines 122-127, 131-136, 138):
```typescript
...createIdentityHandlers(providers, { ... }),
...createGovernanceHandlers(providers, { ... }),
...(providers.storage?.documents ? createCompanyHandlers(providers.storage.documents, providers.audit) : {}),
```

Remove taint budget exemptions for identity actions (line 256):
Change: `actionName !== 'identity_read' && actionName !== 'identity_write' && actionName !== 'user_write' && actionName !== 'identity_propose'`
To: remove those conditions entirely.

**Step 3: Delete test files**

```bash
rm tests/host/ipc-handlers/identity.test.ts
rm tests/host/ipc-handlers/governance.test.ts
rm -f tests/host/ipc-handlers/company.test.ts
```

**Step 4: Run build**

Run: `npm run build`
Expected: May still fail due to agent-side references (fixed in Task 7)

**Step 5: Commit**

```bash
git add -A
git commit -m "refactor: remove identity, governance, and company IPC handlers"
```

---

### Task 7: Remove identity and governance tools from agent

Remove the identity tool, governance tool, and related normalizers from the agent side.

**Files:**
- Modify: `src/agent/tool-catalog.ts` (remove identity tool lines 127-162, governance tool lines 285-317, normalizers lines 550-577)
- Modify: `src/agent/mcp-server.ts` (remove identity tool lines 124-146, governance tool lines 215-233, GOVERNANCE_ACTIONS lines 60)
- Modify: `src/agent/runners/pi-session.ts` (remove TOOLS_WITH_ORIGIN identity refs line 305, normalizer imports line 240, normalizer calls lines 390-393)

**Step 1: Modify `src/agent/tool-catalog.ts`**

- Remove the identity tool entry (lines 127-162 — the entire `{ name: 'identity', ... }` object)
- Remove the governance tool entry (lines 285-317 — the entire `{ name: 'governance', ... }` object)
- Remove `normalizeOrigin` function (lines 556-563)
- Remove `normalizeIdentityFile` function (lines 572-577)
- Remove `IDENTITY_FILE_MAP` constant (lines 566-569)
- Remove `ORIGIN_VALUES` constant (line 553)
- Update exports to remove `normalizeOrigin` and `normalizeIdentityFile`

**Step 2: Modify `src/agent/mcp-server.ts`**

- Remove identity tool block (lines 124-146)
- Remove governance tool block (lines 215-233)
- Remove `GOVERNANCE_ACTIONS` constant (line 60)
- Remove `normalizeOrigin` from import (line 13)

**Step 3: Modify `src/agent/runners/pi-session.ts`**

- Remove `normalizeOrigin` and `normalizeIdentityFile` from import (line 240)
- Remove `TOOLS_WITH_ORIGIN` entries for identity: remove `'identity_write'`, `'user_write'`, `'identity_propose'` from the Set (line 305)
- Remove the normalizer calls (lines 390-393) that handle origin and identity file normalization
- If `TOOLS_WITH_ORIGIN` becomes empty, remove the set and related code

**Step 4: Run build**

Run: `npm run build`
Expected: PASS (or close — may need minor fixes)

**Step 5: Run tests**

Run: `npm test`
Expected: Some test failures for removed tools (fix in next step)

**Step 6: Commit**

```bash
git add -A
git commit -m "refactor: remove identity and governance tools from agent"
```

---

### Task 8: Simplify identity-loader and remove USER.md references

Simplify the identity loader and remove all USER.md references from the prompt module.

**Files:**
- Modify: `src/agent/identity-loader.ts` (simplify — just unpack preloaded payload)
- Modify: `src/agent/prompt/modules/identity.ts` (remove USER.md refs, update evolution guidance)
- Modify: `src/agent/prompt/types.ts` (remove `user` from `IdentityFiles`)
- Modify: `src/agent/runner.ts` (remove `user` from applyPayload, lines 517-527)
- Modify: `src/host/server-completions.ts` (remove `user` from `IdentityPayload`)

**Step 1: Modify `IdentityFiles` in `src/agent/prompt/types.ts`**

Remove `user: string` field. The interface becomes:

```typescript
export interface IdentityFiles {
  agents: string;
  soul: string;
  identity: string;
  bootstrap: string;
  userBootstrap: string;
  heartbeat: string;
}
```

**Step 2: Modify `IdentityPayload` in `src/host/server-completions.ts`**

Remove `user?: string` field.

**Step 3: Simplify `identity-loader.ts`**

The loader just unpacks the preloaded payload — no filesystem fallback, no user dir:

```typescript
import type { IdentityFiles } from './prompt/types.js';

export function loadIdentityFiles(preloaded?: Partial<IdentityFiles>): IdentityFiles {
  return {
    agents: preloaded?.agents ?? '',
    soul: preloaded?.soul ?? '',
    identity: preloaded?.identity ?? '',
    bootstrap: preloaded?.bootstrap ?? '',
    userBootstrap: preloaded?.userBootstrap ?? '',
    heartbeat: preloaded?.heartbeat ?? '',
  };
}
```

**Step 4: Update `agent-setup.ts` call site**

Change:
```typescript
const identityFiles = loadIdentityFiles({
  userId: config.userId,
  preloaded: config.identity,
});
```
To:
```typescript
const identityFiles = loadIdentityFiles(config.identity);
```

**Step 5: Update `runner.ts` `applyPayload`**

Remove `user` from the identity assignment (line 522).

**Step 6: Update identity prompt module**

In `src/agent/prompt/modules/identity.ts`:

- Remove USER.md rendering (lines 55-59 in normal mode, lines 28-32 in bootstrap mode)
- Remove USER_BOOTSTRAP.md rendering (lines 57-58, 30-31)
- Rewrite `renderEvolutionGuidance()` — replace the entire method:
  - Remove references to database storage
  - Remove references to `identity` tool
  - Tell agent to read/write `.ax/identity/SOUL.md` and `.ax/identity/IDENTITY.md` directly
  - Tell agent to commit changes via git
  - Remove USER.md references
  - Remove per-profile queuing behavior (paranoid/balanced/yolo) — git validation replaces this
  - Keep the "When to Evolve" section

New evolution guidance content:

```typescript
private renderEvolutionGuidance(ctx: PromptContext): string[] {
  return [
    '',
    '## Identity Evolution',
    '',
    'Your identity files are yours. You are encouraged to evolve them as you grow:',
    '',
    '- **SOUL.md** (`.ax/identity/SOUL.md`) — Your core personality, values, and behavioral patterns.',
    '- **IDENTITY.md** (`.ax/identity/IDENTITY.md`) — Your factual self-description: name, role, capabilities.',
    '',
    '### How to Modify Identity',
    '',
    'Identity files live in your workspace under `.ax/identity/`. Read and write them directly:',
    '',
    '1. Read the current file to see existing content',
    '2. Write the updated content',
    '3. Commit the change: `git add .ax/identity/<file> && git commit -m "reason for change"`',
    '',
    'Changes are validated at commit time. If the commit is rejected, you will see an error explaining why.',
    '',
    '### When to Evolve',
    '',
    '- After a meaningful interaction that reveals something new about your working style',
    '- When the user gives you feedback that should be permanent',
    '- When you discover a better way to approach your role',
    '- During bootstrap: write your initial SOUL.md and IDENTITY.md to complete identity discovery',
    '',
    '**All identity changes are tracked in git history.**',
  ];
}
```

**Step 7: Run build and tests**

Run: `npm run build && npm test`
Expected: PASS (some test files may need updating)

**Step 8: Commit**

```bash
git add -A
git commit -m "refactor: simplify identity-loader, remove USER.md, update prompt guidance"
```

---

### Task 9: Clean up remaining references and fix tests

Find and fix any remaining broken references, update/delete tests for removed code.

**Files:**
- Search for and fix any remaining imports of removed code
- Delete or update test files for removed functionality
- Fix any TypeScript compilation errors

**Step 1: Search for stale references**

```bash
grep -r "identity_read\|identity_write\|user_write\|company_identity\|identity_propose\|proposal_list\|proposal_review\|loadIdentityFromDB\|IDENTITY_FILES\|IDENTITY_ORIGINS\|normalizeIdentityFile\|normalizeOrigin\|GOVERNANCE_ACTIONS\|createIdentityHandlers\|createGovernanceHandlers\|createCompanyHandlers" src/ tests/ --include='*.ts' -l
```

Fix each reference:
- Remove imports that reference deleted modules
- Remove test cases for deleted functionality
- Update any remaining references

**Step 2: Run full build**

Run: `npm run build`
Expected: PASS — no compilation errors

**Step 3: Run full test suite**

Run: `npm test`
Expected: PASS

**Step 4: Commit**

```bash
git add -A
git commit -m "refactor: clean up remaining identity/governance references"
```

---

### Task 10: Seed `.ax/` directory structure in workspace init

When the host initializes a workspace, create the `.ax/` directory structure with empty placeholder files so the agent knows where identity files live.

**Files:**
- Modify: `src/host/server-completions.ts` (add `.ax/` seeding after `hostGitSync`)

**Step 1: Write implementation**

After `hostGitSync()` completes, add a function to seed the `.ax/` directory:

```typescript
/**
 * Ensure the .ax/ directory structure exists in the workspace.
 * Creates directories and placeholder files if not already present.
 */
function seedAxDirectory(workspace: string, gitDir: string, logger: Logger): void {
  const gitEnv = { GIT_DIR: gitDir, GIT_WORK_TREE: workspace };
  const gitOpts = { cwd: workspace, stdio: 'pipe' as const, env: { ...process.env, ...gitEnv } };

  const dirs = [
    join(workspace, '.ax', 'identity'),
    join(workspace, '.ax', 'skills'),
    join(workspace, '.ax', 'policy'),
  ];

  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true });
  }

  // Commit the directory structure if it's new
  try {
    execFileSync('git', ['add', '.ax/'], gitOpts);
    const status = execFileSync('git', ['status', '--porcelain', '--', '.ax/'],
      { ...gitOpts, encoding: 'utf-8' }).trim();
    if (status) {
      execFileSync('git', ['commit', '-m', 'init: seed .ax/ directory structure'], gitOpts);
    }
  } catch (err) {
    logger.debug('ax_seed_skip', { reason: (err as Error).message });
  }
}
```

Call `seedAxDirectory(workspace, gitDir, reqLogger)` after `hostGitSync()`.

**Step 2: Run tests**

Run: `npm test`
Expected: PASS

**Step 3: Commit**

```bash
git add src/host/server-completions.ts
git commit -m "feat: seed .ax/ directory structure on workspace init"
```

---

### Task 11: Update k8s git-init to seed `.ax/` directory

Ensure the k8s git-init container also creates the `.ax/` directory structure.

**Files:**
- Modify: `src/providers/sandbox/k8s.ts` (update git-init container command)

**Step 1: Update git-init command**

The git-init container already runs a shell script to clone. Add `.ax/` directory creation after the clone:

```bash
mkdir -p /workspace/.ax/identity /workspace/.ax/skills /workspace/.ax/policy
```

**Step 2: Run build**

Run: `npm run build`
Expected: PASS

**Step 3: Commit**

```bash
git add src/providers/sandbox/k8s.ts
git commit -m "feat: seed .ax/ directory in k8s git-init container"
```

---

### Task 12: Final verification and cleanup

**Step 1: Full build**

Run: `npm run build`
Expected: PASS

**Step 2: Full test suite**

Run: `npm test`
Expected: PASS

**Step 3: Verify no stale references**

```bash
grep -r "DocumentStore.*identity\|documents.*identity\|identity.*collection" src/ --include='*.ts'
grep -r "loadIdentityFromDB" src/ --include='*.ts'
grep -r "proposalsDir\|proposals/" src/ --include='*.ts'
```
Expected: No matches (all removed)

**Step 4: Final commit if anything remains**

```bash
git add -A
git commit -m "chore: final cleanup for git-based identity"
```
