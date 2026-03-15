# Local Sandbox Execution — Unified Agent Container Architecture

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Simplify the container architecture to a single agent container that provisions its own workspace, executes tools locally, and cleans up on exit — consistent across docker, apple, and k8s runtimes. Eliminate ephemeral tool containers, sandbox-worker pods, NATS sandbox dispatch, and legacy process-level sandbox providers.

**Architecture:** Every agent runs inside a container with a three-phase lifecycle: **provision** (with network) → **run** (no network, tools execute locally) → **cleanup** (with network). The host orchestrates the phases. A host-side audit gate approves every tool call before the agent executes it locally, preserving a tamper-proof pre-execution audit log with a hook point for future policy enforcement (Option A+).

**Tech Stack:** TypeScript, Zod (IPC schemas), Node.js child_process (`execFileSync('sh', ['-c', cmd])`)

---

## Architecture Overview

### Container Simplification

**Before:** 3 container images + ephemeral containers + sandbox-worker pods

| Component | Purpose |
|-----------|---------|
| `container/agent/Dockerfile` | Host process, agent-runtime, pool-controller |
| `container/sandbox/Dockerfile` | Sandbox-worker pods (NATS tool dispatch) |
| `container/browser/Dockerfile` | Browser automation |
| Ephemeral containers | Per-tool-call containers (docker/apple) |
| Sandbox-worker pods | NATS-based tool execution (k8s) |

**After:** 2 container images, no ephemeral containers, no sandbox-worker pods

| Component | Purpose |
|-----------|---------|
| `container/agent/Dockerfile` | Host + agent (provision/run/cleanup phases) |
| `container/browser/Dockerfile` | Browser automation |

### Three-Phase Agent Lifecycle

```
Phase 1: PROVISION (with network)
  Container starts → GCS restore / git clone → scope provisioning → snapshot hashes

Phase 2: RUN (no network)
  Agent process starts → LLM loop → tools execute locally → IPC for audit + non-sandbox tools

Phase 3: CLEANUP (with network)
  Agent exits → diff scopes → upload changes to GCS → git push → delete workspace
```

### Runtime Orchestration

**Docker:**
```bash
docker run --rm -v ws:/workspace ax/agent provision --session=xxx --gcs-prefix=...
docker run --rm --network=none -v ws:/workspace ax/agent run --agent=pi-coding-agent ...
docker run --rm -v ws:/workspace ax/agent cleanup --session=xxx --gcs-prefix=...
```

**Apple:**
```bash
container run -v ws:/workspace ax/agent provision ...
container run --no-network -v ws:/workspace ax/agent run ...
container run -v ws:/workspace ax/agent cleanup ...
```

**K8s:**
```yaml
initContainers:
  - name: provision
    image: ax/agent
    command: [node, dist/agent/workspace-cli.js, provision, ...]
containers:
  - name: agent
    image: ax/agent
    command: [node, dist/agent/runner.js, ...]
    # NetworkPolicy: deny egress
  # preStop hook or sidecar for cleanup
```

### Sandbox Provider Simplification

**Before:** 7 providers — `subprocess`, `seatbelt`, `nsjail`, `bwrap`, `docker`, `apple`, `k8s`

**After:** 3 providers — `subprocess`, `docker`, `apple`

| Provider | Use case |
|----------|----------|
| `subprocess` | Local dev, testing, k8s agent-runtime (already inside a pod) |
| `docker` | Production on Linux/macOS with Docker |
| `apple` | Production on macOS with Apple Virtualization.framework |

K8s uses `subprocess` inside the agent pod (the pod IS the container boundary).

### Audit Gate Protocol (Option A)

```
Agent → IPC: {action: "sandbox_approve", operation: "bash", command: "ls -F"}
Host  → audit.log({action: "sandbox_approve", operation: "bash", command: "ls -F"})
Host  → [future: policy check — Option A+]
Host  → IPC reply: {approved: true}
Agent → execFileSync("sh", ["-c", "ls -F"]) locally
Agent → IPC: {action: "sandbox_result", operation: "bash", output: "...", exitCode: 0}
Host  → audit.log({action: "sandbox_result", ...})
```

### Resource Tiers

