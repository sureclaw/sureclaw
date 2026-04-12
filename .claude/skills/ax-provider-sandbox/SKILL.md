---
name: ax-provider-sandbox
description: Use when modifying agent sandbox isolation -- Docker, Apple Container (macOS), or k8s providers in src/providers/sandbox/
---

## Overview

Sandbox providers isolate agent processes with zero network access (by default), no credentials, and mount-only filesystem access. Each provider implements `SandboxProvider` from `src/providers/sandbox/types.ts` and exports `create(config: Config)`.

Agents run INSIDE their containers and execute tools locally. Each agent gets a single `/workspace` directory (rw). In Docker/Apple mode it's bind-mounted from the host. In k8s mode it's backed by a PVC (persistent across pod restarts) or emptyDir (ephemeral).

## Interface

**SandboxConfig** -- passed to `spawn()`:

| Field                    | Type                       | Notes                                                    |
|--------------------------|----------------------------|----------------------------------------------------------|
| workspace                | `string`                   | The single `/workspace` directory (rw mount)             |
| ipcSocket                | `string`                   | Unix socket path for IPC                                 |
| timeoutSec               | `number?`                  | Process timeout                                          |
| memoryMB                 | `number?`                  | Memory limit                                             |
| cpus                     | `number?`                  | CPU limit                                                |
| command                  | `string[]`                 | Command + args to execute                                |
| pvcName                  | `string?`                  | PVC name for persistent workspace (k8s only)             |
| workspaceSizeGi          | `number?`                  | PVC size in GiB (k8s only, default: 10)                  |
| extraEnv                 | `Record<string, string>?`  | Additional env vars for sandbox pod (e.g. IPC tokens)    |

Note: Identity files and skills are no longer mounted as filesystem directories. They are sent via stdin payload (loaded from DocumentStore by the host).

**SandboxProcess** -- returned by `spawn()`:

| Field             | Type                   | Notes                                                     |
|-------------------|------------------------|-----------------------------------------------------------|
| pid               | `number`               | Process/synthetic PID                                     |
| exitCode          | `Promise<number>`      | Resolves when process exits                               |
| stdout            | `ReadableStream`       | Standard output (dummy in k8s -- response comes via HTTP) |
| stderr            | `ReadableStream`       | Standard error                                            |
| stdin             | `WritableStream`       | Standard input                                            |
| kill()            | `() => void`           | Kill the process/pod                                      |
| bridgeSocketPath  | `string?`              | Host-side socket for reverse IPC bridge (Apple containers)|
| podName           | `string?`              | Pod name for HTTP work delivery (k8s)                     |

**SandboxProvider**: `spawn(config)`, `kill(pid)`, `isAvailable()`, plus:

| Field              | Type                                    | Notes                                                     |
|--------------------|-----------------------------------------|-----------------------------------------------------------|
| deletePvc?         | `(pvcName: string) => Promise<void>`    | Delete a PVC by name (k8s only). Used during agent deletion. |

## Canonical Paths (`canonical-paths.ts`)

Every agent gets a single `/workspace` directory as its CWD and HOME. The old three-directory split (scratch/agent/user) has been removed.

| Canonical Path         | Mount | Purpose                                                    |
|------------------------|-------|------------------------------------------------------------|
| `/workspace`           | rw    | Single workspace directory, agent HOME/CWD                 |
| `/workspace/bin`       | rw    | Prepended to PATH -- agents can install CLI tools here     |

In Docker and Apple Container mode, `/workspace` is bind-mounted from the host. In k8s mode, `/workspace` is backed by a PVC (persistent across pod restarts) or emptyDir (ephemeral). PVC-backed workspaces mean installed tools and packages survive pod restarts.

Identity files and skills are sent via stdin payload from DocumentStore -- not mounted as filesystem directories.

### Environment Variables

