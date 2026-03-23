---
name: ax-provider-sandbox
description: Use when modifying agent sandbox isolation -- subprocess (dev), Docker, Apple Container (macOS), or k8s providers in src/providers/sandbox/
---

## Overview

Sandbox providers isolate agent processes with zero network access (by default), no credentials, and mount-only filesystem access. Each provider implements `SandboxProvider` from `src/providers/sandbox/types.ts` and exports `create(config: Config)`.

Agents run INSIDE their containers and execute tools locally. Workspace lifecycle is driven by `workspaceLocation` on SandboxProvider: host-side providers (Docker/Apple/subprocess) prepare/finalize on bind-mounted paths; k8s provisions in-pod from the NATS work payload.

## Interface

**SandboxConfig** -- passed to `spawn()`:

| Field                    | Type                       | Notes                                                    |
|--------------------------|----------------------------|----------------------------------------------------------|
| workspace                | `string`                   | Session working directory (rw mount)                     |
| ipcSocket                | `string`                   | Unix socket path for IPC                                 |
| timeoutSec               | `number?`                  | Process timeout                                          |
| memoryMB                 | `number?`                  | Memory limit                                             |
| cpus                     | `number?`                  | CPU limit                                                |
| command                  | `string[]`                 | Command + args to execute                                |
| agentWorkspace           | `string?`                  | Agent's shared workspace                                 |
| userWorkspace            | `string?`                  | Per-user persistent storage                              |
| agentWorkspaceWritable   | `boolean?`                 | rw when admin + workspace provider active                |
| userWorkspaceWritable    | `boolean?`                 | rw when workspace provider active                        |
| extraEnv                 | `Record<string, string>?`  | Additional env vars for sandbox pod (e.g. IPC tokens)    |

Note: Identity files and skills are no longer mounted as filesystem directories. They are sent via stdin payload (loaded from DocumentStore by the host).

**SandboxProcess** -- returned by `spawn()`:

| Field             | Type                   | Notes                                                     |
|-------------------|------------------------|-----------------------------------------------------------|
| pid               | `number`               | Process/synthetic PID                                     |
| exitCode          | `Promise<number>`      | Resolves when process exits                               |
| stdout            | `ReadableStream`       | Standard output (dummy in k8s -- response comes via NATS) |
| stderr            | `ReadableStream`       | Standard error                                            |
| stdin             | `WritableStream`       | Standard input                                            |
| kill()            | `() => void`           | Kill the process/pod                                      |
| bridgeSocketPath  | `string?`              | Host-side socket for reverse IPC bridge (Apple containers)|
| podName           | `string?`              | Pod name for NATS work delivery (k8s)                     |

**SandboxProvider**: `spawn(config)`, `kill(pid)`, `isAvailable()`, plus:

| Field              | Type                    | Notes                                                     |
|--------------------|-------------------------|-----------------------------------------------------------|
| workspaceLocation  | `'host' \| 'sandbox'`  | Where workspace prepare/release runs. `host` = bind-mounted paths (Docker/Apple/subprocess). `sandbox` = in-pod provisioning from NATS payload (k8s). |

## Canonical Paths (`canonical-paths.ts`)

All sandbox providers remap host paths to short canonical paths. The LLM sees these canonical paths regardless of sandbox type:

| Canonical Path         | Mount | Purpose                                                    |
|------------------------|-------|------------------------------------------------------------|
| `/workspace`           | ro    | Mount root (read-only), agent HOME/CWD                     |
| `/workspace/scratch`   | rw    | Session working files (lost when session ends)              |
| `/workspace/agent`     | ro*   | Agent workspace (*rw for admin users only)                  |
| `/workspace/user`      | ro*   | Per-user storage (*rw when workspace active)                |

In k8s mode, scratch is backed by GCS via the workspace provider's 'session' scope, so its content survives across pod restarts within the same conversation.

Identity files and skills are sent via stdin payload from DocumentStore -- not mounted as filesystem directories.

### Environment Variables

`canonicalEnv(config)` builds:
- `AX_IPC_SOCKET` -- real host path for IPC
- `AX_WEB_PROXY_SOCKET` -- path to web proxy Unix socket (same dir as IPC socket, `web-proxy.sock`)
- `AX_WORKSPACE` -- canonical root (`/workspace`)
- `AX_AGENT_WORKSPACE` -- `/workspace/agent` (if agentWorkspace set)
- `AX_USER_WORKSPACE` -- `/workspace/user` (if userWorkspace set)
- `npm_config_cache`, `XDG_CACHE_HOME` -- redirected to `/tmp`
- `AX_HOME` -- `/tmp/.ax-agent`

### Symlink Fallback

