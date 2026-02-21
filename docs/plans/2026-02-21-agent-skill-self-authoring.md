# Agent Skill Self-Authoring Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enable AX agents to discover, read, and create skills through IPC tools — with taint-gated security, content screening, and mid-session refresh so new skills are available on the next turn.

**Architecture:** The existing git-backed skills provider already handles propose → screen → approve/reject → commit. The IPC schemas and host handlers for `skill_list`, `skill_read`, and `skill_propose` already exist. We wire these into the agent tool catalog, expose them in the MCP server for claude-code agents, add a SkillsModule prompt section teaching agents when/how to create skills, and re-copy skills into the workspace before each agent turn so auto-approved skills appear on the next turn.

**Tech Stack:** TypeScript, TypeBox (tool catalog), Zod v4 (MCP server + IPC schemas), Vitest, isomorphic-git (existing skills provider)

---

### Task 1: Add skill tools to the tool catalog

**Files:**
- Modify: `src/agent/tool-catalog.ts`

**Step 1: Write the failing test**

Add a test to `tests/agent/tool-catalog.test.ts` that verifies `skill_list`, `skill_read`, and `skill_propose` exist in TOOL_CATALOG with correct parameter keys.

```typescript
test('skill tools exist in catalog', () => {
  const skillTools = TOOL_CATALOG.filter(t => t.name.startsWith('skill_'));
  expect(skillTools.map(t => t.name).sort()).toEqual([
    'skill_list', 'skill_propose', 'skill_read',
  ]);
});

test('skill_propose has correct params', () => {
  const keys = getToolParamKeys('skill_propose');
  expect(keys.sort()).toEqual(['content', 'reason', 'skill']);
});

test('skill_read has correct params', () => {
  const keys = getToolParamKeys('skill_read');
  expect(keys).toEqual(['name']);
});

test('skill_list has no params', () => {
  const keys = getToolParamKeys('skill_list');
  expect(keys).toEqual([]);
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- --run tests/agent/tool-catalog.test.ts`
Expected: FAIL — skill tools not found in TOOL_CATALOG

**Step 3: Add skill tools to TOOL_CATALOG**

In `src/agent/tool-catalog.ts`, add after the scheduler tools section:

```typescript
// ── Skill tools ──
{
  name: 'skill_list',
  label: 'List Skills',
  description:
    'List all available skills. Returns skill names and descriptions.',
  parameters: Type.Object({}),
},
{
  name: 'skill_read',
  label: 'Read Skill',
  description:
    'Read the full content of a skill by name.',
  parameters: Type.Object({
    name: Type.String(),
  }),
},
{
  name: 'skill_propose',
  label: 'Propose Skill',
  description:
    'Propose a new skill or update an existing one. The skill content is markdown — ' +
    'prompt-level instructions that guide your behavior (like a checklist or workflow). ' +
    'Content is screened for safety: dangerous patterns (exec, eval, fetch) are hard-rejected, ' +
    'capability patterns (fs-write, env-access) require human review, clean content is auto-approved. ' +
    'Auto-approved skills are available on your next turn in this session.',
  parameters: Type.Object({
    skill: Type.String({ description: 'Skill name (alphanumeric, hyphens, underscores)' }),
    content: Type.String({ description: 'Skill content as markdown' }),
    reason: Type.Optional(Type.String({ description: 'Why this skill is needed' })),
  }),
},
```

**Step 4: Run test to verify it passes**

Run: `npm test -- --run tests/agent/tool-catalog.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/agent/tool-catalog.ts tests/agent/tool-catalog.test.ts
git commit -m "feat: add skill_list, skill_read, skill_propose to tool catalog"
```

---

### Task 2: Add skill tools to MCP server (for claude-code agents)

**Files:**
- Modify: `src/agent/mcp-server.ts`

**Step 1: Write the failing test**

The existing sync test at `tests/agent/tool-catalog-sync.test.ts` will already fail because the tool catalog now has skill tools but the MCP server doesn't. But first we need to update the `knownInternalActions` set — remove `skill_read`, `skill_list`, `skill_propose` from it since they're now in the catalog.

Actually, the sync test `'MCP tool names exactly match TOOL_NAMES'` will fail as soon as we add skill tools to the catalog (Task 1) without adding them to the MCP server. This is the failing test.

**Step 2: Run sync test to confirm failure**

Run: `npm test -- --run tests/agent/tool-catalog-sync.test.ts`
Expected: FAIL — MCP tool names don't match TOOL_NAMES (skill tools missing from MCP)

**Step 3: Add skill tools to MCP server**