| Tier | vCPU | Memory | Use case |
|------|------|--------|----------|
| `default` | 1 | 256 MB | Normal agent work |
| `heavy` | 4 | 2048 MB | Intensive tasks (compilation, data processing) |

Delegated agents can request `heavy` tier via `resourceTier` field on `agent_delegate`.

---

## Code Removal Inventory

### Files to DELETE

| File | Lines | Reason |
|------|-------|--------|
| `src/sandbox-worker/main.ts` | 11 | NATS worker entry point |
| `src/sandbox-worker/types.ts` | 145 | NATS dispatch protocol types |
| `src/sandbox-worker/worker.ts` | 348 | NATS queue subscriber + tool execution |
| `src/sandbox-worker/workspace.ts` | 345 | Workspace provisioning (migrated to `src/agent/workspace.ts`) |
| `src/host/nats-sandbox-dispatch.ts` | 249 | NATS pod dispatcher |
| `src/host/local-sandbox-dispatch.ts` | 99 | Local ephemeral container spawning |
| `src/providers/sandbox/seatbelt.ts` | ~150 | macOS sandbox-exec (deprecated by Apple) |
| `src/providers/sandbox/nsjail.ts` | ~180 | Linux namespace jail |
| `src/providers/sandbox/bwrap.ts` | ~200 | Bubblewrap sandbox |
| `container/sandbox/Dockerfile` | 27 | Sandbox worker image |
| `tests/sandbox-worker/*` | ~300 | Worker tests (migrate workspace tests) |
| `tests/host/nats-sandbox-dispatch.test.ts` | ~100 | NATS dispatcher tests |
| `tests/host/local-sandbox-dispatch.test.ts` | ~50 | Local dispatcher tests |
| `tests/providers/sandbox/nsjail.test.ts` | ~80 | nsjail tests |
| `tests/providers/sandbox/bwrap.test.ts` | ~80 | bwrap tests |

### Files to MODIFY

| File | Change |
|------|--------|
| `src/host/ipc-handlers/sandbox-tools.ts` | Remove `execInContainer`, NATS dispatch, container dispatch paths. Add audit gate handlers. |
| `src/host/ipc-server.ts` | Remove `natsDispatcher`, `requestIdMap`, `containerSandbox` from options |
| `src/host/server.ts` | Remove `containerSandbox` setup. Update `handleDelegate` for resource tiers. |
| `src/host/server-completions.ts` | Three-phase orchestration. Remove hardcoded subprocess log. Add `cpus` to sandboxConfig. |
| `src/host/agent-runtime-process.ts` | Remove NATS dispatcher init. Agent runs as subprocess (pod is the boundary). |
| `src/host/provider-map.ts` | Remove seatbelt, nsjail, bwrap entries |
| `src/providers/sandbox/docker.ts` | Three-phase orchestration (provision/run/cleanup commands). Remove `--entrypoint` override. Add `cpus` config. |
| `src/providers/sandbox/apple.ts` | Same as docker.ts |
| `src/providers/sandbox/types.ts` | Add `cpus` to `SandboxConfig` |
| `src/agent/ipc-tools.ts` | Route sandbox tools to local executor when in container |
| `src/agent/runners/pi-session.ts` | Pass `localSandbox` option when in container |
| `src/agent/mcp-server.ts` | Same as pi-session.ts |
| `src/agent/runner.ts` | Add `provision` and `cleanup` subcommands |
| `src/ipc-schemas.ts` | Add `sandbox_approve`/`sandbox_result` schemas. Add `resourceTier` to delegate. |
| `src/types.ts` | Add tier config to sandbox type |
| `src/config.ts` | Add tier config schema |
| `src/agent/tool-catalog.ts` | Add `resourceTier` to delegate tool |
| `src/onboarding/prompts.ts` | Remove seatbelt/nsjail/bwrap options |
| `src/agent/prompt/types.ts` | Update sandboxType comment |
| `container/agent/Dockerfile` | Add `git` (was only in sandbox image) |
| `.github/workflows/ci.yml` | Remove ax-sandbox image build |
| `charts/ax/templates/_presets.tpl` | Remove sandbox tier definitions |
| `tests/host/ipc-handlers/sandbox-tools.test.ts` | Remove NATS/container dispatch tests. Add audit gate tests. |

**Total:** ~3,500 lines deleted, ~2,000 lines modified, ~500 lines new code

