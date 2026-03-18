# Filesystem-Based Skills Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace database-backed skill store and IPC skill tools with filesystem-based skills in workspace directories, enabling user-scoped skill installation.

**Architecture:** Skills become plain `.md` files in `user/skills/` and `agent/skills/` workspace directories. Binaries go in `user/bin/` and `agent/bin/` (added to PATH). The agent reads/writes skill files directly. The host screens skill content and validates binaries at workspace release time before persisting to GCS. The `SkillStoreProvider`, most skill IPC tools, and the install-validator are removed.

**Tech Stack:** TypeScript, Vitest, Zod (IPC schemas), TypeBox (tool catalog)

**Design doc:** `docs/plans/2026-03-18-filesystem-skills-design.md`

---

### Task 1: Add user/bin and agent/bin to PATH

**Files:**
- Modify: `src/providers/sandbox/canonical-paths.ts:46-63` (canonicalEnv)
- Modify: `src/providers/sandbox/canonical-paths.ts:109-119` (symlinkEnv)
- Test: `tests/providers/sandbox/canonical-paths.test.ts`

**Step 1: Write the failing test**

In the test file for canonical-paths, add a test that verifies PATH includes user/bin and agent/bin:

```typescript
it('prepends user/bin and agent/bin to PATH when workspaces are active', () => {
  const config: SandboxConfig = {
    ipcSocket: '/tmp/test.sock',
    workspace: '/workspace/scratch',
    agentWorkspace: '/workspace/agent',
    userWorkspace: '/workspace/user',
  };
  const env = canonicalEnv(config);
  expect(env.PATH).toMatch(/^\/workspace\/user\/bin:\/workspace\/agent\/bin:/);
});

it('omits user/bin from PATH when no user workspace', () => {
  const config: SandboxConfig = {
    ipcSocket: '/tmp/test.sock',
    workspace: '/workspace/scratch',
    agentWorkspace: '/workspace/agent',
  };
  const env = canonicalEnv(config);
  expect(env.PATH).toMatch(/^\/workspace\/agent\/bin:/);
  expect(env.PATH).not.toContain('/workspace/user/bin');
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/providers/sandbox/canonical-paths.test.ts`
Expected: FAIL — PATH doesn't contain bin directories yet.

**Step 3: Implement PATH changes**

In `canonicalEnv()` (line ~52), add PATH prepending:

```typescript
export function canonicalEnv(config: SandboxConfig): Record<string, string> {
  const ipcDir = config.ipcSocket ? dirname(config.ipcSocket) : '';
  const webProxySocket = ipcDir ? join(ipcDir, 'web-proxy.sock') : '';

  // Prepend user/bin and agent/bin to PATH so installed skill binaries are available
  const binPaths: string[] = [];
  if (config.userWorkspace) binPaths.push(join(CANONICAL.user, 'bin'));
  if (config.agentWorkspace) binPaths.push(join(CANONICAL.agent, 'bin'));
  const basePath = process.env.PATH || '/usr/local/bin:/usr/bin:/bin';
  const path = binPaths.length > 0 ? `${binPaths.join(':')}:${basePath}` : basePath;

  return {
    PATH: path,
    AX_IPC_SOCKET: config.ipcSocket,
    // ... rest unchanged
  };
}
```

