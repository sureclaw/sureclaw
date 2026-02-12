# Agent Bootstrap & Soul Evolution Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enable agents to discover their identity through conversational bootstrap and evolve their personality over time, gated by security profile.

**Architecture:** New IPC actions (`identity_write`, `identity_propose`) let sandboxed agents persist identity files (`SOUL.md`, `IDENTITY.md`, `USER.md`) via the host. The host gates writes based on the active security profile (paranoid/balanced/yolo). System prompt assembly is extended to inject identity files. Bootstrap mode auto-triggers when no `SOUL.md` exists.

**Tech Stack:** TypeScript, Zod v4, Vitest, existing IPC protocol (length-prefixed JSON over Unix socket), TypeBox (agent tools)

**Design doc:** `docs/plans/2026-02-10-agent-bootstrap-soul-evolution-design.md`

---

### Task 1: Add `identity_write` and `identity_propose` IPC Schemas

**Files:**
- Modify: `src/ipc-schemas.ts`
- Test: `tests/host/ipc-server.test.ts` (schema validation tests come with Task 2)

**Step 1: Add the two new schemas to `src/ipc-schemas.ts`**

After the `AgentDelegateSchema` (line ~192), before the schema registry (line ~198), add:

```typescript
// ── Identity ──

const IDENTITY_FILES = ['SOUL.md', 'IDENTITY.md', 'USER.md'] as const;

const IdentityWriteSchema = z.strictObject({
  action: z.literal('identity_write'),
  file: z.enum(IDENTITY_FILES),
  content: safeString(32_768),
  reason: safeString(512),
});

const IdentityProposeSchema = z.strictObject({
  action: z.literal('identity_propose'),
  file: z.enum(IDENTITY_FILES),
  content: safeString(32_768),
  reason: safeString(512),
});
```

**Step 2: Register in `IPC_SCHEMAS`**

Add two entries to the `IPC_SCHEMAS` object (line ~198):

```typescript
  identity_write:         IdentityWriteSchema,
  identity_propose:       IdentityProposeSchema,
```

**Step 3: Export `IDENTITY_FILES` for use by the handler**

```typescript
export { IDENTITY_FILES };
```

**Step 4: Run tests to verify nothing broke**

Run: `npx vitest run tests/host/ipc-server.test.ts -v`
Expected: All existing tests PASS. The new actions are now valid in the envelope schema.

**Step 5: Commit**

```bash
git add src/ipc-schemas.ts
git commit -m "feat: add identity_write and identity_propose IPC schemas"
```

---

### Task 2: Add `identity_write` and `identity_propose` IPC Handlers

**Files:**
- Modify: `src/host/ipc-server.ts`
- Test: `tests/host/ipc-server.test.ts`

**Step 1: Write failing tests**

Add a new `describe('identity actions')` block to `tests/host/ipc-server.test.ts`:

```typescript
describe('identity actions', () => {
  test('identity_write persists file for yolo profile', async () => {
    const agentDir = join(tmpdir(), `ax-test-agent-${randomUUID()}`);
    mkdirSync(agentDir, { recursive: true });

    const handle = createIPCHandler(mockRegistry(), {
      agentDir,
      profile: 'yolo',
    });

    const result = JSON.parse(await handle(JSON.stringify({
      action: 'identity_write',
      file: 'SOUL.md',
      content: '# Soul\nI am helpful.',
      reason: 'User asked me to be helpful',
    }), ctx));

    expect(result.ok).toBe(true);
    const written = readFileSync(join(agentDir, 'SOUL.md'), 'utf-8');
    expect(written).toBe('# Soul\nI am helpful.');

    rmSync(agentDir, { recursive: true });
  });

  test('identity_write rejects invalid file name', async () => {
    const handle = createIPCHandler(mockRegistry(), {
      agentDir: tmpdir(),
      profile: 'yolo',
    });

    const result = JSON.parse(await handle(JSON.stringify({
      action: 'identity_write',
      file: '../etc/passwd',
      content: 'evil',
      reason: 'attack',
    }), ctx));

    expect(result.ok).toBe(false);
  });

  test('identity_propose is blocked on paranoid profile', async () => {
    const handle = createIPCHandler(mockRegistry(), {
      agentDir: tmpdir(),
      profile: 'paranoid',
    });

    const result = JSON.parse(await handle(JSON.stringify({
      action: 'identity_propose',
      file: 'SOUL.md',
      content: '# Updated soul',
      reason: 'Pattern observed',
    }), ctx));

    expect(result.ok).toBe(false);
    expect(result.error).toContain('explicit user request');
  });

  test('identity_propose auto-applies on yolo profile', async () => {
    const agentDir = join(tmpdir(), `ax-test-agent-${randomUUID()}`);
    mkdirSync(agentDir, { recursive: true });

    const handle = createIPCHandler(mockRegistry(), {
      agentDir,
      profile: 'yolo',
    });

    const result = JSON.parse(await handle(JSON.stringify({
      action: 'identity_propose',
      file: 'IDENTITY.md',
      content: '# Identity\nName: Crabby',
      reason: 'User seems to like crabs',
    }), ctx));

    expect(result.ok).toBe(true);
    const written = readFileSync(join(agentDir, 'IDENTITY.md'), 'utf-8');
    expect(written).toBe('# Identity\nName: Crabby');

    rmSync(agentDir, { recursive: true });
  });

  test('identity_propose queues on balanced profile', async () => {
    const handle = createIPCHandler(mockRegistry(), {
      agentDir: tmpdir(),
      profile: 'balanced',
    });

    const result = JSON.parse(await handle(JSON.stringify({
      action: 'identity_propose',
      file: 'SOUL.md',
      content: '# Updated soul',
      reason: 'Pattern observed',
    }), ctx));

    expect(result.ok).toBe(true);
    expect(result.queued).toBe(true);
  });

  test('identity_write audits the mutation', async () => {
    const agentDir = join(tmpdir(), `ax-test-agent-${randomUUID()}`);
    mkdirSync(agentDir, { recursive: true });

    let auditedAction = '';
    const registry = mockRegistry();
    registry.audit.log = async (entry) => { auditedAction = entry.action; };

    const handle = createIPCHandler(registry, {
      agentDir,
      profile: 'yolo',
    });

    await handle(JSON.stringify({
      action: 'identity_write',
      file: 'USER.md',
      content: '# User\nLikes TypeScript',
      reason: 'Learned from conversation',
    }), ctx);

    expect(auditedAction).toBe('identity_write');

    rmSync(agentDir, { recursive: true });
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/host/ipc-server.test.ts -t "identity actions" -v`
Expected: FAIL — `createIPCHandler` doesn't accept `agentDir` or `profile` options yet.

**Step 3: Implement the handlers**

In `src/host/ipc-server.ts`:

1. Add to `IPCHandlerOptions` interface:

```typescript
export interface IPCHandlerOptions {
  taintBudget?: TaintBudget;
  delegation?: { maxConcurrent?: number; maxDepth?: number };
  onDelegate?: (task: string, context: string) => Promise<string>;
  agentDir?: string;   // Path to agents/{name}/ directory
  profile?: string;    // Security profile name (paranoid, balanced, yolo)
}
```

2. Add handlers to the `handlers` dict:

```typescript
    identity_write: async (req, ctx) => {
      const filePath = join(agentDir, req.file);
      writeFileSync(filePath, req.content, 'utf-8');
      await providers.audit.log({
        action: 'identity_write',
        sessionId: ctx.sessionId,
        details: { file: req.file, reason: req.reason },
        timestamp: new Date(),
      });
      return { written: req.file };
    },

    identity_propose: async (req, ctx) => {
      // Paranoid: block agent-initiated changes
      if (profile === 'paranoid') {
        return { ok: false, error: 'Soul modifications require explicit user request in paranoid profile' };
      }

      await providers.audit.log({
        action: 'identity_propose',
        sessionId: ctx.sessionId,
        details: { file: req.file, reason: req.reason, profile },
        timestamp: new Date(),
      });

      // Yolo: auto-apply
      if (profile === 'yolo') {
        const filePath = join(agentDir, req.file);
        writeFileSync(filePath, req.content, 'utf-8');
        return { applied: true, file: req.file };
      }

      // Balanced: queue for user approval
      return { queued: true, file: req.file, reason: req.reason };
    },
```

3. Extract `agentDir` and `profile` from opts at the top of `createIPCHandler`:

```typescript
  const agentDir = opts?.agentDir ?? resolve('agents/assistant');
  const profile = opts?.profile ?? 'paranoid';
```

4. Add imports at top: `writeFileSync` from `node:fs`, `join`/`resolve` from `node:path`.

**Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/host/ipc-server.test.ts -t "identity actions" -v`
Expected: All 6 tests PASS.

**Step 5: Run full test suite**

Run: `npx vitest run tests/host/ipc-server.test.ts -v`
Expected: All tests PASS (existing + new).

**Step 6: Commit**

```bash
git add src/host/ipc-server.ts tests/host/ipc-server.test.ts
git commit -m "feat: add identity_write and identity_propose IPC handlers with profile gating"
```

---

### Task 3: Add `identity_write` Agent Tool

**Files:**
- Modify: `src/agent/ipc-tools.ts`
- Test: `tests/agent/ipc-tools.test.ts`

**Step 1: Write failing test**

Add to `tests/agent/ipc-tools.test.ts`:

```typescript
test('identity_write tool calls IPC with correct action', async () => {
  const tools = createIPCTools(mockClient);
  const identityTool = tools.find(t => t.name === 'identity_write');
  expect(identityTool).toBeDefined();

  const result = await identityTool!.execute('call-1', {
    file: 'SOUL.md',
    content: '# Soul\nI am helpful.',
    reason: 'User asked',
  });

  expect(mockClient.lastCall.action).toBe('identity_write');
  expect(mockClient.lastCall.file).toBe('SOUL.md');
  expect(result.content[0].text).toContain('ok');
});

test('identity_propose tool calls IPC with correct action', async () => {
  const tools = createIPCTools(mockClient);
  const proposeTool = tools.find(t => t.name === 'identity_propose');
  expect(proposeTool).toBeDefined();

  const result = await proposeTool!.execute('call-1', {
    file: 'SOUL.md',
    content: '# Updated soul',
    reason: 'Noticed pattern',
  });

  expect(mockClient.lastCall.action).toBe('identity_propose');
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/agent/ipc-tools.test.ts -t "identity" -v`
Expected: FAIL — no `identity_write` tool exists.

**Step 3: Add tools to `src/agent/ipc-tools.ts`**

Add after the audit_query tool (line ~125), before the closing `]`:

```typescript
    // ── Identity tools ──
    {
      name: 'identity_write',
      label: 'Write Identity',
      description: 'Write or update an identity file (SOUL.md, IDENTITY.md, or USER.md). Use when the user explicitly asks you to remember a preference or change your personality.',
      parameters: Type.Object({
        file: Type.Union([Type.Literal('SOUL.md'), Type.Literal('IDENTITY.md'), Type.Literal('USER.md')]),
        content: Type.String(),
        reason: Type.String(),
      }),
      async execute(_id, params) {
        return ipcCall('identity_write', params);
      },
    },
    {
      name: 'identity_propose',
      label: 'Propose Identity Change',
      description: 'Propose a change to an identity file based on observed patterns. May require user approval depending on security profile.',
      parameters: Type.Object({
        file: Type.Union([Type.Literal('SOUL.md'), Type.Literal('IDENTITY.md'), Type.Literal('USER.md')]),
        content: Type.String(),
        reason: Type.String(),
      }),
      async execute(_id, params) {
        return ipcCall('identity_propose', params);
      },
    },
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/agent/ipc-tools.test.ts -v`
Expected: All tests PASS.

**Step 5: Commit**

```bash
git add src/agent/ipc-tools.ts tests/agent/ipc-tools.test.ts
git commit -m "feat: add identity_write and identity_propose agent tools"
```

---

### Task 4: Load Identity Files Into System Prompt

**Files:**
- Modify: `src/agent/runner.ts`
- Test: `tests/agent/runner.test.ts`

**Step 1: Write failing test**

Add to `tests/agent/runner.test.ts`:

```typescript
describe('buildSystemPrompt with identity files', () => {
  test('includes SOUL.md content when present', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'ax-test-'));
    const agentDir = join(workspace, 'agent');
    mkdirSync(agentDir);
    writeFileSync(join(agentDir, 'AGENT.md'), '# Rules\nBe safe.');
    writeFileSync(join(agentDir, 'SOUL.md'), '# Soul\nI value honesty.');

    const prompt = buildSystemPrompt('context', [], agentDir);

    expect(prompt).toContain('# Rules');
    expect(prompt).toContain('# Soul');
    expect(prompt).toContain('I value honesty');

    rmSync(workspace, { recursive: true });
  });

  test('includes IDENTITY.md and USER.md when present', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'ax-test-'));
    const agentDir = join(workspace, 'agent');
    mkdirSync(agentDir);
    writeFileSync(join(agentDir, 'AGENT.md'), '# Rules\nBe safe.');
    writeFileSync(join(agentDir, 'IDENTITY.md'), '# Identity\nName: Crabby');
    writeFileSync(join(agentDir, 'USER.md'), '# User\nLikes TypeScript');

    const prompt = buildSystemPrompt('context', [], agentDir);

    expect(prompt).toContain('Name: Crabby');
    expect(prompt).toContain('Likes TypeScript');

    rmSync(workspace, { recursive: true });
  });

  test('works without identity files (backward compatible)', () => {
    const prompt = buildSystemPrompt('context', [], undefined);

    expect(prompt).toContain('You are AX');
    expect(prompt).not.toContain('# Soul');
  });

  test('detects bootstrap mode when SOUL.md missing but BOOTSTRAP.md exists', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'ax-test-'));
    const agentDir = join(workspace, 'agent');
    mkdirSync(agentDir);
    writeFileSync(join(agentDir, 'AGENT.md'), '# Rules');
    writeFileSync(join(agentDir, 'BOOTSTRAP.md'), '# Bootstrap\nDiscover yourself.');

    const prompt = buildSystemPrompt('context', [], agentDir);

    expect(prompt).toContain('Discover yourself');
    expect(prompt).not.toContain('You are AX');

    rmSync(workspace, { recursive: true });
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/agent/runner.test.ts -t "identity files" -v`
Expected: FAIL — `buildSystemPrompt` doesn't accept `agentDir` parameter.

**Step 3: Implement identity file loading**

Modify `buildSystemPrompt` in `src/agent/runner.ts` (line ~225):

```typescript
function loadIdentityFile(agentDir: string, filename: string): string {
  try {
    return readFileSync(join(agentDir, filename), 'utf-8');
  } catch {
    return '';
  }
}