In `src/agent/mcp-server.ts`, add after the scheduler tools section:

```typescript
// ── Skill tools ──
tool('skill_list', 'List all available skills. Returns skill names and descriptions.', {},
  () => ipcCall('skill_list', {})),

tool('skill_read', 'Read the full content of a skill by name.', {
  name: z.string(),
}, (args) => ipcCall('skill_read', args)),

tool('skill_propose',
  'Propose a new skill or update an existing one. Content is screened for safety. ' +
  'Auto-approved skills are available on your next turn.',
  {
    skill: z.string().describe('Skill name (alphanumeric, hyphens, underscores)'),
    content: z.string().describe('Skill content as markdown'),
    reason: z.string().optional().describe('Why this skill is needed'),
  },
  (args) => ipcCall('skill_propose', args)),
```

**Step 4: Update sync test — remove skill actions from knownInternalActions**

In `tests/agent/tool-catalog-sync.test.ts`, remove `'skill_read', 'skill_list', 'skill_propose'` from the `knownInternalActions` set.

**Step 5: Run sync test to verify it passes**

Run: `npm test -- --run tests/agent/tool-catalog-sync.test.ts`
Expected: PASS

**Step 6: Update sandbox-isolation tool count**

In `tests/sandbox-isolation.test.ts`, update the tool count assertion from 14 to 17 (adding 3 skill tools). Also remove the `expect(names).not.toContain('skill_list')` assertion and replace it with assertions that skill tools ARE present.

**Step 7: Run sandbox-isolation test**

Run: `npm test -- --run tests/sandbox-isolation.test.ts`
Expected: PASS

**Step 8: Commit**

```bash
git add src/agent/mcp-server.ts tests/agent/tool-catalog-sync.test.ts tests/sandbox-isolation.test.ts
git commit -m "feat: expose skill tools in MCP server, update sync tests"
```

---

### Task 3: Add meta-skill instructions to SkillsModule prompt

**Files:**
- Modify: `src/agent/prompt/modules/skills.ts`
- Modify or create: `tests/agent/prompt/modules/skills.test.ts`

**Step 1: Write the failing test**

```typescript
import { describe, test, expect } from 'vitest';
import { SkillsModule } from '../../../../src/agent/prompt/modules/skills.js';

function makeCtx(overrides = {}) {
  return {
    agentType: 'pi-agent-core',
    workspace: '/tmp',
    skills: ['# Test Skill\nDo stuff'],
    profile: 'balanced',
    sandboxType: 'subprocess',
    taintRatio: 0,
    taintThreshold: 0.10,
    identityFiles: { agents: '', soul: '', identity: '', user: '', bootstrap: '', userBootstrap: '', heartbeat: '' },
    contextWindow: 200000,
    historyTokens: 0,
    ...overrides,
  };
}

describe('SkillsModule', () => {
  test('renders skill content', () => {
    const mod = new SkillsModule();
    const rendered = mod.render(makeCtx()).join('\n');
    expect(rendered).toContain('Test Skill');
  });

  test('includes meta-skill instructions with skill_propose', () => {
    const mod = new SkillsModule();
    const rendered = mod.render(makeCtx()).join('\n');
    expect(rendered).toContain('skill_propose');
  });

  test('includes auto-continue hint', () => {
    const mod = new SkillsModule();
    const rendered = mod.render(makeCtx()).join('\n');
    expect(rendered).toContain('next turn');
  });

  test('does not render when no skills', () => {
    const mod = new SkillsModule();
    expect(mod.shouldInclude(makeCtx({ skills: [] }))).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- --run tests/agent/prompt/modules/skills.test.ts`
Expected: FAIL — meta-skill instructions not present

**Step 3: Update SkillsModule render method**

In `src/agent/prompt/modules/skills.ts`, expand the `render` method:

```typescript
render(ctx: PromptContext): string[] {
  return [
    '## Skills',
    '',
    'Skills directory: ./skills',
    '',
    ctx.skills.join('\n---\n'),
    '',
    '## Creating Skills',
    '',
    'You can create new skills using the `skill_propose` tool. Skills are markdown',
    'instruction files that guide your behavior — like checklists, workflows, or',
    'domain-specific knowledge.',
    '',
    '**When to create a skill:**',
    '- You notice a recurring multi-step pattern in your work',
    '- The user asks you to remember a workflow for future sessions',
    '- You need domain-specific knowledge packaged for reuse',
    '',
    '**How it works:**',
    '1. Call `skill_propose` with a name, markdown content, and reason',
    '2. Content is automatically screened for safety',
    '3. Safe content is auto-approved; content with capabilities needs human review',
    '4. Auto-approved skills are available on your next turn in this session',
    '',
    '**After creating a skill:** Continue working on your current task.',
    'The skill will be in your prompt on the next turn — do not pause or wait',
    'for the user to say "go ahead". If the skill was part of a larger task,',
    'keep going.',
  ];
}
```