---

## Implementation Tasks

### Task 1: Unified IPC schemas for audit gate

**Files:**
- Modify: `src/ipc-schemas.ts`

**Step 1: Add audit gate schemas**

After the existing sandbox tool schemas (~line 402), add a unified approve/result pair using an `operation` discriminator:

```typescript
// ── Sandbox Audit Gate (container-local execution) ─────────

export const SandboxApproveSchema = ipcAction('sandbox_approve', {
  operation: z.enum(['bash', 'read', 'write', 'edit']),
  command: safeString(100_000).optional(),
  path: safeString(1024).optional(),
  content: safeString(500_000).optional(),
  old_string: safeString(500_000).optional(),
  new_string: safeString(500_000).optional(),
});

export const SandboxResultSchema = ipcAction('sandbox_result', {
  operation: z.enum(['bash', 'read', 'write', 'edit']),
  command: safeString(100_000).optional(),
  path: safeString(1024).optional(),
  output: safeString(500_000).optional(),
  exitCode: z.number().int().optional(),
  success: z.boolean().optional(),
  error: safeString(10_000).optional(),
});
```

Register both in the `IPC_SCHEMAS` map.

**Step 2: Run tests**

Run: `npm test -- --bail tests/ipc-schema.test.ts`

**Step 3: Commit**

```
feat: add unified sandbox_approve/sandbox_result IPC schemas for audit gate
```

---

### Task 2: Host-side audit gate handlers

**Files:**
- Modify: `src/host/ipc-handlers/sandbox-tools.ts`
- Modify: `tests/host/ipc-handlers/sandbox-tools.test.ts`

**Step 1: Write failing tests**

Test `sandbox_approve`:
- Send `{operation: "bash", command: "ls"}` → expect `audit.log()` called, response `{approved: true}`
- Send `{operation: "read", path: "foo.txt"}` → expect `audit.log()` called, response `{approved: true}`

Test `sandbox_result`:
- Send `{operation: "bash", command: "ls", output: "file1", exitCode: 0}` → expect `audit.log()` called

**Step 2: Run test to verify it fails**

Run: `npm test -- --bail tests/host/ipc-handlers/sandbox-tools.test.ts`

**Step 3: Add handlers to `createSandboxToolHandlers`**

```typescript
sandbox_approve: async (req: any, ctx: IPCContext) => {
  await providers.audit.log({
    action: `sandbox_${req.operation}`,
    sessionId: ctx.sessionId,
    args: {
      ...(req.command ? { command: req.command.slice(0, 200) } : {}),
      ...(req.path ? { path: req.path } : {}),
      mode: 'container-local',
    },
    result: 'approved',
  });
  logger.debug('sandbox_approve', {
    sessionId: ctx.sessionId,
    operation: req.operation,
    ...(req.command ? { command: req.command.slice(0, 100) } : {}),
    ...(req.path ? { path: req.path } : {}),
  });
  // Option A+ hook point: policy check, return {approved: false, reason: "..."}
  return { approved: true };
},

sandbox_result: async (req: any, ctx: IPCContext) => {
  await providers.audit.log({
    action: `sandbox_${req.operation}_result`,
    sessionId: ctx.sessionId,
    args: {
      ...(req.command ? { command: req.command.slice(0, 200) } : {}),
      ...(req.path ? { path: req.path } : {}),
      ...(req.exitCode !== undefined ? { exitCode: req.exitCode } : {}),
      ...(req.success !== undefined ? { success: req.success } : {}),
      mode: 'container-local',
    },
    result: (req.exitCode === 0 || req.success) ? 'success' : 'error',
  });
  return { ok: true };
},
```

**Step 4: Run tests**

Run: `npm test -- --bail tests/host/ipc-handlers/sandbox-tools.test.ts`

**Step 5: Commit**

```
feat: add host-side audit gate handlers for sandbox_approve/sandbox_result
```

---

### Task 3: Agent-side local executor

**Files:**
- Create: `src/agent/local-sandbox.ts`
- Create: `tests/agent/local-sandbox.test.ts`

**Step 1: Write failing tests**