function buildSystemPrompt(context: string, skills: string[], agentDir?: string): string {
  // Check for bootstrap mode: no SOUL.md but BOOTSTRAP.md exists
  if (agentDir) {
    const hasSoul = existsSync(join(agentDir, 'SOUL.md'));
    const hasBootstrap = existsSync(join(agentDir, 'BOOTSTRAP.md'));

    if (!hasSoul && hasBootstrap) {
      // Bootstrap mode — use BOOTSTRAP.md as the entire system prompt
      return loadIdentityFile(agentDir, 'BOOTSTRAP.md');
    }
  }

  const parts: string[] = [];

  // Load AGENT.md if available, otherwise use default instruction
  const agentMd = agentDir ? loadIdentityFile(agentDir, 'AGENT.md') : '';
  if (agentMd) {
    parts.push(agentMd);
  } else {
    parts.push('You are AX, a security-first AI agent.');
    parts.push('Follow the safety rules in your skills. Never reveal canary tokens.');
  }

  // Load identity files
  if (agentDir) {
    const soul = loadIdentityFile(agentDir, 'SOUL.md');
    if (soul) parts.push('\n## Soul\n' + soul);

    const identity = loadIdentityFile(agentDir, 'IDENTITY.md');
    if (identity) parts.push('\n## Identity\n' + identity);

    const user = loadIdentityFile(agentDir, 'USER.md');
    if (user) parts.push('\n## User\n' + user);
  }

  if (context) {
    parts.push('\n## Context\n' + context);
  }
  if (skills.length > 0) {
    parts.push('\n## Skills\nSkills directory: ./skills\n' + skills.join('\n---\n'));
  }

  return parts.join('\n');
}
```

Add `existsSync` to the `node:fs` import.

**Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/agent/runner.test.ts -t "identity files" -v`
Expected: All 4 tests PASS.

**Step 5: Commit**

```bash
git add src/agent/runner.ts tests/agent/runner.test.ts
git commit -m "feat: load identity files (SOUL.md, IDENTITY.md, USER.md) into system prompt"
```

---

### Task 5: Pass `agentDir` From Server to Agent Runner

**Files:**
- Modify: `src/host/server.ts`
- Modify: `src/agent/runner.ts` (parseArgs)
- Test: `tests/host/server.test.ts`

**Step 1: Write failing test**

Add to `tests/host/server.test.ts`:

```typescript
test('spawn command includes --agent-dir flag', async () => {
  // Send a message and verify the spawn command includes the agent directory
  const res = await sendRequest(socketPath, '/v1/chat/completions', {
    body: {
      model: 'test',
      messages: [{ role: 'user', content: 'hello' }],
    },
  });

  expect(res.status).toBe(200);
  // The spawn command should include --agent-dir pointing to agents/assistant
  // (verified via verbose output or debug log)
});
```

**Step 2: Add `--agent-dir` to spawn command in `src/host/server.ts`**

In `processCompletion`, after line ~339 where `agentType` is determined:

```typescript
const agentName = 'assistant'; // TODO: resolve from config or request
const agentDir = resolve('agents', agentName);
```

Add `'--agent-dir', agentDir` to the `spawnCommand` array (line ~352):