Only subprocess uses symlink fallback (it can't remap filesystems). `createCanonicalSymlinks(config)` creates symlinks under `/tmp/.ax-mounts-<uuid>`. Returns `{ mountRoot, cleanup }`. `symlinkEnv()` builds env vars pointing to symlink paths instead of canonical paths.

## Implementations

| Name       | File                 | Platform              | Isolation                                              |
|------------|----------------------|-----------------------|--------------------------------------------------------|
| subprocess | `subprocess.ts`      | Any                   | None -- dev-only fallback, logs warning                |
| docker     | `docker.ts`          | Linux / macOS         | Container, --network=none (default), --cap-drop=ALL, optional gVisor |
| apple      | `apple.ts`           | macOS (Apple Silicon) | Lightweight VM via Virtualization.framework, no shared kernel |
| k8s        | `k8s.ts`             | Kubernetes            | Pod-based sandbox with HTTP IPC                        |

Shared helpers in `utils.ts`: `exitCodePromise`, `enforceTimeout`, `killProcess`, `checkCommand`, `sandboxProcess`.

## Unified Workspace Lifecycle

Workspace prepare/release is driven by `workspaceLocation` on each SandboxProvider:

**Host-side** (`workspaceLocation: 'host'` -- Docker/Apple/subprocess):
1. `workspace.mount()` provisions GCS scopes to host paths (existing)
2. `prepareGitWorkspace(plan)` clones/restores git workspace to host path (NEW)
3. One container spawns -- bind-mounts host paths (no network needed)
4. Agent runs and exits -- changes visible on host via bind-mount
5. `workspace.commit()` diffs and persists changes (existing)
6. `finalizeGitWorkspace(plan)` pushes changes + updates GCS cache (NEW)

**Sandbox-side** (`workspaceLocation: 'sandbox'` -- k8s):
1. `workspace.mount()` is a no-op (returns empty paths)
2. Work payload includes workspace provider type, agent/user/session IDs, and git URL
3. One pod spawns -- runner provisions via HTTP from host before agent starts (`provisionWorkspaceFromPayload`). When `AX_HOST_URL` is set and workspace provider is `gcs`, all scopes are fetched from the host's `GET /internal/workspace/provision` endpoint (the host has GCS credentials, the pod doesn't). No GCS prefix fields needed in the payload for this path.
4. Agent runs -- reads/writes canonical paths in emptyDir volumes
5. Runner releases -- diffs against provisioned hashes, HTTP upload to host
6. Runner finalizes -- git push + GCS cache update (in-pod)

Key types: `WorkspaceLifecyclePlan`, `buildLifecyclePlan()`, `prepareGitWorkspace()`, `finalizeGitWorkspace()` in `src/providers/workspace/lifecycle.ts`.

## Docker Provider (`docker.ts`)

Uses `docker run` with:
- `--network=none` always (no container ever needs network -- workspace lifecycle runs host-side)
- `--memory`, `--cpus`, `--pids-limit` resource limits
- `--cap-drop=ALL`, `--security-opt no-new-privileges`, `--read-only` root
- Volume mounts to canonical paths (`-v host:canonical:mode`)
- IPC socket directory mounted for agent containers
- Optional gVisor runtime (`AX_DOCKER_RUNTIME=gvisor`)
- Image configurable via `AX_DOCKER_IMAGE` (default: `ax/agent:latest`)

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

- **Warm pool**: Handled at the NATS queue group level — the host publishes work to `sandbox.work` queue group, warm pods subscribe. Falls back to cold start.
- **Cold start**: Always creates a new pod per sandbox request.
- Communication: NATS for work dispatch, HTTP for IPC:
  - Host publishes work payload to `sandbox.work` queue group via NATS (warm) or per-pod subject (cold)
  - Agent sends IPC requests via HTTP POST to `/internal/ipc` (`HttpIPCClient`)
  - Agent sends response via `agent_response` IPC action (over HTTP)
- `AX_HOST_URL` tells the agent to use `HttpIPCClient` instead of Unix sockets
- Per-turn capability tokens (`AX_IPC_TOKEN`) passed via `extraEnv`
- `podName` returned on `SandboxProcess` for NATS work delivery
- Dummy stdout/stderr/stdin streams (response comes via NATS, not stdio)
- Security: `readOnlyRootFilesystem`, `runAsNonRoot` (uid 1000), `capabilities: drop ALL`, `automountServiceAccountToken: false`
- gVisor runtime by default (`K8S_RUNTIME_CLASS`, empty string to disable)

### K8s Environment Variables