Test bash approval + execution:
1. Mock `ipcClient.call` to return `{approved: true}` for `sandbox_approve`
2. Call `sandbox.bash("echo hello")`
3. Verify `sandbox_approve` was called with `{operation: "bash", command: "echo hello"}`
4. Verify `sandbox_result` was called with output
5. Verify return value is `{output: "hello\n"}`

Test bash denial:
1. Mock `ipcClient.call` to return `{approved: false, reason: "blocked"}`
2. Call `sandbox.bash("rm -rf /")`
3. Verify command was NOT executed
4. Verify return value is `{output: "Denied: blocked"}`

Test file operations (read, write, edit) with same approve/deny pattern.

**Step 2: Implement `src/agent/local-sandbox.ts`**

```typescript
/**
 * Agent-side local sandbox execution — runs tools inside the agent's own
 * container with host audit gate.
 *
 * Protocol per tool call:
 * 1. sandbox_approve → host audits, returns {approved: true/false}
 * 2. Execute locally (only if approved)
 * 3. sandbox_result → host logs outcome (best-effort)
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { IPCClient } from './ipc-client.js';
import { safePath } from '../utils/safe-path.js';

export interface LocalSandboxOptions {
  client: IPCClient;
  workspace: string;
  timeoutMs?: number;
}

export function createLocalSandbox(opts: LocalSandboxOptions) {
  const { client, workspace, timeoutMs = 30_000 } = opts;

  function safeWorkspacePath(relativePath: string): string {
    const segments = relativePath.split(/[/\\]/).filter(Boolean);
    return safePath(workspace, ...segments);
  }

  async function approve(fields: Record<string, unknown>): Promise<{ approved: boolean; reason?: string }> {
    return await client.call({ action: 'sandbox_approve', ...fields }) as any;
  }

  function report(fields: Record<string, unknown>): void {
    client.call({ action: 'sandbox_result', ...fields }).catch(() => {});
  }

  return {
    async bash(command: string): Promise<{ output: string }> {
      const approval = await approve({ operation: 'bash', command });
      if (!approval.approved) {
        return { output: `Denied: ${approval.reason ?? 'denied by host policy'}` };
      }

      let output = '';
      let exitCode = 0;
      try {
        // nosemgrep: javascript.lang.security.detect-child-process — sandbox tool
        output = execFileSync('sh', ['-c', command], {
          cwd: workspace, encoding: 'utf-8', timeout: timeoutMs,
          maxBuffer: 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (err: unknown) {
        const e = err as { stdout?: string; stderr?: string; status?: number };
        output = [e.stdout, e.stderr].filter(Boolean).join('\n') || 'Command failed';
        exitCode = e.status ?? 1;
      }

      report({ operation: 'bash', command, output: output.slice(0, 500_000), exitCode });
      return exitCode !== 0 ? { output: `Exit code ${exitCode}\n${output}` } : { output };
    },

    async readFile(path: string): Promise<{ content?: string; error?: string }> {
      const approval = await approve({ operation: 'read', path });
      if (!approval.approved) return { error: `Denied: ${approval.reason ?? 'denied by host policy'}` };
      try {
        const content = readFileSync(safeWorkspacePath(path), 'utf-8');
        report({ operation: 'read', path, success: true });
        return { content };
      } catch (err: unknown) {
        const error = `Error reading file: ${(err as Error).message}`;
        report({ operation: 'read', path, success: false, error });
        return { error };
      }
    },

    async writeFile(path: string, content: string): Promise<{ written?: boolean; error?: string; path?: string }> {
      const approval = await approve({ operation: 'write', path, content });
      if (!approval.approved) return { error: `Denied: ${approval.reason ?? 'denied by host policy'}` };
      try {
        const abs = safeWorkspacePath(path);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, content, 'utf-8');
        report({ operation: 'write', path, success: true });
        return { written: true, path };
      } catch (err: unknown) {
        const error = `Error writing file: ${(err as Error).message}`;
        report({ operation: 'write', path, success: false, error });
        return { error };
      }
    },

    async editFile(path: string, oldString: string, newString: string): Promise<{ edited?: boolean; error?: string; path?: string }> {
      const approval = await approve({ operation: 'edit', path, old_string: oldString, new_string: newString });
      if (!approval.approved) return { error: `Denied: ${approval.reason ?? 'denied by host policy'}` };
      try {
        const abs = safeWorkspacePath(path);
        const content = readFileSync(abs, 'utf-8');
        if (!content.includes(oldString)) return { error: 'old_string not found in file' };
        writeFileSync(abs, content.replace(oldString, newString), 'utf-8');
        report({ operation: 'edit', path, success: true });
        return { edited: true, path };
      } catch (err: unknown) {
        const error = `Error editing file: ${(err as Error).message}`;
        report({ operation: 'edit', path, success: false, error });
        return { error };
      }
    },
  };
}
```

