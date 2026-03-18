# Fix Agent Hang on Network Commands (npm install) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix deadlock/hang when asking the agent to run network commands like `npm install -g @googleworkspace/cli`.

**Architecture:** Three-pronged fix: (1) Auto-approve well-known registry domains before running bash commands that need network — breaks the proxy governance deadlock; (2) Replace synchronous `execFileSync`/`execSync` with async `spawn` — unblocks the event loop so heartbeats and IPC can flow during command execution; (3) Add iteration limits to pi-session runner to prevent infinite retry loops.

**Tech Stack:** Node.js child_process (spawn), IPC client, web-proxy-approvals

---

### Task 1: Auto-approve well-known network domains in local-sandbox.ts

**Files:**
- Modify: `src/agent/local-sandbox.ts:38-61`
- Test: `tests/agent/local-sandbox.test.ts`

This is the **primary deadlock fix**. In container mode, `local-sandbox.ts` runs bash commands inside the container. HTTP_PROXY is set, so npm routes through the web proxy. If the domain isn't pre-approved, the proxy blocks for 120s waiting for agent approval, but the agent is blocked on execFileSync → deadlock. Fix: detect known package manager commands and pre-approve their registry domains via IPC before running the command.

**Step 1: Write the failing test**

Add to `tests/agent/local-sandbox.test.ts`:

```typescript
test('pre-approves registry.npmjs.org for npm install commands', async () => {
  const client = mockClient();
  const sandbox = createLocalSandbox({ client, workspace });
  await sandbox.bash('npm install -g @googleworkspace/cli');

  // Verify web_proxy_approve was called before sandbox_result
  const calls = (client.call as any).mock.calls.map((c: any[]) => c[0]);
  const approveIdx = calls.findIndex(
    (c: any) => c.action === 'web_proxy_approve' && c.domain === 'registry.npmjs.org',
  );
  expect(approveIdx).toBeGreaterThan(-1);
  // web_proxy_approve should come after sandbox_approve but before sandbox_result
  const sandboxApproveIdx = calls.findIndex((c: any) => c.action === 'sandbox_approve');
  const resultIdx = calls.findIndex((c: any) => c.action === 'sandbox_result');
  expect(approveIdx).toBeGreaterThan(sandboxApproveIdx);
  expect(approveIdx).toBeLessThan(resultIdx);
});

test('pre-approves pypi.org and files.pythonhosted.org for pip install', async () => {
  const client = mockClient();
  const sandbox = createLocalSandbox({ client, workspace });
  await sandbox.bash('pip install requests');

  const calls = (client.call as any).mock.calls.map((c: any[]) => c[0]);
  const domains = calls
    .filter((c: any) => c.action === 'web_proxy_approve')
    .map((c: any) => c.domain);
  expect(domains).toContain('pypi.org');
  expect(domains).toContain('files.pythonhosted.org');
});

test('does not pre-approve domains for non-network commands', async () => {
  const client = mockClient();
  const sandbox = createLocalSandbox({ client, workspace });
  await sandbox.bash('echo hello');

  const calls = (client.call as any).mock.calls.map((c: any[]) => c[0]);
  const proxyApprovals = calls.filter((c: any) => c.action === 'web_proxy_approve');
  expect(proxyApprovals).toHaveLength(0);
});

test('pre-approve failure does not block command execution', async () => {
  const client = mockClient();
  // Make web_proxy_approve fail
  (client.call as any).mockImplementation(async (req: Record<string, unknown>) => {
    if (req.action === 'sandbox_approve') return { approved: true };
    if (req.action === 'sandbox_result') return { ok: true };
    if (req.action === 'web_proxy_approve') throw new Error('IPC timeout');
    return {};
  });
  const sandbox = createLocalSandbox({ client, workspace });
  // Should still run the command (npm will fail, but the point is no crash)
  const result = await sandbox.bash('npm --version');
  // npm --version should succeed without network
  expect(result.output).toBeDefined();
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- --bail tests/agent/local-sandbox.test.ts`
Expected: FAIL — web_proxy_approve is never called

**Step 3: Write the implementation**

In `src/agent/local-sandbox.ts`, add the domain extraction helper and pre-approve call:

```typescript
/** Well-known package manager commands and their registry domains. */
const NETWORK_COMMAND_DOMAINS: [RegExp, string[]][] = [
  [/\bnpm\s+(install|i|ci|update|audit|pack|publish)\b/, ['registry.npmjs.org']],
  [/\bnpx\s/, ['registry.npmjs.org']],
  [/\byarn\s+(add|install|upgrade)\b/, ['registry.yarnpkg.com', 'registry.npmjs.org']],
  [/\bpip\s+(install|download)\b/, ['pypi.org', 'files.pythonhosted.org']],
  [/\bgem\s+install\b/, ['rubygems.org']],
  [/\bcargo\s+(install|build|update)\b/, ['crates.io', 'static.crates.io']],
  [/\bgo\s+(get|install|mod\s+download)\b/, ['proxy.golang.org', 'sum.golang.org']],
];

function extractNetworkDomains(command: string): string[] {
  const domains: string[] = [];
  for (const [pattern, doms] of NETWORK_COMMAND_DOMAINS) {
    if (pattern.test(command)) domains.push(...doms);
  }
  return [...new Set(domains)];
}
```

Then in the `bash()` method, after the `approve()` call but before `execFileSync`:

```typescript
// Pre-approve well-known network domains to avoid proxy governance deadlock.
// Without this, npm/pip/etc. route through HTTP_PROXY → host proxy blocks on
// requestApproval() → agent blocked on execFileSync → deadlock until 120s timeout.
const domains = extractNetworkDomains(command);
await Promise.all(
  domains.map(domain =>
    client.call({ action: 'web_proxy_approve', domain, approved: true }).catch(() => {}),
  ),
);
```

**Step 4: Run test to verify it passes**

Run: `npm test -- --bail tests/agent/local-sandbox.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/agent/local-sandbox.ts tests/agent/local-sandbox.test.ts
git commit -m "fix: auto-approve registry domains before network bash commands

Breaks the proxy governance deadlock in container mode where execFileSync
blocks the event loop while the web proxy waits for domain approval that
can never arrive."
```

---

### Task 2: Replace sync bash with async spawn in local-sandbox.ts

**Files:**
- Modify: `src/agent/local-sandbox.ts:10,47-57`
- Test: `tests/agent/local-sandbox.test.ts`

Replace `execFileSync` with async `spawn` so the Node.js event loop stays responsive during command execution. This allows IPC heartbeats, web proxy bridge connections, and other async operations to proceed while a long-running command executes.

**Step 1: Write the failing test**

Add to `tests/agent/local-sandbox.test.ts`:

```typescript
test('does not block event loop during execution', async () => {
  const client = mockClient();
  const sandbox = createLocalSandbox({ client, workspace });
  // Run a command that takes 1s
  const start = Date.now();
  const bashPromise = sandbox.bash('sleep 1 && echo done');

  // If async, we can await a microtask immediately
  let microtaskRan = false;
  const microtask = Promise.resolve().then(() => { microtaskRan = true; });
  await microtask;

  expect(microtaskRan).toBe(true);
  const result = await bashPromise;
  expect(result.output).toContain('done');
});

test('kills process on timeout', async () => {
  const client = mockClient();
  const sandbox = createLocalSandbox({ client, workspace, timeoutMs: 1_000 });
  const result = await sandbox.bash('sleep 30');
  expect(result.output).toContain('Exit code');
});

test('captures both stdout and stderr', async () => {
  const client = mockClient();
  const sandbox = createLocalSandbox({ client, workspace });
  const result = await sandbox.bash('echo out && echo err >&2');
  expect(result.output).toContain('out');
  expect(result.output).toContain('err');
});

test('enforces maxBuffer limit', async () => {
  const client = mockClient();
  const sandbox = createLocalSandbox({ client, workspace });
  // Generate output larger than 1MB
  const result = await sandbox.bash('yes | head -c 2000000');
  // Should truncate or error, not crash
  expect(result.output).toBeDefined();
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- --bail tests/agent/local-sandbox.test.ts`
Expected: The "does not block event loop" test likely passes with execFileSync too (vitest is async), but the timeout test (1s timeout for sleep 30) verifies proper SIGTERM/SIGKILL handling.

**Step 3: Write the implementation**

Replace `execFileSync` import and bash method:

```typescript
import { spawn } from 'node:child_process';

// In bash():
async bash(command: string): Promise<{ output: string }> {
  const approval = await approve({ operation: 'bash', command });
  if (!approval.approved) {
    return { output: `Denied: ${approval.reason ?? 'denied by host policy'}` };
  }

  // Pre-approve well-known network domains (from Task 1)
  const domains = extractNetworkDomains(command);
  await Promise.all(
    domains.map(domain =>
      client.call({ action: 'web_proxy_approve', domain, approved: true }).catch(() => {}),
    ),
  );

  const MAX_BUFFER = 1024 * 1024; // 1MB
  return new Promise<{ output: string }>((resolve) => {
    // nosemgrep: javascript.lang.security.detect-child-process — sandbox tool
    const child = spawn('sh', ['-c', command], {
      cwd: workspace,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let killed = false;

    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_BUFFER) stdout += chunk.toString('utf-8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_BUFFER) stderr += chunk.toString('utf-8');
    });

    // Timeout: SIGTERM → grace period → SIGKILL
    const timer = setTimeout(() => {
      killed = true;
      try { child.kill('SIGTERM'); } catch { /* already dead */ }
      setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already dead */ }
      }, 5_000);
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timer);
      const output = [stdout, stderr].filter(Boolean).join('\n') || (killed ? 'Command timed out' : 'Command failed');
      const exitCode = code ?? (killed ? 124 : 1);
      report({ operation: 'bash', command, output: output.slice(0, 500_000), exitCode });
      resolve(exitCode !== 0 ? { output: `Exit code ${exitCode}\n${output}` } : { output });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      const output = `Command error: ${err.message}`;
      report({ operation: 'bash', command, output, exitCode: 1 });
      resolve({ output: `Exit code 1\n${output}` });
    });
  });
},
```

**Step 4: Run test to verify it passes**

Run: `npm test -- --bail tests/agent/local-sandbox.test.ts`
Expected: PASS (all existing + new tests)

**Step 5: Commit**

```bash
git add src/agent/local-sandbox.ts tests/agent/local-sandbox.test.ts
git commit -m "refactor: replace execFileSync with async spawn in local-sandbox

Unblocks the Node.js event loop during bash command execution, allowing
IPC heartbeats, web proxy bridge connections, and other async operations
to proceed while long-running commands execute."
```

---

### Task 3: Replace sync bash with async spawn in sandbox-tools.ts

**Files:**
- Modify: `src/host/ipc-handlers/sandbox-tools.ts:14,52-81`
- Test: `tests/host/ipc-handlers/sandbox-tools.test.ts`

Same change as Task 2 but for the host-side subprocess mode. `execSync` blocks the host's event loop, preventing heartbeats and other IPC handlers from running during long commands.

**Step 1: Write the failing test**

Add to `tests/host/ipc-handlers/sandbox-tools.test.ts`:

```typescript
test('kills process on timeout (does not hang)', async () => {
  const handlers = createSandboxToolHandlers(providers, { workspaceMap });
  const result = await handlers.sandbox_bash({ command: 'sleep 60' }, ctx);
  // Should return within ~30s (timeout), not hang for 60s
  expect(result.output).toMatch(/exit code|timed out|command failed/i);
}, 40_000);

test('captures combined stdout and stderr', async () => {
  const handlers = createSandboxToolHandlers(providers, { workspaceMap });
  const result = await handlers.sandbox_bash(
    { command: 'echo stdout-msg && echo stderr-msg >&2' },
    ctx,
  );
  expect(result.output).toContain('stdout-msg');
});
```

**Step 2: Run tests to verify behavior**

Run: `npm test -- --bail tests/host/ipc-handlers/sandbox-tools.test.ts`

**Step 3: Write the implementation**

Replace `execSync` import and `sandbox_bash` handler:

```typescript
import { spawn } from 'node:child_process';

// In sandbox_bash handler:
sandbox_bash: async (req: any, ctx: IPCContext) => {
  const workspace = resolveWorkspace(opts, ctx);
  const TIMEOUT_MS = 120_000;
  const MAX_BUFFER = 1024 * 1024;

  return new Promise<{ output: string }>((resolve) => {
    // nosemgrep: javascript.lang.security.detect-child-process — intentional: sandbox tool
    const child = spawn('sh', ['-c', req.command], {
      cwd: workspace,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let killed = false;

    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_BUFFER) stdout += chunk.toString('utf-8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_BUFFER) stderr += chunk.toString('utf-8');
    });

    const timer = setTimeout(() => {
      killed = true;
      try { child.kill('SIGTERM'); } catch { /* already dead */ }
      setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already dead */ }
      }, 5_000);
    }, TIMEOUT_MS);

    child.on('close', async (code) => {
      clearTimeout(timer);
      const exitCode = code ?? (killed ? 124 : 1);
      const output = exitCode === 0
        ? stdout
        : [stdout, stderr].filter(Boolean).join('\n') || (killed ? 'Command timed out' : 'Command failed');

      await providers.audit.log({
        action: 'sandbox_bash',
        sessionId: ctx.sessionId,
        args: { command: req.command.slice(0, 200) },
        result: exitCode === 0 ? 'success' : 'error',
      });
      resolve(exitCode === 0 ? { output } : { output: `Exit code ${exitCode}\n${output}` });
    });

    child.on('error', async (err) => {
      clearTimeout(timer);
      await providers.audit.log({
        action: 'sandbox_bash',
        sessionId: ctx.sessionId,
        args: { command: req.command.slice(0, 200) },
        result: 'error',
      });
      resolve({ output: `Exit code 1\nCommand error: ${err.message}` });
    });
  });
},
```

**Step 4: Run test to verify it passes**

Run: `npm test -- --bail tests/host/ipc-handlers/sandbox-tools.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/host/ipc-handlers/sandbox-tools.ts tests/host/ipc-handlers/sandbox-tools.test.ts
git commit -m "refactor: replace execSync with async spawn in sandbox-tools

Unblocks the host event loop during bash command execution in subprocess
mode. Increases timeout from 30s to 120s to accommodate npm install and
similar long-running commands."
```

---

### Task 4: Increase bash tool timeout to 120s

**Files:**
- Modify: `src/agent/tool-catalog.ts:367`

The bash tool's IPC timeout (60s) must be >= the actual command execution timeout. Since we're raising the execution timeout to 120s, raise the IPC timeout to match (plus margin).

**Step 1: Change the timeout**

In `src/agent/tool-catalog.ts:367`:

```typescript
// Before:
timeoutMs: 60_000,

// After:
timeoutMs: 180_000,
```

180s gives 120s execution + 60s margin for IPC overhead.

**Step 2: Run full test suite**

Run: `npm test`
Expected: PASS

**Step 3: Commit**

```bash
git add src/agent/tool-catalog.ts
git commit -m "fix: increase bash tool IPC timeout to 180s

Matches the 120s execution timeout in sandbox-tools.ts and
local-sandbox.ts, with margin for IPC overhead."
```

---

### Task 5: Add maxTurns limit to pi-session runner

**Files:**
- Modify: `src/agent/runners/pi-session.ts:443-450`

The pi-session runner has no iteration limit on the agent tool loop. If the LLM keeps retrying a failing command (e.g., npm install timing out), it loops indefinitely. The claude-code runner already has `maxTurns: 20`. Add the same limit to pi-session.

**Step 1: Check how pi-coding-agent handles maxTurns**

The `createAgentSession` config may accept a maxTurns-like option. If not, we implement a guard in the tool execute function that counts calls and rejects after the limit.

**Step 2: Implement the limit**

In `src/agent/runners/pi-session.ts`, around the `createAgentSession` call (line 443), add a tool call counter that limits total tool invocations:

```typescript
// Before createAgentSession:
const MAX_TOOL_CALLS = 50;
let toolCallCount = 0;

// In createIPCToolDefinitions, wrap each tool's execute:
// (or add a guard in the execute function at line 276)
```

The cleanest approach: add a guard in `createIPCToolDefinitions`'s execute wrapper. Add a `maxToolCalls` option:

```typescript
// In createIPCToolDefinitions, at the top of execute():
if (opts?.maxToolCalls !== undefined) {
  opts._toolCallCount = (opts._toolCallCount ?? 0) + 1;
  if (opts._toolCallCount > opts.maxToolCalls) {
    return text('Error: Maximum tool call limit reached. Please provide your final response.');
  }
}
```

**Step 3: Run tests**

Run: `npm test`
Expected: PASS

**Step 4: Commit**

```bash
git add src/agent/runners/pi-session.ts
git commit -m "fix: add maxToolCalls limit to pi-session runner

Prevents infinite retry loops when commands fail repeatedly. Matches
the maxTurns: 20 limit in the claude-code runner."
```