`canonicalEnv(config)` builds:
- `AX_IPC_SOCKET` -- real host path for IPC
- `AX_WEB_PROXY_SOCKET` -- path to web proxy Unix socket (same dir as IPC socket, `web-proxy.sock`)
- `AX_WORKSPACE` -- canonical root (`/workspace`)
- `PATH` -- `/workspace/bin` prepended to system PATH
- `npm_config_cache`, `XDG_CACHE_HOME` -- redirected to `/tmp`
- `AX_HOME` -- `/tmp/.ax-agent`

### Symlink Fallback

`createCanonicalSymlinks(config)` is retained for backward compatibility but is now a no-op -- returns the workspace path and an empty cleanup function.

## Implementations

| Name       | File                 | Platform              | Isolation                                              |
|------------|----------------------|-----------------------|--------------------------------------------------------|
| docker     | `docker.ts`          | Linux / macOS         | Container, --network=none (default), --cap-drop=ALL, optional gVisor |
| apple      | `apple.ts`           | macOS (Apple Silicon) | Lightweight VM via Virtualization.framework, no shared kernel |
| k8s        | `k8s.ts`             | Kubernetes            | Pod-based sandbox with HTTP IPC                        |

Shared helpers in `utils.ts`: `exitCodePromise`, `enforceTimeout`, `killProcess`, `checkCommand`, `sandboxProcess`.

## Workspace Model

Each agent gets a single `/workspace` directory. No separate scratch/agent/user directories.

**Host-side** (Docker/Apple/subprocess):
- `/workspace` is a host directory bind-mounted into the container (rw).
- Content persists as long as the host directory exists.

**K8s mode**:
- `/workspace` is backed by a PersistentVolumeClaim (PVC) when `pvcName` is set on SandboxConfig.
- The PVC is created on first use and persists across pod restarts. Installed tools, packages, and working files survive pod recycling.
- Pod idle timeout is 5 minutes -- the PVC preserves state so pods can be recycled aggressively.
- When no PVC is configured, `/workspace` uses an emptyDir (ephemeral, lost when pod terminates).

## Docker Provider (`docker.ts`)

Uses `docker run` with:
- `--network=none` always (no container ever needs network -- workspace lifecycle runs host-side)
- `--memory`, `--cpus`, `--pids-limit` resource limits
- `--cap-drop=ALL`, `--security-opt no-new-privileges`, `--read-only` root
- Volume mounts to canonical paths (`-v host:canonical:mode`)
- IPC socket directory mounted for agent containers
- Optional gVisor runtime (`AX_DOCKER_RUNTIME=gvisor`)
- Image configurable via `AX_DOCKER_IMAGE` (default: `ax/agent:latest`)
- **Standard bash tools in image**: Agent container image includes common tools (jq, curl, wget, git, vim, etc.) for sandbox bash operations

## Apple Container Provider (`apple.ts`)

Uses Apple's `container` CLI (Virtualization.framework):
- Per-container VM boundary -- stronger isolation than process-level sandboxing
- No network (workspace lifecycle runs host-side, no container needs network)
- `--publish-socket` bridges IPC across the VM boundary via virtio-vsock
- Agent LISTENS inside the container (`AX_IPC_LISTEN=1`), host connects via bridge socket
- Bridge sockets isolated in a `bridges/` subdirectory to prevent cleanup conflicts
- `bridgeSocketPath` returned on `SandboxProcess` so host knows where to connect
- Image configurable via `AX_CONTAINER_IMAGE` (default: `ax/agent:latest`)

## K8s Sandbox Provider (`k8s.ts`)

Kubernetes pod-based sandbox (no k8s Exec/Attach):