**Step 3: Run tests**

Run: `npm test -- --bail tests/agent/local-sandbox.test.ts`

**Step 4: Commit**

```
feat: add agent-side local sandbox executor with audit gate
```

---

### Task 4: Workspace provisioning CLI

**Files:**
- Create: `src/agent/workspace-cli.ts` (migrate logic from `src/sandbox-worker/workspace.ts`)
- Create: `tests/agent/workspace-cli.test.ts`

**Step 1: Migrate workspace provisioning**

Move `provisionWorkspace()`, `provisionScope()`, `diffScope()`, `releaseWorkspace()` from `src/sandbox-worker/workspace.ts` into `src/agent/workspace-cli.ts`. Add CLI subcommands:

```typescript
// src/agent/workspace-cli.ts
// Invoked as: node dist/agent/workspace-cli.js provision|cleanup [options]
//
// provision: GCS restore / git clone / scope provisioning / hash snapshot
// cleanup:   diff scopes / upload changes to GCS / git push

import { provisionWorkspace, provisionScope, diffScope, releaseWorkspace } from './workspace.js';

const [,, command, ...args] = process.argv;

if (command === 'provision') {
  // Parse args: --session, --gcs-prefix, --git-url, --ref, etc.
  // Call provisionWorkspace() + provisionScope()
  // Write hash snapshot to /workspace/.ax-hashes.json
}

if (command === 'cleanup') {
  // Read hash snapshot from /workspace/.ax-hashes.json
  // Call diffScope() for each scope
  // Upload changes to GCS
  // Call releaseWorkspace() for git push
}
```

The workspace functions themselves (`provisionWorkspace`, `provisionScope`, etc.) move to `src/agent/workspace.ts` — same code, new location.

**Step 2: Write tests**

Migrate relevant tests from `tests/sandbox-worker/workspace.test.ts`.

**Step 3: Run tests**

Run: `npm test -- --bail tests/agent/workspace-cli.test.ts`

**Step 4: Commit**

```
feat: add workspace-cli for container provision/cleanup phases
```

---

### Task 5: Wire local sandbox into agent tool dispatch

**Files:**
- Modify: `src/agent/ipc-tools.ts`
- Modify: `src/agent/runners/pi-session.ts`
- Modify: `src/agent/mcp-server.ts`

**Step 1: Add `localSandbox` option to `IPCToolsOptions`**

```typescript
export interface IPCToolsOptions {
  userId?: string;
  filter?: ToolFilterContext;
  /** When set, sandbox tools execute locally with host audit gate. */
  localSandbox?: { client: IPCClient; workspace: string };
}
```

**Step 2: Intercept sandbox tools in `execute`**

In the `execute` function, before the generic `ipcCall` path:

```typescript
if (opts?.localSandbox && spec.category === 'sandbox') {
  const sandbox = createLocalSandbox({
    client: opts.localSandbox.client,
    workspace: opts.localSandbox.workspace,
  });
  const action = spec.singletonAction ?? spec.name;
  switch (action) {
    case 'sandbox_bash':
      return text(JSON.stringify(await sandbox.bash(p.command as string)));
    case 'sandbox_read_file':
      return text(JSON.stringify(await sandbox.readFile(p.path as string)));
    case 'sandbox_write_file':
      return text(JSON.stringify(await sandbox.writeFile(p.path as string, p.content as string)));
    case 'sandbox_edit_file':
      return text(JSON.stringify(await sandbox.editFile(p.path as string, p.old_string as string, p.new_string as string)));
  }
}
```

**Step 3: Pass `localSandbox` from runners when in container**

In `pi-session.ts` and `mcp-server.ts`:

```typescript
const CONTAINER_SANDBOXES = new Set(['docker', 'apple', 'k8s']);
const useLocalSandbox = CONTAINER_SANDBOXES.has(config.sandboxType ?? '');

const toolOpts: IPCToolsOptions = {
  userId: config.userId,
  filter: toolFilterCtx,
  ...(useLocalSandbox ? {
    localSandbox: { client, workspace: config.workspace },
  } : {}),
};
```

**Step 4: Run full test suite**

Run: `npm test -- --bail`

**Step 5: Commit**

```
feat: route sandbox tools to local executor when agent runs in container
```

---

### Task 6: Three-phase orchestration in sandbox providers

**Files:**
- Modify: `src/providers/sandbox/docker.ts`
- Modify: `src/providers/sandbox/apple.ts`
- Modify: `src/host/server-completions.ts`

**Step 1: Update sandbox providers for three-phase spawn**

The `spawn()` method on docker/apple providers currently runs one container. Update to support three phases when GCS workspace config is present.

Add a `spawnWithProvisioning()` method (or have the host call `spawn()` three times with different commands):

```typescript
// Host orchestrates three phases:
// 1. provision phase (with network)
await sandbox.spawn({ ...config, command: ['node', 'dist/agent/workspace-cli.js', 'provision', ...], network: true });
// 2. run phase (no network) — existing behavior
const proc = await sandbox.spawn({ ...config, command: spawnCommand, network: false });
// 3. cleanup phase (with network) — after agent exits
await sandbox.spawn({ ...config, command: ['node', 'dist/agent/workspace-cli.js', 'cleanup', ...], network: true });
```

For Docker, the three containers share a named volume. For Apple, same via `-v`.

Add `network?: boolean` to `SandboxConfig`. Docker provider uses `--network=none` only when `network: false` (default). Apple provider uses equivalent.

**Step 2: Update `processCompletion` to orchestrate phases**

In `server-completions.ts`, when `isContainerSandbox` and workspace config includes GCS:

```typescript
// Phase 1: Provision (with network)
if (isContainerSandbox && workspaceConfig?.gitUrl) {
  await agentSandbox.spawn({
    ...sandboxConfig,
    command: ['node', 'dist/agent/workspace-cli.js', 'provision', ...provisionArgs],
    network: true,
  });
}

// Phase 2: Run agent (no network) — existing code
const proc = await agentSandbox.spawn(sandboxConfig);

// Phase 3: Cleanup (with network) — in finally block
if (isContainerSandbox && workspaceConfig?.gitUrl) {
  await agentSandbox.spawn({
    ...sandboxConfig,
    command: ['node', 'dist/agent/workspace-cli.js', 'cleanup', ...cleanupArgs],
    network: true,
  });
}
```

**Step 3: Run full test suite**

Run: `npm test -- --bail`

**Step 4: Commit**

```
feat: three-phase container orchestration (provision/run/cleanup)
```

---

### Task 7: Add resource tiers to agent delegation

**Files:**
- Modify: `src/ipc-schemas.ts` — add `resourceTier` to `AgentDelegateSchema`
- Modify: `src/host/ipc-server.ts` — add `resourceTier` to `DelegateRequest`
- Modify: `src/host/server.ts` — resolve tier in `handleDelegate`
- Modify: `src/host/server-completions.ts` — pass `cpus` to `sandboxConfig`
- Modify: `src/types.ts` — add tier definitions
- Modify: `src/config.ts` — add tier schema
- Modify: `src/providers/sandbox/types.ts` — add `cpus` to `SandboxConfig`
- Modify: `src/providers/sandbox/docker.ts` — use `config.cpus`
- Modify: `src/providers/sandbox/apple.ts` — use `config.cpus`
- Modify: `src/agent/tool-catalog.ts` — add `resourceTier` to delegate tool

**Step 1: Add `cpus` to SandboxConfig and providers**

In `types.ts`:
```typescript
cpus?: number;
```

In docker.ts and apple.ts, change `'--cpus', '1'` to `'--cpus', String(config.cpus ?? 1)`.

**Step 2: Add tier config**

In `src/types.ts`:
```typescript
sandbox: {
  timeout_sec: number;
  memory_mb: number;
  tiers?: {
    default: { memory_mb: number; cpus: number };
    heavy: { memory_mb: number; cpus: number };
  };
};
```