```typescript
const spawnCommand = [tsxBin, resolve('src/agent/runner.ts'),
  '--agent', agentType,
  '--ipc-socket', ipcSocketPath,
  '--workspace', workspace,
  '--skills', wsSkillsDir,
  '--max-tokens', String(maxTokens),
  '--agent-dir', agentDir,
  ...(proxySocketPath ? ['--proxy-socket', proxySocketPath] : []),
  ...(opts.verbose ? ['--verbose'] : []),
];
```

Also pass `agentDir` and `profile` to `createIPCHandler`:

```typescript
const handler = createIPCHandler(providers, {
  // ... existing opts ...
  agentDir,
  profile: config.profile,
});
```

**Step 3: Parse `--agent-dir` in agent runner**

In `src/agent/runner.ts`, add to `AgentConfig`:

```typescript
interface AgentConfig {
  // ... existing fields ...
  agentDir?: string;
}
```

In `parseArgs()`, add:

```typescript
let agentDir = '';
// ... in the for loop:
} else if (args[i] === '--agent-dir') {
  agentDir = args[++i];
}
// ... in the return:
return { ..., agentDir: agentDir || undefined };
```

**Step 4: Pass `agentDir` to `buildSystemPrompt` calls**

In `runPiCore` (line ~486):

```typescript
const systemPrompt = buildSystemPrompt(context, skills, config.agentDir);
```

Do the same in `runPiSession` if it has its own `buildSystemPrompt` call.

**Step 5: Run tests**

Run: `npx vitest run tests/host/server.test.ts -v`
Expected: All tests PASS.

**Step 6: Commit**

```bash
git add src/host/server.ts src/agent/runner.ts tests/host/server.test.ts
git commit -m "feat: pass agent directory from host to agent runner via --agent-dir flag"
```

---

### Task 6: Create Default BOOTSTRAP.md Template

**Files:**
- Create: `agents/assistant/BOOTSTRAP.md`
- Test: Manual verification — the file is static content

**Step 1: Create the bootstrap template**

Create `agents/assistant/BOOTSTRAP.md`:

```markdown
# Bootstrap

You just came online for the first time. You have no memory, no name, no personality yet. You're about to discover who you are through conversation with your user.

Start by introducing yourself as a blank slate. Be curious, not formal. Through natural dialogue, figure out:

- A name and vibe that fits
- What your user cares about
- What values should guide you
- What tone feels right for this relationship

Don't interrogate. Don't be robotic. Just talk.

When you feel you have a clear picture, use your identity tools to write:

- **SOUL.md** — your values, philosophy, and behavioral boundaries
- **IDENTITY.md** — your name, emoji, vibe, how you present yourself
- **USER.md** — what you've learned about your user

Take your time. You only get born once.
```

**Step 2: Commit**

```bash
git add agents/assistant/BOOTSTRAP.md
git commit -m "feat: add default bootstrap template for agent identity discovery"
```

---

### Task 7: Bootstrap Completion — Delete BOOTSTRAP.md After Identity Written

**Files:**
- Modify: `src/host/ipc-server.ts`
- Test: `tests/host/ipc-server.test.ts`

**Step 1: Write failing test**

```typescript
test('identity_write deletes BOOTSTRAP.md after SOUL.md is written', async () => {
  const agentDir = join(tmpdir(), `ax-test-agent-${randomUUID()}`);
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, 'BOOTSTRAP.md'), '# Bootstrap\nDiscover yourself.');

  const handle = createIPCHandler(mockRegistry(), {
    agentDir,
    profile: 'yolo',
  });

  // Write SOUL.md — this should trigger BOOTSTRAP.md deletion
  await handle(JSON.stringify({
    action: 'identity_write',
    file: 'SOUL.md',
    content: '# Soul\nI am helpful.',
    reason: 'Bootstrap complete',
  }), ctx);

  expect(existsSync(join(agentDir, 'BOOTSTRAP.md'))).toBe(false);
  expect(existsSync(join(agentDir, 'SOUL.md'))).toBe(true);

  rmSync(agentDir, { recursive: true });
});

test('identity_write does not delete BOOTSTRAP.md for non-SOUL files', async () => {
  const agentDir = join(tmpdir(), `ax-test-agent-${randomUUID()}`);
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, 'BOOTSTRAP.md'), '# Bootstrap');

  const handle = createIPCHandler(mockRegistry(), {
    agentDir,
    profile: 'yolo',
  });

  await handle(JSON.stringify({
    action: 'identity_write',
    file: 'IDENTITY.md',
    content: '# Identity\nName: Crabby',
    reason: 'Bootstrap in progress',
  }), ctx);

  // BOOTSTRAP.md should still exist — only SOUL.md triggers deletion
  expect(existsSync(join(agentDir, 'BOOTSTRAP.md'))).toBe(true);

  rmSync(agentDir, { recursive: true });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/host/ipc-server.test.ts -t "BOOTSTRAP" -v`