- **Warm pool**: `SessionPodManager` manages session-long pod reuse. Falls back to cold start.
- **Cold start**: Always creates a new pod per sandbox request.
- **PVC workspace**: When `pvcName` is set, `/workspace` is backed by a PVC. Installed tools and packages persist across pod restarts.
- Communication: HTTP for both work dispatch (via `SessionPodManager`) and IPC:
  - Host dispatches work payload via HTTP through `SessionPodManager`
  - Agent sends IPC requests via HTTP POST to `/internal/ipc` (`HttpIPCClient`)
  - Agent sends response via `agent_response` IPC action (over HTTP)
- `AX_HOST_URL` tells the agent to use `HttpIPCClient` instead of Unix sockets
- Per-turn capability tokens (`AX_IPC_TOKEN`) passed via `extraEnv`
- `podName` returned on `SandboxProcess` for HTTP work delivery
- Dummy stdout/stderr/stdin streams (response comes via HTTP, not stdio)
- Security: `readOnlyRootFilesystem`, `runAsNonRoot` (uid 1000), `capabilities: drop ALL`, `automountServiceAccountToken: false`
- gVisor runtime by default (`K8S_RUNTIME_CLASS`, empty string to disable)

### K8s Environment Variables

| Env Var                   | Default             | Purpose                                 |
|---------------------------|---------------------|-----------------------------------------|
| K8S_NAMESPACE             | `ax`                | Target namespace                        |
| K8S_POD_IMAGE             | `ax/agent:latest`   | Container image                         |
| K8S_RUNTIME_CLASS         | `gvisor`            | Runtime class (empty to disable)        |
| K8S_IMAGE_PULL_SECRETS    | (none)              | Comma-separated secret names            |
| WARM_POOL_ENABLED         | `true`              | Enable warm pool claiming               |
| WARM_POOL_TIER            | `light`             | Tier to claim from                      |
| AX_HOST_URL               | (set by host)       | Host service URL for HTTP staging (`http://ax-host.{namespace}.svc`) |

## Warm Pod Pool

Warm pool claiming is handled by `SessionPodManager`, which manages session-long pod reuse via HTTP. The separate `warm-pool-client.ts` has been removed.

## Local Sandbox Execution (`src/agent/local-sandbox.ts`)

Agent-side tool execution with host audit gate protocol:

1. `sandbox_approve` -> host audits the operation, returns `{approved: true/false}`
2. Execute locally (only if approved) -- bash, read_file, write_file, edit_file
3. `sandbox_result` -> host logs outcome (best-effort, fire-and-forget)

All file operations use `safePath()` for path traversal prevention. Bash commands run via `execFileSync('sh', ['-c', command])` with timeout and buffer limits.

### K8s Workspace Persistence

In k8s mode, workspace persistence is handled by PVCs (PersistentVolumeClaims):
- When `pvcName` is set on SandboxConfig, the `/workspace` volume is backed by a PVC.
- The PVC is created automatically on first use and persists across pod restarts.
- Pod idle timeout is 5 minutes -- pods are recycled aggressively since the PVC preserves all state.
- When an agent is deleted, the PVC is cleaned up via `SandboxProvider.deletePvc()`.

## Dev/Prod Mode Support

`utils.ts` includes EPERM handling for tsx-wrapped agents:
- **Dev mode**: Agent spawned via `tsx src/agent/runner.ts` -- tsx wrapper may throw EPERM when parent sends SIGTERM/SIGKILL
- **Prod mode**: Agent spawned via `node dist/agent/runner.js` -- standard signal handling
- **`enforceTimeout()`**: Sends SIGTERM first, then SIGKILL after grace period. Wraps both in try/catch to handle EPERM gracefully

## Common Tasks

### Adding a new sandbox provider

1. Create `src/providers/sandbox/<name>.ts` implementing `SandboxProvider`.
2. Export `create(config: Config)`.
3. Add to `PROVIDER_MAP` in `src/host/provider-map.ts`.
4. Ensure `spawn()` passes minimal env via `canonicalEnv(config)`.
5. Enforce `--network=none` or equivalent -- security invariant (unless `config.network` is true for three-phase orchestration).
6. Mount `/workspace` (rw) and IPC socket dir.
7. Support `config.cpus` and `config.memoryMB` resource limits.
8. Support `config.extraEnv` for per-turn env var injection.
9. Add integration test in `tests/providers/sandbox/`.