In `src/config.ts`:
```typescript
tiers: z.strictObject({
  default: z.strictObject({
    memory_mb: z.number().int().min(64).max(8192).default(256),
    cpus: z.number().min(0.5).max(16).default(1),
  }).default({}),
  heavy: z.strictObject({
    memory_mb: z.number().int().min(64).max(8192).default(2048),
    cpus: z.number().min(0.5).max(16).default(4),
  }).default({}),
}).optional(),
```

**Step 3: Add `resourceTier` to delegate schema**

In `src/ipc-schemas.ts`:
```typescript
resourceTier: z.enum(['default', 'heavy']).optional(),
```

In `src/host/ipc-server.ts`, add to `DelegateRequest`:
```typescript
resourceTier?: 'default' | 'heavy';
```

**Step 4: Wire tier into `handleDelegate`**

In `src/host/server.ts`:
```typescript
const tier = req.resourceTier ?? 'default';
const tierConfig = config.sandbox.tiers?.[tier] ?? (tier === 'heavy'
  ? { memory_mb: 2048, cpus: 4 }
  : { memory_mb: config.sandbox.memory_mb, cpus: 1 });

const childConfig: Config = {
  ...config,
  sandbox: { ...config.sandbox, memory_mb: tierConfig.memory_mb },
  ...(req.runner ? { agent: req.runner } : {}),
  ...(req.model ? { models: { default: [req.model] } } : {}),
  ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
  ...(req.timeoutSec ? { sandbox: { ...config.sandbox, timeout_sec: req.timeoutSec, memory_mb: tierConfig.memory_mb } } : {}),
};
```

**Step 5: Update tool catalog**

Add `resourceTier` to agent delegate parameters:
```typescript
resourceTier: Type.Optional(Type.String({
  description: '"default" (1 vCPU, 256MB) or "heavy" (4 vCPU, 2GB) — request more resources for intensive tasks',
})),
```

**Step 6: Run full test suite**

Run: `npm test -- --bail`

**Step 7: Commit**

```
feat: add resource tiers (default/heavy) for agent containers via delegation
```

---

### Task 8: Remove legacy sandbox providers

**Files to delete:**
- `src/providers/sandbox/seatbelt.ts`
- `src/providers/sandbox/nsjail.ts`
- `src/providers/sandbox/bwrap.ts`
- `tests/providers/sandbox/nsjail.test.ts`
- `tests/providers/sandbox/bwrap.test.ts`

**Files to modify:**
- `src/host/provider-map.ts` — remove seatbelt, nsjail, bwrap entries
- `src/onboarding/prompts.ts` — remove from sandbox options, update default
- `src/agent/prompt/types.ts` — update sandboxType comment

**Step 1: Delete provider files and tests**

**Step 2: Remove from provider map**

In `src/host/provider-map.ts`, delete:
```typescript
seatbelt:   '../providers/sandbox/seatbelt.js',
nsjail:     '../providers/sandbox/nsjail.js',
bwrap:      '../providers/sandbox/bwrap.js',
```

**Step 3: Update onboarding**

In `src/onboarding/prompts.ts`:
- Change sandbox options to `['subprocess', 'docker', 'apple']`
- Update default sandbox selection

**Step 4: Run full test suite**

Run: `npm test -- --bail`

**Step 5: Commit**

```
refactor: remove seatbelt, nsjail, bwrap sandbox providers
```

---

### Task 9: Remove ephemeral container and NATS dispatch infrastructure

**Files to delete:**
- `src/host/nats-sandbox-dispatch.ts`
- `src/host/local-sandbox-dispatch.ts`
- `src/sandbox-worker/main.ts`
- `src/sandbox-worker/types.ts`
- `src/sandbox-worker/worker.ts`
- `src/sandbox-worker/workspace.ts` (already migrated in Task 4)
- `tests/host/nats-sandbox-dispatch.test.ts`
- `tests/host/local-sandbox-dispatch.test.ts`
- `tests/sandbox-worker/*`

**Files to modify:**

`src/host/ipc-handlers/sandbox-tools.ts`:
- Delete `execInContainer()` function
- Delete container dispatch path (`if (containerSandbox)`)
- Delete NATS dispatch path (`if (natsDispatcher)`)
- Remove imports for `NATSSandboxDispatcher`, `SandboxToolRequest`, `SandboxProvider`
- Remove `containerSandbox`, `natsDispatcher`, `requestIdMap` from `SandboxToolHandlerOptions`
- Keep local execution path (for subprocess mode) and audit gate handlers

