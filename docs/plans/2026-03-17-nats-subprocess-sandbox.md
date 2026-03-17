# NATS Subprocess Sandbox — Local K8s Debugging

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enable local debugging of the full k8s code path (NATS IPC, workspace release via HTTP staging, work delivery) by spawning debuggable local processes instead of k8s pods.

**Architecture:** A test-only sandbox provider (`nats-subprocess`) spawns local child processes with NATS environment variables, causing the agent to use `NATSIPCClient` and the host to use its NATS code path. A standalone test harness script starts the AX server with this provider injected via a new `providerOverrides` option on `createServer()`.

**Tech Stack:** Node.js child_process, NATS (local `nats-server`), existing AX host/agent infrastructure.

---

### Task 1: Add `providerOverrides` to `loadProviders` and `createServer`

**Files:**
- Modify: `src/host/registry.ts:8-13` (LoadProvidersOptions interface + loadProviders signature)
- Modify: `src/host/registry.ts:91-109` (return statement)
- Modify: `src/host/server.ts:51-58` (ServerOptions interface)
- Modify: `src/host/server.ts:142` (loadProviders call)

**Step 1: Add `providerOverrides` to `LoadProvidersOptions` in `registry.ts`**

In `src/host/registry.ts`, update the interface and the return statement:

```typescript
// At line 8-11, update the interface:
export interface LoadProvidersOptions {
  /** Optional PluginHost for loading third-party plugin providers (Phase 3). */
  pluginHost?: PluginHost;
  /** Override specific providers (test/debug only). Applied after all providers are loaded. */
  providerOverrides?: Partial<ProviderRegistry>;
}
```

```typescript
// At line 91-109, update the return to apply overrides:
  const registry: ProviderRegistry = {
    llm:         tracedLlm,
    image,
    memory,
    scanner:     await loadScanner(config, tracedLlm),
    channels,
    web:         await loadProvider('web', config.providers.web, config),
    browser:     await loadProvider('browser', config.providers.browser, config),
    credentials,
    skills,
    audit,
    sandbox:     await loadProvider('sandbox', config.providers.sandbox, config),
    scheduler:   await loadScheduler(config, database, eventbus),
    storage,
    database,
    eventbus,
    workspace,
    screener,
  };

  // Apply test/debug overrides (if any)
  if (opts?.providerOverrides) {
    Object.assign(registry, opts.providerOverrides);
  }

  return registry;
```

**Step 2: Add `providerOverrides` to `ServerOptions` in `server.ts`**

In `src/host/server.ts`, update the interface and the `loadProviders` call:

```typescript
// At line 51-58, add to the interface:
export interface ServerOptions {
  socketPath?: string;
  port?: number;
  daemon?: boolean;
  verbose?: boolean;
  json?: boolean;
  channels?: import('../providers/channel/types.js').ChannelProvider[];
  dedupeWindowMs?: number;
  /** Override specific providers at load time (test/debug only). */
  providerOverrides?: Partial<import('../types.js').ProviderRegistry>;
}
```

```typescript
// At line 142, pass overrides through:
  const providers = await loadProviders(config, { providerOverrides: opts.providerOverrides });
```

**Step 3: Verify the build compiles**

Run: `npm run build`
Expected: Success, no type errors.

**Step 4: Commit**

```bash
git add src/host/registry.ts src/host/server.ts
git commit -m "feat(host): add providerOverrides to createServer for test/debug injection"
```

---

### Task 2: Create the `nats-subprocess` sandbox provider

**Files:**
- Create: `tests/providers/sandbox/nats-subprocess.ts`

**Step 1: Create the provider**

Create `tests/providers/sandbox/nats-subprocess.ts`:

```typescript
/**
 * nats-subprocess sandbox provider — local k8s debugging.
 *
 * Spawns local child processes with NATS environment, exercising the
 * full k8s code path (NATS IPC, workspace release via HTTP staging,
 * work delivery) without needing a real k8s cluster.
 *
 * Usage: See tests/providers/sandbox/run-nats-local.ts
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { SandboxProvider, SandboxConfig, SandboxProcess } from '../../../src/providers/sandbox/types.js';
import type { Config } from '../../../src/types.js';
import { exitCodePromise, enforceTimeout, killProcess } from '../../../src/providers/sandbox/utils.js';
import { createCanonicalSymlinks, symlinkEnv } from '../../../src/providers/sandbox/canonical-paths.js';

const DEFAULT_NATS_URL = 'nats://localhost:4222';

export async function create(config: Config): Promise<SandboxProvider> {
  const natsUrl = process.env.NATS_URL ?? DEFAULT_NATS_URL;
  const hostUrl = process.env.AX_HOST_URL ?? `http://localhost:${process.env.PORT ?? '8080'}`;
  const debugAgent = process.env.AX_DEBUG_AGENT === '1';

  console.log(`[nats-subprocess] NATS: ${natsUrl}, Host: ${hostUrl}, Debug: ${debugAgent}`);

  return {
    async spawn(sandboxConfig: SandboxConfig): Promise<SandboxProcess> {
      const podName = `local-nats-${randomUUID().slice(0, 8)}`;

      // Use symlink fallback (same as subprocess provider — can't remap filesystems)
      const { mountRoot, cleanup } = createCanonicalSymlinks(sandboxConfig);
      const sEnv = symlinkEnv(sandboxConfig, mountRoot);

      // Build command — optionally inject --inspect for debugger
      const [cmd, ...args] = sandboxConfig.command;
      const finalArgs = debugAgent ? ['--inspect-brk', ...args] : args;

      // Filter out AX_IPC_SOCKET from symlink env — NATS replaces Unix sockets
      const { AX_IPC_SOCKET: _, ...filteredEnv } = sEnv;

      const child = spawn(cmd, finalArgs, {
        cwd: mountRoot,
        env: {
          ...process.env,
          ...filteredEnv,
          // NATS transport — makes agent use NATSIPCClient
          AX_IPC_TRANSPORT: 'nats',
          NATS_URL: natsUrl,
          POD_NAME: podName,
          // Host URL for workspace staging uploads
          AX_HOST_URL: hostUrl,
          // Don't suppress logs — we want to see them for debugging
          LOG_LEVEL: process.env.LOG_LEVEL ?? 'debug',
          // Per-turn extra env vars (IPC token, request ID, etc.)
          ...sandboxConfig.extraEnv,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      // Pipe child output to parent for visibility
      child.stdout?.pipe(process.stdout);
      child.stderr?.pipe(process.stderr);

      const exitCode = exitCodePromise(child);
      enforceTimeout(child, sandboxConfig.timeoutSec);

      // Clean up symlinks when the process exits
      exitCode.then(() => cleanup(), () => cleanup());

      console.log(`[nats-subprocess] Spawned pid=${child.pid} podName=${podName}`);

      return {
        pid: child.pid!,
        exitCode,
        stdout: child.stdout!,
        stderr: child.stderr!,
        stdin: child.stdin!,
        kill() { child.kill(); },
        // podName triggers the host's NATS code path
        podName,
      };
    },

    kill: killProcess,

    async isAvailable(): Promise<boolean> {
      return true;
    },
  };
}
```

**Step 2: Verify it compiles**

Run: `npx tsc --noEmit tests/providers/sandbox/nats-subprocess.ts`

If the test directory isn't included in tsconfig, verify with:
Run: `npx tsx --eval "import('./tests/providers/sandbox/nats-subprocess.ts')"`
Expected: No import errors.

**Step 3: Commit**

```bash
git add tests/providers/sandbox/nats-subprocess.ts
git commit -m "feat(test): add nats-subprocess sandbox provider for local k8s debugging"
```

---

### Task 3: Create the test harness script

**Files:**
- Create: `tests/providers/sandbox/run-nats-local.ts`

**Step 1: Create the harness**

Create `tests/providers/sandbox/run-nats-local.ts`:

```typescript
#!/usr/bin/env npx tsx
/**
 * Test harness — run AX host with nats-subprocess sandbox.
 *
 * Exercises the full k8s code path (NATS IPC, workspace release,
 * work delivery) using local processes for easy debugging.
 *
 * Prerequisites:
 *   1. Local nats-server running: `nats-server`
 *   2. AX built: `npm run build`
 *
 * Usage:
 *   npx tsx tests/providers/sandbox/run-nats-local.ts
 *
 * Debug agent process:
 *   AX_DEBUG_AGENT=1 npx tsx tests/providers/sandbox/run-nats-local.ts
 *   # Then attach Chrome DevTools to the --inspect-brk port
 *
 * Debug host process:
 *   node --inspect -e "import('./tests/providers/sandbox/run-nats-local.ts')"
 */

import { loadConfig } from '../../../src/config.js';
import { createServer } from '../../../src/host/server.js';
import { create as createNATSSubprocess } from './nats-subprocess.js';
import { initLogger } from '../../../src/logger.js';

async function main() {
  const port = parseInt(process.env.PORT ?? '8080', 10);

  initLogger({ level: process.env.LOG_LEVEL ?? 'debug' });

  const config = loadConfig();
  const sandbox = await createNATSSubprocess(config);

  console.log('[run-nats-local] Starting AX with nats-subprocess sandbox...');

  const server = await createServer(config, {
    port,
    providerOverrides: { sandbox },
  });

  await server.start();
  console.log(`[run-nats-local] AX listening on http://localhost:${port}`);

  // Graceful shutdown
  const shutdown = async () => {
    console.log('[run-nats-local] Shutting down...');
    await server.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[run-nats-local] Fatal:', err);
  process.exit(1);
});
```

**Step 2: Verify it parses**

Run: `npx tsx --eval "import('./tests/providers/sandbox/run-nats-local.ts')" 2>&1 | head -5`
Expected: Either starts (if NATS is running and config exists) or fails with a clear config/NATS error — not an import error.

**Step 3: Commit**

```bash
git add tests/providers/sandbox/run-nats-local.ts
git commit -m "feat(test): add run-nats-local harness for local k8s debugging"
```

---

### Task 4: Verify end-to-end with a real NATS server

**Step 1: Install and start nats-server (if not already available)**

Run: `brew install nats-server && nats-server &`

**Step 2: Build AX**

Run: `npm run build`

**Step 3: Run the harness**

Run: `npx tsx tests/providers/sandbox/run-nats-local.ts`
Expected: Server starts, logs show `[nats-subprocess]` prefix, no crashes.

**Step 4: Send a test completion request**

Run (in a separate terminal):
```bash
curl -X POST http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"default","messages":[{"role":"user","content":"hello"}]}'
```

Expected: The host uses the NATS code path (`processCompletionWithNATS`), spawns a local process with NATS env, work is delivered via NATS, agent responds via NATS `agent_response`.

**Step 5: Verify debug mode works**

Run: `AX_DEBUG_AGENT=1 npx tsx tests/providers/sandbox/run-nats-local.ts`
Send another request. Expected: Agent spawns with `--inspect-brk`, logs show the debugger URL.

**Step 6: Commit any fixes needed, then final commit**

```bash
git add -A
git commit -m "test: verify nats-subprocess end-to-end with local NATS"
```