Apply the same pattern to `symlinkEnv()` using `join(mountRoot, 'user', 'bin')` and `join(mountRoot, 'agent', 'bin')`.

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/providers/sandbox/canonical-paths.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/providers/sandbox/canonical-paths.ts tests/providers/sandbox/canonical-paths.test.ts
git commit -m "feat: prepend user/bin and agent/bin to sandbox PATH"
```

---

### Task 2: Update loadSkills to support multiple directories

**Files:**
- Modify: `src/agent/stream-utils.ts:178-200` (loadSkills function)
- Test: `tests/agent/stream-utils.test.ts`

**Step 1: Write the failing test**

```typescript
import { loadSkillsMultiDir } from '../src/agent/stream-utils.js';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('loadSkillsMultiDir', () => {
  it('merges skills from multiple directories, user shadows agent', () => {
    const agentDir = mkdtempSync(join(tmpdir(), 'agent-skills-'));
    const userDir = mkdtempSync(join(tmpdir(), 'user-skills-'));

    // Agent has deploy.md and shared.md
    writeFileSync(join(agentDir, 'deploy.md'), '# Deploy\nDeploy to production');
    writeFileSync(join(agentDir, 'shared.md'), '# Shared\nShared skill');

    // User has deploy.md (shadows agent) and private.md
    writeFileSync(join(userDir, 'deploy.md'), '# Deploy\nUser custom deploy');
    writeFileSync(join(userDir, 'private.md'), '# Private\nUser only skill');

    const skills = loadSkillsMultiDir([
      { dir: agentDir, scope: 'agent' },
      { dir: userDir, scope: 'user' },
    ]);

    expect(skills).toHaveLength(3); // deploy (user), shared (agent), private (user)
    const deploy = skills.find(s => s.name === 'deploy');
    expect(deploy?.description).toBe('User custom deploy'); // user shadows agent
  });

  it('returns empty array when directories do not exist', () => {
    const skills = loadSkillsMultiDir([
      { dir: '/nonexistent/agent', scope: 'agent' },
      { dir: '/nonexistent/user', scope: 'user' },
    ]);
    expect(skills).toEqual([]);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/agent/stream-utils.test.ts`
Expected: FAIL — `loadSkillsMultiDir` doesn't exist.

**Step 3: Implement loadSkillsMultiDir**

Add to `src/agent/stream-utils.ts`:

```typescript
/**
 * Load and merge skills from multiple directories (user shadows agent).
 * Directories are processed in order; later entries shadow earlier ones by name.
 */
export function loadSkillsMultiDir(
  dirs: Array<{ dir: string; scope: 'agent' | 'user' }>,
): SkillSummary[] {
  const merged = new Map<string, SkillSummary>();
  for (const { dir } of dirs) {
    for (const skill of loadSkills(dir)) {
      merged.set(skill.name, skill);
    }
  }
  return [...merged.values()];
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/agent/stream-utils.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/agent/stream-utils.ts tests/agent/stream-utils.test.ts
git commit -m "feat: add loadSkillsMultiDir for multi-directory skill discovery"
```

---

### Task 3: Update agent-setup to read skills from filesystem

**Files:**
- Modify: `src/agent/agent-setup.ts:33-37` (skills loading)
- Modify: `src/agent/prompt/types.ts:9-12` (no SkillSummary changes needed, already compatible)
- Test: `tests/agent/agent-setup.test.ts`

**Step 1: Write the failing test**

Test that `buildSystemPrompt` reads skills from workspace directories when `config.skills` is not provided:

```typescript
it('loads skills from agent and user workspace directories', () => {
  const agentSkillsDir = mkdtempSync(join(tmpdir(), 'agent-'));
  const userSkillsDir = mkdtempSync(join(tmpdir(), 'user-'));
  mkdirSync(join(agentSkillsDir, 'skills'));
  mkdirSync(join(userSkillsDir, 'skills'));
  writeFileSync(join(agentSkillsDir, 'skills', 'test.md'), '# Test\nA test skill');

  const config: AgentConfig = {
    workspace: '/workspace',
    agentWorkspace: agentSkillsDir,
    userWorkspace: userSkillsDir,
    // no config.skills — should load from filesystem
  };
  const result = buildSystemPrompt(config);
  expect(result.systemPrompt).toContain('Test');
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/agent/agent-setup.test.ts`
Expected: FAIL — skills array is empty because filesystem loading not wired up.

**Step 3: Implement filesystem skill loading**

In `agent-setup.ts`, replace the stdin payload mapping with filesystem-based loading:

```typescript
import { loadSkillsMultiDir } from './stream-utils.js';
import { join } from 'node:path';

export function buildSystemPrompt(config: AgentConfig): PromptBuildResult {
  // Load skills from workspace directories (user shadows agent)
  const skillDirs: Array<{ dir: string; scope: 'agent' | 'user' }> = [];
  if (config.agentWorkspace) {
    skillDirs.push({ dir: join(config.agentWorkspace, 'skills'), scope: 'agent' });
  }
  if (config.userWorkspace) {
    skillDirs.push({ dir: join(config.userWorkspace, 'skills'), scope: 'user' });
  }
  const skills = loadSkillsMultiDir(skillDirs);

  // ... rest of function unchanged
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/agent/agent-setup.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/agent/agent-setup.ts tests/agent/agent-setup.test.ts
git commit -m "feat: load skills from workspace filesystem directories"
```

---

### Task 4: Update prompt modules for filesystem-based skills

**Files:**
- Modify: `src/agent/prompt/modules/skills.ts:59-74` (creating skills guidance)
- Modify: `src/agent/prompt/modules/skills.ts:47-56` (missing deps guidance)
- Modify: `src/agent/prompt/modules/runtime.ts:62` (agent/skills line)

**Step 1: Update skills.ts prompt text**

Replace the "Creating Skills" section (lines 59-74):

```typescript
lines.push(
  '',
  '### Creating Skills',
  '',
  'Create new skills by writing markdown files directly to `./user/skills/`.',
  'File-based: `./user/skills/my-skill.md`',
  'Directory-based: `./user/skills/my-skill/SKILL.md`',
  '',
  '**When to create a skill:**',
  '- You notice a recurring multi-step pattern in your work',
  '- The user asks you to remember a workflow for future sessions',
  '- You need domain-specific knowledge packaged for reuse',
  '',
  '**After creating a skill:** Continue working on your current task.',
  'The skill appears in your list on the next session.',
);
```

Replace the "Missing Dependencies" section (lines 48-56):

```typescript
if (skillsWithWarnings.length > 0) {
  lines.push(
    '',
    '### Missing Dependencies',
    '',
    'Some skills have missing binary dependencies (marked with ⚠ above).',
    'Install them directly using package managers (npm, pip, brew, etc.)',
    'and place binaries in `./user/bin/` so they persist across sessions.',
  );
}
```

**Step 2: Update runtime.ts**

Change line 62 from:
```
`  - ./agent/skills/ — installed skills [read-only]`,
```
to:
```
`  - ./agent/skills/ — shared agent skills [read-only]`,
```

Add user skills line after user workspace line:
```
...(ctx.hasUserWorkspace ? [
  `**User Workspace**: ./user (persistent files for the current user)`,
  `  - ./user/skills/ — your personal skills`,
  `  - ./user/bin/ — your installed binaries (in PATH)`,
] : []),
```

**Step 3: Run tests**

Run: `npx vitest run tests/agent/prompt/`
Expected: PASS (or update snapshot tests if any)

**Step 4: Commit**

```bash
git add src/agent/prompt/modules/skills.ts src/agent/prompt/modules/runtime.ts
git commit -m "feat: update prompt modules for filesystem-based skills"
```

---

### Task 5: Reduce skill tool to search-only

**Files:**
- Modify: `src/agent/tool-catalog.ts:194-253` (skill tool entry)
- Modify: `src/agent/mcp-server.ts:188-218` (skill MCP tool)
- Modify: `src/ipc-schemas.ts:151-182` (remove unused schemas)
- Modify: `src/host/taint-budget.ts:37-38` (remove skill_propose/skill_install)
- Test: `tests/agent/tool-catalog-sync.test.ts`

**Step 1: Replace skill tool in tool-catalog.ts**

Replace lines 194-253 with a search-only tool:

```typescript
// ── Skill Search ──
{
  name: 'skill',
  label: 'Skill',
  description:
    'Search for skills in the ClawHub registry.\n\n' +
    'Use `type: "search"` to find skills by query.',
  parameters: Type.Object({
    type: Type.Literal('search'),
    query: Type.String({ description: 'Search query' }),
    limit: Type.Optional(Type.Number({ description: 'Max results (1-50, default 20)' })),
  }),
  category: 'skill',
  actionMap: {
    search: 'skill_search',
  },
},
```

**Step 2: Replace skill MCP tool in mcp-server.ts**

Replace lines 188-218 with:

```typescript
// ── Skill Search ──
tool('skill',
  'Search for skills in the ClawHub registry.',
  {
    type: z.literal('search'),
    query: z.string().describe('Search query'),
    limit: z.number().optional().describe('Max results (1-50, default 20)'),
  },
  (args) => ipcCall('skill_search', { query: args.query, limit: args.limit }),
),
```

**Step 3: Remove unused IPC schemas from ipc-schemas.ts**

Remove these schemas (lines 151-182), keeping only `SkillSearchSchema`:

```
SkillReadSchema       → DELETE
SkillListSchema       → DELETE
SkillProposeSchema    → DELETE
SkillImportSchema     → DELETE
SkillInstallSchema    → DELETE
SkillInstallStatusSchema → DELETE
SkillSearchSchema     → KEEP
```

**Step 4: Remove skill_propose and skill_install from taint-budget.ts**

In `src/host/taint-budget.ts`, remove `'skill_propose'` and `'skill_install'` from the taint actions array.

**Step 5: Run tests**

Run: `npx vitest run tests/agent/tool-catalog-sync.test.ts`
Expected: May need updates to match the reduced skill tool. Fix any sync test assertions.

Run: `npx vitest run`
Expected: PASS (with updated assertions)

**Step 6: Commit**

```bash
git add src/agent/tool-catalog.ts src/agent/mcp-server.ts src/ipc-schemas.ts src/host/taint-budget.ts tests/
git commit -m "refactor: reduce skill tool to search-only"
```

---

### Task 6: Gut skills IPC handler to search + audit only

**Files:**
- Modify: `src/host/ipc-handlers/skills.ts` (remove everything except skill_search + audit_query)
- Modify: `src/host/ipc-server.ts:13,102` (update import if needed)

**Step 1: Rewrite skills.ts handler**

Replace the entire file with:

```typescript
/**
 * IPC handlers: skill search (ClawHub) and audit.
 */
import type { ProviderRegistry } from '../../types.js';
import * as clawhub from '../../clawhub/registry-client.js';
import type { IPCContext } from '../ipc-server.js';

export function createSkillsHandlers(providers: ProviderRegistry) {
  return {
    skill_search: async (req: any, ctx: IPCContext) => {
      const { query, limit } = req;
      const results = await clawhub.search(query, limit ?? 20);
      await providers.audit.log({
        action: 'skill_search',
        sessionId: ctx.sessionId,
        args: { query },
      });
      return { results };
    },

    audit_query: async (req: any) => {
      return { entries: await providers.audit.query(req.filter ?? {}) };
    },
  };
}
```

**Step 2: Run tests**

Run: `npx vitest run`
Expected: PASS (or fix references to removed handlers)

**Step 3: Commit**

```bash
git add src/host/ipc-handlers/skills.ts
git commit -m "refactor: gut skills IPC handler to search + audit only"
```

---

### Task 7: Remove SkillStoreProvider and related infrastructure

**Files:**
- Delete: `src/providers/skills/database.ts`
- Delete: `src/providers/skills/types.ts`
- Modify: `src/types.ts:11,167,175` (remove SkillStoreProvider, SkillScreenerProvider imports and fields)
- Modify: `src/host/provider-map.ts:57-59` (remove skills entry)
- Modify: `src/host/provider-map.ts:119` (remove SkillsProviderName)
- Delete: `src/utils/install-validator.ts`
- Modify: any files importing from deleted modules

**Step 1: Delete provider files**

```bash
rm src/providers/skills/database.ts src/providers/skills/types.ts
# If there's an index.ts in skills/, remove it too
```

**Step 2: Update src/types.ts**

Remove the SkillStoreProvider import (line 11) and the `skills` field from ProviderRegistry (line 167). Keep `screener` if it's used by workspace release screening.

```typescript
// Remove this import:
// import type { SkillStoreProvider, SkillScreenerProvider } from './providers/skills/types.js';

// Remove from ProviderRegistry:
//   skills: SkillStoreProvider;
```

**Step 3: Update provider-map.ts**

Remove the skills entry (lines 57-59):
```typescript
// DELETE:
//   skills: {
//     database: '../providers/skills/database.js',
//   },
```

Remove `SkillsProviderName` type export (line 119).

**Step 4: Delete install-validator.ts**

```bash
rm src/utils/install-validator.ts
```

**Step 5: Fix all import errors**

Search for any remaining imports from deleted files:

```bash
npx tsc --noEmit 2>&1 | head -40
```

Fix each broken import. Common places:
- `src/host/ipc-handlers/skills.ts` (already rewritten in Task 6)
- `src/provider-sdk/testing/harness.ts` (may reference SkillStoreProvider)
- `src/provider-sdk/interfaces/index.ts` (may re-export)
- `src/providers/screener/static.ts` and `none.ts` (may reference SkillScreenerProvider)

**Step 6: Run build and tests**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS after fixing all imports

**Step 7: Commit**

```bash
git add -A
git commit -m "refactor: remove SkillStoreProvider and install-validator"
```

---

### Task 8: Remove skills from server-completions stdin payload

**Files:**
- Modify: `src/host/server-completions.ts` (remove loadSkillsFromDB, SkillPayload, skill payload in stdin)
- Modify: `src/agent/runner.ts` (remove skills from stdin parsing, SkillPayload interface)
- Modify: `src/agent/agent-setup.ts` (remove config.skills references if any remain)

**Step 1: Remove loadSkillsFromDB from server-completions.ts**

Delete the `loadSkillsFromDB()` function (~lines 256-310) and the `SkillPayload` interface (~lines 110-115). Remove the `extractSkillMeta()` function if it's only used by `loadSkillsFromDB()` (check — it's also in `stream-utils.ts`).

Remove the call to `loadSkillsFromDB()` (~line 836) and the `skillsPayload` variable from the stdin payload construction.

Search for `skills` in the stdin JSON payload construction and remove it.

**Step 2: Remove SkillPayload from runner.ts**

Remove the `SkillPayload` interface (lines 31-36) and all references to `config.skills` and `payload.skills` in the stdin parsing logic.

In `AgentConfig` interface, remove the `skills?: SkillPayload[]` field.

In `StdinPayload` interface, remove the `skills?: SkillPayload[]` field.

In `applyPayload()`, remove the `config.skills = payload.skills` line (~line 580).

**Step 3: Run build and tests**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS. May need to update tests that construct AgentConfig with skills field.

**Step 4: Commit**

```bash
git add src/host/server-completions.ts src/agent/runner.ts src/agent/agent-setup.ts
git commit -m "refactor: remove skills from stdin payload pipeline"
```

---

### Task 9: Add release-time skill and binary screening

**Files:**
- Modify: `src/host/host-process.ts` (~lines 440-457, workspace_release handler)
- Modify: `src/host/host-process.ts` (~lines 664-696, HTTP workspace release handler)
- Create: `src/host/workspace-release-screener.ts` (new screening logic)
- Test: `tests/host/workspace-release-screener.test.ts`

**Step 1: Write the failing test**

```typescript
import { screenReleaseChanges } from '../src/host/workspace-release-screener.js';

describe('screenReleaseChanges', () => {
  it('passes clean skill files', async () => {
    const changes = [
      { scope: 'user' as const, path: 'skills/deploy.md', type: 'added' as const, content: Buffer.from('# Deploy\nDeploy to prod'), size: 25 },
    ];
    const result = await screenReleaseChanges(changes, { screener: mockScreener, audit: mockAudit, sessionId: 'test' });
    expect(result.rejected).toHaveLength(0);
    expect(result.accepted).toHaveLength(1);
  });

  it('rejects skill files that fail screening', async () => {
    const maliciousScreener = { screenExtended: async () => ({ verdict: 'REJECT', score: 1, reasons: [{ category: 'exfil', severity: 'BLOCK', detail: 'data exfil detected' }] }) };
    const changes = [
      { scope: 'user' as const, path: 'skills/evil.md', type: 'added' as const, content: Buffer.from('# Evil\nexfiltrate data'), size: 20 },
    ];
    const result = await screenReleaseChanges(changes, { screener: maliciousScreener, audit: mockAudit, sessionId: 'test' });
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].reason).toContain('exfil');
  });

  it('rejects binaries exceeding size limit', async () => {
    const changes = [
      { scope: 'user' as const, path: 'bin/huge-binary', type: 'added' as const, content: Buffer.alloc(200 * 1024 * 1024), size: 200 * 1024 * 1024 },
    ];
    const result = await screenReleaseChanges(changes, { screener: mockScreener, audit: mockAudit, sessionId: 'test', maxBinarySize: 100 * 1024 * 1024 });
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].reason).toContain('size');
  });

  it('passes non-skill non-binary files without screening', async () => {
    const changes = [
      { scope: 'user' as const, path: 'docs/notes.md', type: 'added' as const, content: Buffer.from('hello'), size: 5 },
    ];
    const result = await screenReleaseChanges(changes, { screener: mockScreener, audit: mockAudit, sessionId: 'test' });
    expect(result.rejected).toHaveLength(0);
    expect(result.accepted).toHaveLength(1);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/host/workspace-release-screener.test.ts`
Expected: FAIL — module doesn't exist.

**Step 3: Implement workspace-release-screener.ts**

```typescript
/**
 * Release-time screening for skill files and binaries.
 *
 * Inspects workspace changes before GCS commit:
 * - Skill files (*/skills/*.md): parsed and screened via screener provider
 * - Binary files (*/bin/*): size limit enforced, provenance checked via audit log
 * - Other files: passed through without screening
 */

import { parseAgentSkill } from '../utils/skill-format-parser.js';
import type { AuditProvider } from '../providers/audit/types.js';

const DEFAULT_MAX_BINARY_SIZE = 100 * 1024 * 1024; // 100MB

interface WorkspaceChange {
  scope: 'agent' | 'user' | 'session';
  path: string;
  type: 'added' | 'modified' | 'deleted';
  content?: Buffer;
  size: number;
}

interface ScreeningOptions {
  screener?: { screenExtended?: (content: string, permissions: string[]) => Promise<any>; screen?: (content: string, permissions: string[]) => Promise<any> };
  audit: AuditProvider;
  sessionId: string;
  maxBinarySize?: number;
}

interface ScreeningResult {
  accepted: WorkspaceChange[];
  rejected: Array<WorkspaceChange & { reason: string }>;
}

export async function screenReleaseChanges(
  changes: WorkspaceChange[],
  opts: ScreeningOptions,
): Promise<ScreeningResult> {
  const accepted: WorkspaceChange[] = [];
  const rejected: ScreeningResult['rejected'] = [];
  const maxBinSize = opts.maxBinarySize ?? DEFAULT_MAX_BINARY_SIZE;

  for (const change of changes) {
    if (change.type === 'deleted') {
      accepted.push(change);
      continue;
    }

    const isSkill = /\bskills\/.*\.md$/i.test(change.path);
    const isBinary = /\bbin\//.test(change.path);

    if (isSkill && change.content && opts.screener) {
      // Screen skill content
      const content = change.content.toString('utf-8');
      const parsed = parseAgentSkill(content);
      let verdict = 'APPROVE';
      let reasons: string[] = [];

      if (opts.screener.screenExtended) {
        const result = await opts.screener.screenExtended(content, parsed.permissions);
        verdict = result.verdict;
        reasons = result.reasons?.map((r: any) => r.detail) ?? [];
      } else if (opts.screener.screen) {
        const result = await opts.screener.screen(content, parsed.permissions);
        verdict = result.allowed ? 'APPROVE' : 'REJECT';
        reasons = result.reasons ?? [];
      }

      if (verdict === 'REJECT') {
        rejected.push({ ...change, reason: `Skill screening failed: ${reasons.join(', ')}` });
        await opts.audit.log({ action: 'skill_release_rejected', sessionId: opts.sessionId, args: { path: change.path, reasons } });
        continue;
      }
    }

    if (isBinary) {
      // Size limit check
      if (change.size > maxBinSize) {
        rejected.push({ ...change, reason: `Binary exceeds size limit (${change.size} > ${maxBinSize})` });
        await opts.audit.log({ action: 'binary_release_rejected', sessionId: opts.sessionId, args: { path: change.path, size: change.size, limit: maxBinSize } });
        continue;
      }
    }

    accepted.push(change);
  }

  return { accepted, rejected };
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/host/workspace-release-screener.test.ts`
Expected: PASS

**Step 5: Wire into workspace release flow**

In `src/host/host-process.ts`, in both workspace release handlers (NATS ~line 440 and HTTP ~line 664), add screening before `setRemoteChanges`:

```typescript
import { screenReleaseChanges } from './workspace-release-screener.js';

// After parsing changes, before setRemoteChanges:
const screening = await screenReleaseChanges(changes, {
  screener: providers.screener,
  audit: providers.audit,
  sessionId,
});

if (screening.rejected.length > 0) {
  logger.warn('workspace_release_rejected_files', {
    requestId,
    rejected: screening.rejected.map(r => ({ path: r.path, reason: r.reason })),
  });
}

// Only pass accepted changes to workspace provider
if (providers.workspace?.setRemoteChanges) {
  providers.workspace.setRemoteChanges(sessionId, screening.accepted);
}
```

**Step 6: Run build and tests**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS

**Step 7: Commit**

```bash
git add src/host/workspace-release-screener.ts tests/host/workspace-release-screener.test.ts src/host/host-process.ts
git commit -m "feat: add release-time screening for skill files and binaries"
```

---

### Task 10: Update the ToolFilterContext and filterTools

**Files:**
- Modify: `src/agent/tool-catalog.ts:459-485` (ToolFilterContext and filterTools)

**Step 1: Update ToolFilterContext**

Remove the deprecated `hasSkills` field and update `filterTools`:

```typescript
export interface ToolFilterContext {
  hasHeartbeat: boolean;
  hasWorkspaceScopes: boolean;
  hasGovernance: boolean;
}

export function filterTools(ctx: ToolFilterContext): readonly ToolSpec[] {
  return TOOL_CATALOG.filter(spec => {
    switch (spec.category) {
      case 'scheduler':        return ctx.hasHeartbeat;
      case 'skill':            return true; // skill_search always available
      case 'workspace':        return ctx.hasWorkspaceScopes;
      case 'workspace_scopes': return ctx.hasWorkspaceScopes;
      case 'governance':       return ctx.hasGovernance;
      default:                 return true;
    }
  });
}
```

Remove `hasSkills` from anywhere it's set (in `agent-setup.ts`).

**Step 2: Run tests**

Run: `npx vitest run`
Expected: PASS

**Step 3: Commit**

```bash
git add src/agent/tool-catalog.ts src/agent/agent-setup.ts
git commit -m "refactor: remove hasSkills from ToolFilterContext"
```

---

### Task 11: Clean up canonical-paths comment and update runtime prompt

**Files:**
- Modify: `src/providers/sandbox/canonical-paths.ts:17-19` (update comment about skills via stdin)

**Step 1: Update the file header comment**

Change lines 17-19 from:
```
 * Identity files and skills are now sent via stdin payload (loaded from
 * DocumentStore), not mounted as filesystem directories.
```
to:
```
 * Identity files are sent via stdin payload (loaded from DocumentStore).
 * Skills are stored as filesystem files in agent/skills/ and user/skills/.
```

**Step 2: Commit**

```bash
git add src/providers/sandbox/canonical-paths.ts
git commit -m "docs: update canonical-paths comment for filesystem-based skills"
```

---

### Task 12: Fix remaining test failures

**Files:**
- Various test files that reference removed APIs

**Step 1: Run full test suite**

```bash
npx vitest run 2>&1 | tail -30
```

**Step 2: Fix each failure**

Common patterns to fix:
- Tests constructing `ProviderRegistry` with `skills` field → remove it
- Tests referencing `skill_read`, `skill_list`, `skill_propose`, etc. → update or remove
- Tests importing from `src/providers/skills/types.ts` → remove
- Tests importing `install-validator.ts` → remove
- `tool-catalog-sync.test.ts` — update expected IPC actions to match reduced skill tool

**Step 3: Run full test suite again**

```bash
npx vitest run
```
Expected: All tests PASS

**Step 4: Commit**

```bash
git add -A
git commit -m "test: fix tests for filesystem-based skills"
```

---

### Task 13: Delete skills provider directory

If there are any remaining files in `src/providers/skills/` (like `index.ts`), delete the entire directory.

```bash
rm -rf src/providers/skills/
npx tsc --noEmit && npx vitest run
git add -A
git commit -m "chore: delete src/providers/skills/ directory"
```

---

### Post-Implementation Checklist

- [ ] `npm run build` passes (zero TypeScript errors)
- [ ] `npm test` passes (zero test failures)
- [ ] Skills in `user/skills/` are discovered at agent startup
- [ ] Skills in `agent/skills/` are discovered at agent startup
- [ ] User skills shadow agent skills with the same name
- [ ] `user/bin/` and `agent/bin/` are in the sandbox PATH
- [ ] `skill_search` IPC tool still works
- [ ] All other skill IPC tools are removed
- [ ] `SkillStoreProvider` no longer exists
- [ ] Release-time screening catches malicious skill content
- [ ] Release-time screening enforces binary size limits
- [ ] No references to `install-validator.ts` remain
- [ ] Design doc committed at `docs/plans/2026-03-18-filesystem-skills-design.md`