Expected: FAIL — handler doesn't delete BOOTSTRAP.md.

**Step 3: Add bootstrap cleanup to `identity_write` handler**

In `src/host/ipc-server.ts`, modify the `identity_write` handler:

```typescript
    identity_write: async (req, ctx) => {
      const filePath = join(agentDir, req.file);
      writeFileSync(filePath, req.content, 'utf-8');

      // Bootstrap completion: delete BOOTSTRAP.md when SOUL.md is written
      if (req.file === 'SOUL.md') {
        const bootstrapPath = join(agentDir, 'BOOTSTRAP.md');
        try { unlinkSync(bootstrapPath); } catch { /* may not exist */ }
      }

      await providers.audit.log({
        action: 'identity_write',
        sessionId: ctx.sessionId,
        details: { file: req.file, reason: req.reason },
        timestamp: new Date(),
      });
      return { written: req.file };
    },
```

Add `unlinkSync` to the `node:fs` import.

**Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/host/ipc-server.test.ts -t "BOOTSTRAP" -v`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/host/ipc-server.ts tests/host/ipc-server.test.ts
git commit -m "feat: delete BOOTSTRAP.md when SOUL.md is written (bootstrap completion)"
```

---

### Task 8: Add `ax bootstrap` CLI Command

**Files:**
- Modify: `src/cli/index.ts`
- Create: `src/cli/bootstrap.ts`
- Test: `tests/cli/bootstrap.test.ts`

**Step 1: Write failing test**

Create `tests/cli/bootstrap.test.ts`:

```typescript
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

describe('bootstrap command', () => {
  let agentDir: string;

  beforeEach(() => {
    agentDir = join(tmpdir(), `ax-test-bootstrap-${randomUUID()}`);
    mkdirSync(agentDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(agentDir, { recursive: true, force: true });
  });

  test('resetAgent deletes SOUL.md, IDENTITY.md, USER.md', async () => {
    writeFileSync(join(agentDir, 'SOUL.md'), '# Old soul');
    writeFileSync(join(agentDir, 'IDENTITY.md'), '# Old identity');
    writeFileSync(join(agentDir, 'USER.md'), '# Old user');
    writeFileSync(join(agentDir, 'AGENT.md'), '# Rules');

    const { resetAgent } = await import('../../src/cli/bootstrap.js');
    await resetAgent(agentDir);

    expect(existsSync(join(agentDir, 'SOUL.md'))).toBe(false);
    expect(existsSync(join(agentDir, 'IDENTITY.md'))).toBe(false);
    expect(existsSync(join(agentDir, 'USER.md'))).toBe(false);
    // AGENT.md should NOT be deleted
    expect(existsSync(join(agentDir, 'AGENT.md'))).toBe(true);
  });

  test('resetAgent copies default BOOTSTRAP.md', async () => {
    const { resetAgent } = await import('../../src/cli/bootstrap.js');
    await resetAgent(agentDir);

    expect(existsSync(join(agentDir, 'BOOTSTRAP.md'))).toBe(true);
    const content = readFileSync(join(agentDir, 'BOOTSTRAP.md'), 'utf-8');
    expect(content).toContain('Bootstrap');
  });

  test('resetAgent is idempotent (no error if files missing)', async () => {
    const { resetAgent } = await import('../../src/cli/bootstrap.js');
    // No files exist — should not throw
    await expect(resetAgent(agentDir)).resolves.not.toThrow();
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/cli/bootstrap.test.ts -v`
Expected: FAIL — module not found.

**Step 3: Create `src/cli/bootstrap.ts`**