| Env Var                   | Default             | Purpose                                 |
|---------------------------|---------------------|-----------------------------------------|
| K8S_NAMESPACE             | `ax`                | Target namespace                        |
| K8S_POD_IMAGE             | `ax/agent:latest`   | Container image                         |
| K8S_RUNTIME_CLASS         | `gvisor`            | Runtime class (empty to disable)        |
| NATS_URL                  | `nats://nats:4222`  | NATS server URL for sandbox pods        |
| K8S_IMAGE_PULL_SECRETS    | (none)              | Comma-separated secret names            |
| WARM_POOL_ENABLED         | `true`              | Enable warm pool claiming               |
| WARM_POOL_TIER            | `light`             | Tier to claim from                      |
| AX_HOST_URL               | (set by host)       | Host service URL for HTTP staging (`http://ax-host.{namespace}.svc`) |

## Warm Pod Pool

Warm pool claiming is handled at the NATS queue group level. The host's `publishWork()` uses `nc.request('sandbox.work')` to deliver work to warm pods via queue groups. The separate `warm-pool-client.ts` has been removed.

**Controller** (`src/pool-controller/`): Standalone process that maintains target warm pod counts per tier:

| File              | Responsibility                                          |
|-------------------|---------------------------------------------------------|
| `controller.ts`   | Reconciliation loop: scale up/down, garbage collect     |
| `k8s-client.ts`   | K8s pod CRUD, tier config types, pod template           |
| `metrics.ts`      | Prometheus-style metrics for warm pool health           |
| `main.ts`         | Entry point, tier config loading, graceful shutdown     |

Default tiers: `light` (1 CPU, 2Gi) and `heavy` (4 CPU, 16Gi). Configurable via `SANDBOX_TEMPLATE_DIR` JSON files or env vars (`LIGHT_MIN_READY`, `LIGHT_MAX_READY`, etc.).

Reconciliation cycle: list warm pods -> filter Running -> scale up if below `minReady` -> scale down if above `maxReady` -> garbage collect Failed/Succeeded pods.

## Local Sandbox Execution (`src/agent/local-sandbox.ts`)

Agent-side tool execution with host audit gate protocol:

1. `sandbox_approve` -> host audits the operation, returns `{approved: true/false}`
2. Execute locally (only if approved) -- bash, read_file, write_file, edit_file
3. `sandbox_result` -> host logs outcome (best-effort, fire-and-forget)

All file operations use `safePath()` for path traversal prevention. Bash commands run via `execFileSync('sh', ['-c', command])` with timeout and buffer limits.

## Workspace CLI (`src/agent/workspace-cli.ts`)

CLI for container provision/cleanup/release phases, invoked inside containers:

```
node dist/agent/workspace-cli.js provision --workspace /workspace --session default [options]
node dist/agent/workspace-cli.js cleanup --workspace /workspace --session default [options]
node dist/agent/workspace-cli.js release --host-url http://ax-host.ax.svc
```

- **Provision**: GCS restore, git clone, scope provisioning (agent/user/session), hash snapshot
- **Cleanup**: Diff scopes against hash snapshot, upload changes, git push, release workspace
- **Release** (k8s only): Diffs all workspace scopes (`/workspace/scratch`, `/workspace/agent`, `/workspace/user`) against empty baseline, gzips the change set as JSON with base64-encoded file contents, POSTs to `${hostUrl}/internal/workspace-staging`, and outputs the staging key to stdout. Called by `workspace-release.ts` as a subprocess before the `agent_response` IPC call

### K8s Workspace File Transfer

In k8s mode, the host is the single GCS credential holder. Pods transfer workspace files via symmetric HTTP endpoints:

**Provision** (start of turn, GCS → host → pod):
1. `provisionWorkspaceFromPayload()` detects `AX_HOST_URL` + workspace provider `gcs`
2. For each scope (agent, user, session), calls `provisionScope()` which GETs `${hostUrl}/internal/workspace/provision?scope=<s>&id=<id>`
3. Host reads from GCS via `providers.workspace.downloadScope()`, returns gzipped JSON with base64 file contents
4. Pod decompresses, writes files to canonical mount paths, snapshots hashes for release diff

**Release** (end of turn, pod → host → GCS):
1. Agent runner calls `releaseWorkspaceScopes()` from `workspace-release.ts`
2. `workspace-release.ts` spawns `workspace-cli.js release --host-url <url>` as subprocess
3. workspace-cli diffs scopes, gzips JSON, POSTs to host `/internal/workspace-staging`
4. Host returns a `staging_key` UUID
5. `workspace-release.ts` sends `workspace_release` IPC via NATS with just the `staging_key`
6. Host looks up staged data, decompresses, decodes base64 content, calls `provider.setRemoteChanges()`
7. `workspace.commit()` picks up stored changes via `RemoteTransport.diff()` and persists to GCS

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
6. Mount workspace (rw), agent workspace (ro), user workspace (ro), IPC socket dir.
7. Support `config.cpus` and `config.memoryMB` resource limits.
8. Support `config.extraEnv` for per-turn env var injection.
9. Add integration test in `tests/providers/sandbox/`.