## Gotchas

- **Three-phase network flag**: Docker omits `--network=none` when `config.network` is true. Apple passes `--network default`. Always check which phase you're in.
- **Apple Container IPC is reversed**: Agent LISTENS, host CONNECTS (via `bridgeSocketPath`). This is opposite to Docker/subprocess where the agent connects to the host's IPC server.
- **Apple Container --tmpfs hides sockets**: `--publish-socket` forwarding fails when the container-side socket path is on a tmpfs mount. That's why Apple provider doesn't use `--read-only`.
- **Apple Container bridge socket isolation**: Bridge sockets go in a `bridges/` subdirectory. If they shared the IPC server directory, container runtime cleanup could delete `proxy.sock`.
- **K8s uses HTTP, not Unix socket IPC**: Pods can't share host filesystem. Agent uses `HttpIPCClient` (set via `AX_HOST_URL`). Streams are dummy PassThrough -- response comes via HTTP IPC `agent_response`. Work dispatch also uses HTTP via `SessionPodManager`.
- **K8s pods have synthetic PIDs**: Real PIDs don't exist for k8s pods. The provider maintains a counter starting at 100,000.
- **New host paths must be added to container providers**: SandboxConfig changes ripple to docker (-v), apple (-v), k8s (volume mounts).
- **EPERM on kill**: tsx-wrapped agents may throw EPERM on SIGTERM/SIGKILL. `enforceTimeout()` handles this with try/catch.
- **Identity/skills NOT mounted**: They come via stdin payload from DocumentStore. Don't add filesystem mounts for identity or skills.
- **Web proxy socket location**: `web-proxy.sock` lives in the same directory as the IPC socket (already mounted into containers). `canonicalEnv()` computes the path from `dirname(config.ipcSocket)`. No extra mount needed.
- **K8s web proxy uses k8s Service**: K8s pods don't use a Unix socket for the web proxy. Instead, `server-k8s.ts` passes `AX_WEB_PROXY_URL` pointing to a k8s Service (`ax-web-proxy.{namespace}.svc:3128`). Network policy allows pods to reach the proxy service.
- **K8s workspace uses PVCs**: `/workspace` is backed by a PVC in k8s mode. State persists across pod restarts. Pod idle timeout is 5 minutes since the PVC preserves everything.
- **child.killed is true after ANY kill() call**, not just after the process is dead. Use a separate `exited` flag.
- **Use direct binary paths** (`node_modules/.bin/tsx`) not `npx` inside sandboxes.
- **Always have an integration test with the real sandbox**, not just subprocess fallback.

## Key Files

- `src/providers/sandbox/types.ts` -- SandboxConfig, SandboxProcess, SandboxProvider interfaces
- `src/providers/sandbox/canonical-paths.ts` -- Canonical path constants, env builders, symlink helpers
- `src/providers/sandbox/docker.ts` -- Docker container provider (--network=none, gVisor optional)
- `src/providers/sandbox/apple.ts` -- Apple Container provider (VM-based, --publish-socket IPC bridge)
- `src/providers/sandbox/k8s.ts` -- Kubernetes pod provider (HTTP IPC, SessionPodManager)
- `src/providers/sandbox/utils.ts` -- Shared sandbox helpers (exitCodePromise, enforceTimeout, etc.)
- `src/agent/local-sandbox.ts` -- Agent-side local tool execution with host audit gate
- `src/host/provider-map.ts` -- Static allowlist (sandbox: docker, apple, k8s)
- `tests/providers/sandbox/` -- Tests: k8s, docker, apple, subprocess, k8s-warm-pool, k8s-ca-injection, canonical-paths, utils