```typescript
import { existsSync, unlinkSync, copyFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const IDENTITY_FILES = ['SOUL.md', 'IDENTITY.md', 'USER.md'];
const DEFAULT_BOOTSTRAP = resolve('agents/assistant/BOOTSTRAP.md');

export async function resetAgent(agentDir: string): Promise<void> {
  // Delete evolvable identity files
  for (const file of IDENTITY_FILES) {
    try { unlinkSync(join(agentDir, file)); } catch { /* may not exist */ }
  }

  // Copy fresh BOOTSTRAP.md template
  mkdirSync(agentDir, { recursive: true });
  const bootstrapSrc = existsSync(DEFAULT_BOOTSTRAP)
    ? DEFAULT_BOOTSTRAP
    : resolve('agents/assistant/BOOTSTRAP.md');

  if (existsSync(bootstrapSrc)) {
    copyFileSync(bootstrapSrc, join(agentDir, 'BOOTSTRAP.md'));
  }
}

export async function runBootstrap(args: string[]): Promise<void> {
  const agentName = args[0] || 'assistant';
  const agentDir = resolve('agents', agentName);

  if (!existsSync(agentDir)) {
    console.error(`Agent directory not found: ${agentDir}`);
    process.exit(1);
  }

  const hasSoul = existsSync(join(agentDir, 'SOUL.md'));
  if (hasSoul) {
    // Prompt for confirmation before destructive action
    const readline = await import('node:readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>(resolve => {
      rl.question(
        `This will erase ${agentName}'s personality and start fresh. Continue? (y/N) `,
        resolve,
      );
    });
    rl.close();

    if (answer.toLowerCase() !== 'y') {
      console.log('Cancelled.');
      return;
    }
  }

  await resetAgent(agentDir);
  console.log(`[bootstrap] Reset complete. Run 'ax chat' to begin the bootstrap ritual.`);
}
```

**Step 4: Register in CLI router**

In `src/cli/index.ts`:

1. Add `'bootstrap'` to `knownCommands` set (line 102).
2. Add `bootstrap?: (args: string[]) => Promise<void>;` to `CommandHandlers` (line ~15).
3. Add case in `routeCommand` switch:
```typescript
    case 'bootstrap':
      if (handlers.bootstrap) await handlers.bootstrap(args.slice(1));
      break;
```
4. Add handler in `main()`:
```typescript
    bootstrap: async (bootstrapArgs) => {
      const { runBootstrap } = await import('./bootstrap.js');
      await runBootstrap(bootstrapArgs);
    },
```
5. Update help text to include:
```
  ax bootstrap [agent]    Reset agent identity and re-run bootstrap
```

**Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/cli/bootstrap.test.ts -v`
Expected: All 3 tests PASS.

**Step 6: Commit**

```bash
git add src/cli/bootstrap.ts src/cli/index.ts tests/cli/bootstrap.test.ts
git commit -m "feat: add 'ax bootstrap' CLI command for agent identity reset"
```

---

### Task 9: Add `identity_propose` to Sensitive Actions (Taint Budget)

**Files:**
- Modify: `src/host/taint-budget.ts`
- Test: `tests/host/taint-budget.test.ts`

**Step 1: Write failing test**

Add to `tests/host/taint-budget.test.ts`:

```typescript
test('identity_propose is a sensitive action', () => {
  const tb = new TaintBudget({ threshold: 0.10 });
  tb.recordContent('s1', 'external data from internet', true);
  tb.recordContent('s1', 'a', false); // small user content to push ratio > 10%

  const check = tb.checkAction('s1', 'identity_propose');
  expect(check.allowed).toBe(false);
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/host/taint-budget.test.ts -t "identity_propose" -v`
Expected: FAIL — `identity_propose` not in sensitive actions.

**Step 3: Add to sensitive actions**

In `src/host/taint-budget.ts`, add `'identity_propose'` to `DEFAULT_SENSITIVE_ACTIONS` (line ~33):

```typescript
const DEFAULT_SENSITIVE_ACTIONS = new Set([
  'oauth_call',
  'skill_propose',
  'browser_navigate',
  'scheduler_add_cron',
  'identity_propose',
]);
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/host/taint-budget.test.ts -v`
Expected: All tests PASS.

**Step 5: Commit**

```bash
git add src/host/taint-budget.ts tests/host/taint-budget.test.ts
git commit -m "feat: add identity_propose to sensitive actions for taint budget gating"
```

---

### Task 10: Integration Test — Bootstrap End-to-End

**Files:**
- Create: `tests/integration/bootstrap.test.ts`

**Step 1: Write integration test**