## Gotchas

- **Three-phase network flag**: Docker omits `--network=none` when `config.network` is true. Apple passes `--network default`. Always check which phase you're in.
- **Apple Container IPC is reversed**: Agent LISTENS, host CONNECTS (via `bridgeSocketPath`). This is opposite to Docker/subprocess where the agent connects to the host's IPC server.
- **Apple Container --tmpfs hides sockets**: `--publish-socket` forwarding fails when the container-side socket path is on a tmpfs mount. That's why Apple provider doesn't use `--read-only`.
- **Apple Container bridge socket isolation**: Bridge sockets go in a `bridges/` subdirectory. If they shared the IPC server directory, container runtime cleanup could delete `proxy.sock`.
- **K8s uses HTTP, not Unix socket IPC**: Pods can't share host filesystem. Agent uses `HttpIPCClient` (set via `AX_HOST_URL`). Streams are dummy PassThrough -- response comes via HTTP IPC `agent_response`.
- **K8s pods have synthetic PIDs**: Real PIDs don't exist for k8s pods. The provider maintains a counter starting at 100,000.
- **New host paths must be added to container providers**: SandboxConfig changes ripple to docker (-v :ro), apple (-v :ro), k8s (volume mounts).
- **EPERM on kill**: tsx-wrapped agents may throw EPERM on SIGTERM/SIGKILL. `enforceTimeout()` handles this with try/catch.
- **Identity/skills NOT mounted**: They come via stdin payload from DocumentStore. Don't add filesystem mounts for identity or skills.
- **Web proxy socket location**: `web-proxy.sock` lives in the same directory as the IPC socket (already mounted into containers). `canonicalEnv()` computes the path from `dirname(config.ipcSocket)`. No extra mount needed.
- **K8s web proxy uses k8s Service**: K8s pods don't use a Unix socket for the web proxy. Instead, `server-k8s.ts` passes `AX_WEB_PROXY_URL` pointing to a k8s Service (`ax-web-proxy.{namespace}.svc:3128`). Network policy allows pods to reach the proxy service.
- **K8s pods have no GCS credentials or gsutil**: Agent pods cannot access GCS directly. All GCS access goes through the host via HTTP endpoints (`/internal/workspace/provision` for reads, `/internal/workspace-staging` for writes). Never shell out to `gsutil` in code that runs inside agent pods — use the host HTTP path or `@google-cloud/storage` SDK (for non-k8s only).
- **K8s workspace uses symmetric HTTP endpoints**: Provision (GCS→host→pod) via `GET /internal/workspace/provision`, release (pod→host→GCS) via `POST /internal/workspace-staging`. Only the staging_key reference travels over NATS (avoids NATS 1MB payload limit).
- **child.killed is true after ANY kill() call**, not just after the process is dead. Use a separate `exited` flag.
- **Use direct binary paths** (`node_modules/.bin/tsx`) not `npx` inside sandboxes.
- **Always have an integration test with the real sandbox**, not just subprocess fallback.

## Key Files

- `src/providers/sandbox/types.ts` -- SandboxConfig, SandboxProcess, SandboxProvider interfaces
- `src/providers/sandbox/canonical-paths.ts` -- Canonical path constants, env builders, symlink helpers
- `src/providers/sandbox/subprocess.ts` -- Dev-only fallback (no isolation, symlink-based paths)
- `src/providers/sandbox/docker.ts` -- Docker container provider (--network=none, gVisor optional)
- `src/providers/sandbox/apple.ts` -- Apple Container provider (VM-based, --publish-socket IPC bridge)
- `src/providers/sandbox/k8s.ts` -- Kubernetes pod provider (NATS IPC, warm pool)
- `src/pool-controller/` -- Warm pod pool management (controller, k8s-client, metrics, main) — claiming via NATS queue groups
- `src/providers/sandbox/utils.ts` -- Shared sandbox helpers (exitCodePromise, enforceTimeout, etc.)
- `src/agent/local-sandbox.ts` -- Agent-side local tool execution with host audit gate
- `src/agent/workspace-cli.ts` -- Container provision/cleanup/release phase CLI
- `src/agent/workspace-release.ts` -- Thin wrapper that spawns workspace-cli.ts release as subprocess, sends staging_key via IPC
- `src/host/provider-map.ts` -- Static allowlist (sandbox: subprocess, docker, apple, k8s)
- `tests/providers/sandbox/` -- Tests: k8s, docker, apple, subprocess, k8s-warm-pool, k8s-ca-injection, canonical-paths, utils