`src/host/ipc-server.ts`:
- Remove `natsDispatcher`, `requestIdMap`, `containerSandbox` from `IPCHandlerOptions`
- Remove import of `NATSSandboxDispatcher`

`src/host/server.ts`:
- Remove `containerSandbox` from `createIPCHandler` call

`src/host/agent-runtime-process.ts`:
- Remove NATS dispatcher creation (`createNATSSandboxDispatcher`)
- Remove `sandboxDispatcher` variable
- Remove import of `nats-sandbox-dispatch`

`src/providers/sandbox/docker.ts`:
- Remove `--entrypoint` override (no more tool containers)

`src/providers/sandbox/apple.ts`:
- Remove `--entrypoint` override (no more tool containers)

**Step 1: Delete files**

**Step 2: Remove imports and references**

**Step 3: Run full test suite**

Run: `npm test -- --bail`

**Step 4: Commit**

```
refactor: remove ephemeral container dispatch and NATS sandbox infrastructure
```

---

### Task 10: Update Dockerfile, CI/CD, and Helm chart

**Files:**
- Modify: `container/agent/Dockerfile` — add `git`
- Delete: `container/sandbox/Dockerfile`
- Modify: `.github/workflows/ci.yml` — remove ax-sandbox image build
- Modify: `charts/ax/templates/_presets.tpl` — remove sandbox tier definitions
- Modify: `flux/staging/helm-release.yaml` — remove sandbox pod tiers
- Modify: `flux/production/helm-release.yaml` — remove sandbox pod tiers

**Step 1: Update agent Dockerfile**

```dockerfile
FROM node:22-slim

# git needed for workspace provisioning (GCS restore, git clone)
RUN apt-get update && apt-get install -y --no-install-recommends git && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /opt/ax
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY dist/ ./dist/
COPY templates/ ./templates/
COPY skills/ ./skills/

RUN groupadd -r ax && useradd -r -g ax -m ax
USER ax

ENTRYPOINT ["node"]
CMD ["dist/host/host-process.js"]
```

**Step 2: Delete sandbox Dockerfile**

**Step 3: Update CI/CD**

Remove `ax-sandbox` from the Docker image build matrix in `.github/workflows/ci.yml`.

**Step 4: Update Helm chart**

Remove sandbox-worker pod tier definitions from `charts/ax/templates/_presets.tpl` and flux helm releases.

**Step 5: Run build**

Run: `npm run build`

**Step 6: Commit**

```
chore: remove sandbox container image, add git to agent image, update CI/Helm
```

---

### Task 11: Update documentation

**Files:**
- Modify: `docs/plans/2026-03-15-agent-in-container-design.md` — mark superseded
- Modify: `README.md` — update sandbox provider list
- Modify: `CLAUDE.md` — update architecture description if needed

**Step 1: Mark old design doc superseded**

Add to top of `docs/plans/2026-03-15-agent-in-container-design.md`:
```markdown
> **Superseded by:** Local sandbox execution plan (2026-03-15-local-sandbox-execution.md).
> Agent containers now execute tools locally with host audit gate.
> Ephemeral tool containers and NATS sandbox-worker pods removed.
```

**Step 2: Update README**

Remove seatbelt, nsjail, bwrap from sandbox provider references. Update architecture description to reflect three-phase container lifecycle.

**Step 3: Run build + tests**

Run: `npm run build && npm test -- --bail`

**Step 4: Commit**

```
docs: update architecture docs for unified agent container model
```

---

## In-Turn Escalation (Future — Not Implemented Here)

In-turn escalation (upgrading a running agent from `default` to `heavy` mid-conversation) is NOT part of this plan. Each `processCompletion` call spawns a fresh container per turn. The tier is set at spawn time.

If needed later:
1. Agent sends IPC: `{action: "sandbox_escalate", tier: "heavy"}`
2. Host kills current container, re-spawns with `heavy` tier config
3. Conversation history is preserved in host memory and re-sent via stdin
4. Agent resumes from where it left off (same turn, higher resources)

Architecturally feasible because the host re-sends full conversation history on every spawn.