**Step 4: Run test to verify it passes**

Run: `npm test -- --run tests/agent/prompt/modules/skills.test.ts`
Expected: PASS

**Step 5: Add sync test for skill tools in SkillsModule prompt**

In `tests/agent/tool-catalog-sync.test.ts`, add:

```typescript
test('skill_propose tool is documented in SkillsModule', () => {
  const mod = new SkillsModule();
  const ctx = makePromptContext({ skills: ['# Dummy'] });
  const rendered = mod.render(ctx).join('\n');
  expect(rendered).toContain('skill_propose');
});
```

Import `SkillsModule` at the top of the file.

**Step 6: Run sync test**

Run: `npm test -- --run tests/agent/tool-catalog-sync.test.ts`
Expected: PASS

**Step 7: Commit**

```bash
git add src/agent/prompt/modules/skills.ts tests/agent/prompt/modules/skills.test.ts tests/agent/tool-catalog-sync.test.ts
git commit -m "feat: add meta-skill instructions to SkillsModule prompt"
```

---

### Task 4: Mid-session skill refresh — re-copy skills before each agent turn

**Files:**
- Modify: `src/host/server.ts`

The current flow: skills are copied from `./skills/` to `<workspace>/skills/` once at session start. For mid-session refresh, we need to re-copy before each agent spawn (every turn in the session).

**Step 1: Write the failing test**

In `tests/host/server.test.ts` (or a new `tests/host/skill-refresh.test.ts`), add a test that:
1. Sends a message to create a session (turn 1)
2. Writes a new skill file to the host `./skills/` directory
3. Sends another message in the same session (turn 2)
4. Verifies the agent's workspace `skills/` directory contains the new skill

Since the agent's workspace is a temp directory, we need to capture it. The test should verify the file copy logic. If the server test is complex, a simpler approach: unit test the copy logic by extracting it to a helper.

Actually, the simplest change: move the skills copy block from "session start only" to "every processCompletion call". Since skills are just `.md` files being `copyFileSync`'d, this is cheap.

```typescript
test('skills are refreshed from host dir before each agent spawn', async () => {
  // First message creates session
  const res1 = await sendMessage(server, { message: 'hello' });
  expect(res1.status).toBe(200);

  // Write a new skill to host skills dir
  const hostSkillsDir = resolve('skills');
  mkdirSync(hostSkillsDir, { recursive: true });
  writeFileSync(join(hostSkillsDir, 'new-skill.md'), '# New Skill\nDo things');

  // Second message in same session — should pick up the new skill
  const res2 = await sendMessage(server, { message: 'what skills do you have?', session_id: res1.sessionId });
  expect(res2.status).toBe(200);

  // Cleanup
  unlinkSync(join(hostSkillsDir, 'new-skill.md'));
});
```

Note: The exact test structure depends on how `sendMessage` works in the existing test suite. The key assertion is that the workspace skills dir is refreshed.

**Step 2: Run test to verify it fails**

Expected: Skills copy only happens at session start, not on subsequent turns.

**Step 3: Move skills copy to run before every agent spawn**

In `src/host/server.ts`, the skills copy block is currently inside the session workspace setup (runs once per session). Move it to just before `providers.sandbox.spawn()` so it runs on every turn:

```typescript
// Re-copy skills into workspace (refreshes mid-session after skill_propose)
const hostSkillsDir = resolve('skills');
try {
  const skillFiles = readdirSync(hostSkillsDir).filter(f => f.endsWith('.md'));
  for (const f of skillFiles) {
    copyFileSync(join(hostSkillsDir, f), join(wsSkillsDir, f));
  }
  // Remove workspace skill files that no longer exist on host (deleted/reverted)
  const wsSkillFiles = readdirSync(wsSkillsDir).filter(f => f.endsWith('.md'));
  for (const f of wsSkillFiles) {
    if (!skillFiles.includes(f)) {
      unlinkSync(join(wsSkillsDir, f));
    }
  }
} catch {
  reqLogger.debug('skills_refresh_failed', { hostSkillsDir });
}
```

Keep the original copy block at session creation too (for workspace setup), or consolidate into this single location that runs each turn.

**Step 4: Run test to verify it passes**

