# Agent-in-Container Design

**Date:** 2026-03-15
**Status:** Proposed

## Problem

When using the Docker or Apple container sandbox, agents don't actually run inside
containers. The code in `server-completions.ts` (lines 615-617) overrides the
sandbox provider with subprocess for all container sandboxes except k8s:

```typescript
if (isContainerSandbox && config.providers.sandbox !== 'k8s') {
  const subprocessModule = await import('../providers/sandbox/subprocess.js');
  agentSandbox = await subprocessModule.create(config);
}
```

This means the agent process runs on the host with no isolation, and sandbox tools
(bash, file ops) also run directly on the host.

## Design

Run the agent inside a Docker/Apple container. Tool calls that need isolation
(sandbox_bash) spawn ephemeral containers. IPC-routed tools (web_fetch, memory_*,
etc.) go through the Unix socket to the host with no container spawn needed.

### Architecture

```
+---------------------------------------------+
|  Host Process                               |
|  +---------------+  +--------------------+  |
|  | IPC Server    |  | Sandbox Provider   |  |
|  | (Unix socket) |  | (docker or apple)  |  |
|  +-------+-------+  +--------+-----------+  |
|          |                   |              |
|          | IPC tools         | sandbox_bash  |
|          | (no container)    | (new container|
|          |                   |  per call)    |
+----------+-------------------+--------------+
           |                   |
     +-----+------+    +------+-------+
     | Agent      |    | Tool         |
     | Container  |    | Container    |
     |            |    | (ephemeral)  |
     | - LLM loop |    | - bash cmd   |
     | - IPC clnt |    | - workspace  |
     | - no net   |    | - no net     |
     +------------+    +--------------+
```

### Tool dispatch paths

| Tool category | Path | Container? |
|---|---|---|
| IPC tools (web_fetch, memory_*, identity_*, etc.) | Agent -> IPC socket -> Host | No |
| sandbox_bash | Agent -> IPC -> Host -> spawn container | Yes (new per call) |
| sandbox_read/write/edit_file | Agent -> IPC -> Host -> direct filesystem | No (safePath-protected) |

### Comparison with K8s

| Aspect | K8s | Docker/Apple |
|---|---|---|
| Agent runs in | Agent-runtime pod (subprocess) | Container via sandbox provider |
| Tool dispatch | NATS to sandbox worker pods | Host spawns ephemeral container |
| Transport | NATS | Unix socket IPC |
| LLM proxy | NATS LLM proxy | Credential-injecting proxy (socket-mounted) |

## Changes

### 1. Remove subprocess override for docker/apple

**File:** `src/host/server-completions.ts`

Remove the block that overrides container sandboxes to subprocess. The agent will
be spawned via the Docker/Apple provider's `spawn()`, which already configures:
- `--network=none` / no network (security invariant)
- Workspace volume at `/workspace/scratch` (rw)
- IPC socket mounted (Docker) or bridged via virtio-vsock (Apple)
- Canonical env vars
- Command: `/opt/ax/dist/agent/runner.js`

Keep the subprocess override only for k8s in `agent-runtime-process.ts` (unchanged).

### 2. Pass container sandbox provider to tool handlers

**File:** `src/host/server-completions.ts`

When sandbox is docker/apple, pass the original `providers.sandbox` to the IPC
handler options so sandbox_bash can use it for container dispatch.

**File:** `src/host/ipc-handlers/sandbox-tools.ts`

Add `containerSandbox?: SandboxProvider` to `SandboxToolHandlerOptions`.

### 3. Container dispatch for sandbox_bash

**File:** `src/host/ipc-handlers/sandbox-tools.ts`

Add a container dispatch path between the NATS path and local execution:

```typescript
sandbox_bash: async (req, ctx) => {
  // 1. NATS dispatch (k8s)
  if (natsDispatcher) { ... }

  // 2. Container dispatch (docker/apple)
  if (containerSandbox) {
    const workspace = resolveWorkspace(opts, ctx);
    return execInContainer(containerSandbox, workspace, req.command);
  }

  // 3. Local execution (subprocess/seatbelt/nsjail/bwrap)
  // uses execFileNoThrow for safe command execution
}
```

The `execInContainer` helper spawns an ephemeral container:

```typescript
async function execInContainer(
  sandbox: SandboxProvider,
  workspace: string,
  command: string,
): Promise<{ output: string }> {
  const proc = await sandbox.spawn({
    workspace,
    ipcSocket: '',  // not needed for tool containers
    command: ['sh', '-c', command],
    timeoutSec: 30,
    memoryMB: 256,
  });
  // collect stdout + stderr, wait for exit, return { output }
}
```

### 4. Make ipcSocket optional in container providers

**Files:** `src/providers/sandbox/docker.ts`, `src/providers/sandbox/apple.ts`

Guard the socket mount/bridge with `if (config.ipcSocket)` so tool containers
skip IPC setup. The `SandboxConfig.ipcSocket` type stays as `string` (empty
string = no socket).

### 5. File ops stay on host

`sandbox_read_file`, `sandbox_write_file`, `sandbox_edit_file` continue to
run directly on the host filesystem with safePath protection. The workspace
directory is a local volume shared between host and containers -- no container
spawn needed for file I/O.