```typescript
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { buildSystemPrompt } from '../../src/agent/runner.js';

describe('bootstrap integration', () => {
  let agentDir: string;

  beforeEach(() => {
    agentDir = join(tmpdir(), `ax-test-bootstrap-int-${randomUUID()}`);
    mkdirSync(agentDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(agentDir, { recursive: true, force: true });
  });

  test('bootstrap mode activates when SOUL.md missing and BOOTSTRAP.md present', () => {
    writeFileSync(join(agentDir, 'AGENT.md'), '# Rules\nBe safe.');
    writeFileSync(join(agentDir, 'BOOTSTRAP.md'), '# Bootstrap\nDiscover yourself.');

    const prompt = buildSystemPrompt('', [], agentDir);

    // Should use BOOTSTRAP.md content, not AGENT.md
    expect(prompt).toContain('Discover yourself');
    expect(prompt).not.toContain('Be safe');
  });

  test('normal mode activates when SOUL.md exists', () => {
    writeFileSync(join(agentDir, 'AGENT.md'), '# Rules\nBe safe.');
    writeFileSync(join(agentDir, 'SOUL.md'), '# Soul\nI value truth.');
    writeFileSync(join(agentDir, 'BOOTSTRAP.md'), '# Bootstrap\nDiscover yourself.');

    const prompt = buildSystemPrompt('', [], agentDir);

    // Should use AGENT.md + SOUL.md, not BOOTSTRAP.md
    expect(prompt).toContain('Be safe');
    expect(prompt).toContain('I value truth');
    expect(prompt).not.toContain('Discover yourself');
  });

  test('system prompt assembly order: AGENT > SOUL > IDENTITY > USER > context > skills', () => {
    writeFileSync(join(agentDir, 'AGENT.md'), 'AGENT_MARKER');
    writeFileSync(join(agentDir, 'SOUL.md'), 'SOUL_MARKER');
    writeFileSync(join(agentDir, 'IDENTITY.md'), 'IDENTITY_MARKER');
    writeFileSync(join(agentDir, 'USER.md'), 'USER_MARKER');

    const prompt = buildSystemPrompt('CONTEXT_MARKER', ['SKILL_MARKER'], agentDir);

    const agentPos = prompt.indexOf('AGENT_MARKER');
    const soulPos = prompt.indexOf('SOUL_MARKER');
    const identityPos = prompt.indexOf('IDENTITY_MARKER');
    const userPos = prompt.indexOf('USER_MARKER');
    const contextPos = prompt.indexOf('CONTEXT_MARKER');
    const skillPos = prompt.indexOf('SKILL_MARKER');

    expect(agentPos).toBeLessThan(soulPos);
    expect(soulPos).toBeLessThan(identityPos);
    expect(identityPos).toBeLessThan(userPos);
    expect(userPos).toBeLessThan(contextPos);
    expect(contextPos).toBeLessThan(skillPos);
  });

  test('graceful fallback when no agent directory', () => {
    const prompt = buildSystemPrompt('context', [], undefined);
    expect(prompt).toContain('You are AX');
  });
});
```

**Step 2: Run tests**

Run: `npx vitest run tests/integration/bootstrap.test.ts -v`
Expected: All 4 tests PASS.

**Step 3: Commit**

```bash
git add tests/integration/bootstrap.test.ts
git commit -m "test: add bootstrap integration tests for system prompt assembly"
```

---

### Task 11: Export `buildSystemPrompt` and Update pi-session Runner

**Files:**
- Modify: `src/agent/runner.ts` (export)
- Modify: `src/agent/runners/pi-session.ts` (pass agentDir)

**Step 1: Export `buildSystemPrompt` from runner.ts**

Add `export` keyword to `buildSystemPrompt` function and `loadIdentityFile`:

```typescript
export function buildSystemPrompt(context: string, skills: string[], agentDir?: string): string {
```

**Step 2: Update pi-session to use agentDir**

In `src/agent/runners/pi-session.ts`, import and use `buildSystemPrompt` from runner, or replicate the pattern. Pass `config.agentDir` through.

Check if pi-session has its own system prompt construction — if so, update it to also accept `agentDir` and inject identity files.

**Step 3: Run all agent tests**

Run: `npx vitest run tests/agent/ -v`
Expected: All tests PASS.

**Step 4: Commit**

```bash
git add src/agent/runner.ts src/agent/runners/pi-session.ts
git commit -m "feat: export buildSystemPrompt, update pi-session to use agentDir"
```

---

### Task 12: Final Verification

**Step 1: Run full test suite**

Run: `npx vitest run -v`
Expected: All tests PASS.

**Step 2: Verify TypeScript compilation**

Run: `npm run build`
Expected: Compiles without new errors.

**Step 3: Update journal and lessons**

Append entries to `.claude/journal.md` and `.claude/lessons.md` if applicable.

**Step 4: Final commit (if any remaining changes)**

```bash
git add .claude/journal.md .claude/lessons.md
git commit -m "docs: update journal and lessons for bootstrap and soul evolution"
```