Run: `npm test -- --run tests/host/server.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/host/server.ts tests/host/server.test.ts
git commit -m "feat: refresh skills from host dir before each agent spawn"
```

---

### Task 5: Integration test — full propose → refresh → available flow

**Files:**
- Create or modify: `tests/integration/cross-component.test.ts`

**Step 1: Write the integration test**

```typescript
describe('skill self-authoring flow', () => {
  test('skill_propose AUTO_APPROVE writes file to skills dir', async () => {
    const providers = await buildProviders({ skills: 'git' });
    const result = await providers.skills.propose({
      skill: 'deploy-checklist',
      content: '# Deploy Checklist\n\n1. Run tests\n2. Build\n3. Deploy',
      reason: 'Codify deployment workflow',
    });

    expect(result.verdict).toBe('AUTO_APPROVE');

    // Verify skill is now listable
    const skills = await providers.skills.list();
    expect(skills.some(s => s.name === 'deploy-checklist')).toBe(true);

    // Verify content is readable
    const content = await providers.skills.read('deploy-checklist');
    expect(content).toContain('Deploy Checklist');
  });

  test('skill_propose REJECT on dangerous content', async () => {
    const providers = await buildProviders({ skills: 'git' });
    const result = await providers.skills.propose({
      skill: 'dangerous',
      content: '# Bad Skill\n\neval("malicious code")',
    });

    expect(result.verdict).toBe('REJECT');
    expect(result.reason).toContain('eval');

    // Verify skill was NOT written
    const skills = await providers.skills.list();
    expect(skills.some(s => s.name === 'dangerous')).toBe(false);
  });

  test('skill_propose NEEDS_REVIEW on capability content', async () => {
    const providers = await buildProviders({ skills: 'git' });
    const result = await providers.skills.propose({
      skill: 'fs-tool',
      content: '# FS Tool\n\nUses process.env for config',
    });

    expect(result.verdict).toBe('NEEDS_REVIEW');
    expect(result.reason).toContain('env-access');
  });
});
```

**Step 2: Run test**

Run: `npm test -- --run tests/integration/cross-component.test.ts`
Expected: PASS (this verifies existing provider behavior end-to-end)

**Step 3: Commit**

```bash
git add tests/integration/cross-component.test.ts
git commit -m "test: add skill self-authoring integration tests"
```

---

### Task 6: Run full test suite and fix any breakage

**Step 1: Run all tests**

Run: `npm test`

**Step 2: Fix any failures**

Common expected fixes:
- Tool count assertions in sandbox-isolation.test.ts (covered in Task 2)
- Sync test updates (covered in Task 2 and 3)
- Any test that hardcodes tool names or counts

**Step 3: Commit fixes**

```bash
git add -A
git commit -m "fix: update test assertions for skill tools"
```

---

## Summary of Changes

| File | Change |
|------|--------|
| `src/agent/tool-catalog.ts` | Add `skill_list`, `skill_read`, `skill_propose` tool specs |
| `src/agent/mcp-server.ts` | Add skill tools (Zod schemas) for claude-code agents |
| `src/agent/prompt/modules/skills.ts` | Add meta-skill instructions + auto-continue hint |
| `src/host/server.ts` | Re-copy skills before each agent spawn (mid-session refresh) |
| `tests/agent/tool-catalog.test.ts` | Tests for skill tools in catalog |
| `tests/agent/tool-catalog-sync.test.ts` | Sync test updates, remove skills from knownInternalActions |
| `tests/agent/prompt/modules/skills.test.ts` | SkillsModule meta-skill prompt tests |
| `tests/sandbox-isolation.test.ts` | Update tool count 14→17, flip skill_list assertion |
| `tests/integration/cross-component.test.ts` | End-to-end skill propose flow tests |
| `tests/host/server.test.ts` | Mid-session skill refresh test |

## Security Considerations

- `skill_propose` is already in the taint budget `DEFAULT_SENSITIVE_ACTIONS` — gated by profile
- Git skills provider has hard-reject patterns (exec, eval, fetch, child_process, spawn, etc.)
- Capability patterns (fs-write, env-access) trigger NEEDS_REVIEW
- All proposals are audited
- Skills are markdown prompt instructions, not executable code
- `safePath()` prevents directory traversal in skill names
- Git-versioned with revert support for rollback

## Future Increments (Not in Scope)

- **Increment 2: Skill marketplace** — Remote registry for discovering/installing community skills
- **Increment 3: Dynamic tool generation** — Agent-created IPC tools (executable, not just prompt)
- **SkillScreenerProvider** — The interface exists in types.ts but no implementation. Could add LLM-based screening for more nuanced checks.
