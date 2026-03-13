---
name: provider-sandbox
description: Use when modifying agent sandbox isolation -- seatbelt (macOS), nsjail (Linux), bwrap (Linux), Docker, k8s, or subprocess providers in src/providers/sandbox/
---

## Overview

Sandbox providers isolate agent processes with zero network access, no credentials, and mount-only filesystem access. Each provider implements `SandboxProvider` from `src/providers/sandbox/types.ts` and exports `create(config: Config)`.

## Interface

**SandboxConfig** -- passed to `spawn()`:

| Field           | Type       | Notes                                           |
|-----------------|------------|-------------------------------------------------|
| workspace       | `string`   | Agent working directory (rw mount)              |
| ipcSocket       | `string`   | Unix socket path for IPC                        |
| timeoutSec      | `number?`  | Process timeout                                 |
| memoryMB        | `number?`  | Memory limit                                    |
| command         | `string[]` | Command + args to execute                       |
| agentWorkspace  | `string?`  | Agent's shared workspace (ro mount)             |
| userWorkspace   | `string?`  | Per-user persistent storage (ro mount)          |

Note: Identity files and skills are no longer mounted as filesystem directories. They are sent via stdin payload (loaded from DocumentStore by the host).

**SandboxProcess** -- returned by `spawn()`: `pid`, `exitCode` (Promise), `stdout`/`stderr` (ReadableStream), `stdin` (WritableStream), `kill()`.

**SandboxProvider**: `spawn(config)`, `kill(pid)`, `isAvailable()`.

## Canonical Paths (`canonical-paths.ts`)

All sandbox providers remap host paths to short canonical paths. The LLM sees these canonical paths regardless of sandbox type:

| Canonical Path       | Mount | Purpose                                      |
|----------------------|-------|----------------------------------------------|
| `/workspace`         | CWD   | Mount root, agent HOME                       |
| `/workspace/scratch` | rw    | Session working files (lost when session ends)|
| `/workspace/agent`   | ro    | Agent workspace, persistent shared files      |
| `/workspace/user`    | ro    | Per-user persistent storage (writes via IPC)  |

Identity files and skills are sent via stdin payload from DocumentStore — not mounted as filesystem directories.

### Environment Variables

`canonicalEnv(config)` builds:
- `AX_IPC_SOCKET` — real host path for IPC
- `AX_WORKSPACE` — canonical root (`/workspace`)
- `AX_AGENT_WORKSPACE` — `/workspace/agent` (if agentWorkspace set)
- `AX_USER_WORKSPACE` — `/workspace/user` (if userWorkspace set)
- `npm_config_cache`, `XDG_CACHE_HOME` — redirected to `/tmp`
- `AX_HOME` — `/tmp/.ax-agent`

### Symlink Fallback

Providers that can't remap filesystems (seatbelt, subprocess) use `createCanonicalSymlinks(config)` to create symlinks under `/tmp/.ax-mounts-<uuid>`. Returns `{ mountRoot, cleanup }`.

## Implementations

| Name       | File             | Platform       | Isolation                              |
|------------|------------------|----------------|----------------------------------------|
| seatbelt   | `seatbelt.ts`    | macOS          | sandbox-exec with .sb policy           |
| nsjail     | `nsjail.ts`      | Linux          | Namespaces + seccomp-bpf (production)  |
| bwrap      | `bwrap.ts`       | Linux          | Bubblewrap containerization            |
| docker     | `docker.ts`      | Linux / macOS  | Container, --network=none, --cap-drop=ALL, optional gVisor |
| k8s        | `k8s.ts`         | Kubernetes     | Pod-based sandbox with NATS dispatch   |
| subprocess | `subprocess.ts`  | Any            | None -- dev-only fallback, logs warning |

Shared helpers in `utils.ts`: `exitCodePromise`, `enforceTimeout`, `killProcess`, `checkCommand`, `sandboxProcess`.

## K8s Sandbox Provider

`src/providers/sandbox/k8s.ts` — Kubernetes pod-based sandbox:
- Uses NATS for tool dispatch (request/reply pattern via `src/host/nats-sandbox-dispatch.ts`)
- Per-turn pod affinity: first tool call claims a warm pod, subsequent calls reuse it
- Integrates with pool controller (`src/pool-controller/`) for warm pod management
- Sandbox worker (`src/sandbox-worker/worker.ts`) runs inside pods

## Sandbox Worker (`src/sandbox-worker/`)

NATS-based sandbox worker running inside k8s pods:

| File | Responsibility |
|------|----------------|
| `worker.ts` | NATS subscription, tool execution (bash, read_file, write_file, edit_file) |
| `workspace.ts` | Workspace provisioning and cleanup |
| `types.ts` | Request/response types for NATS messages |
| `main.ts` | Entry point |

Lifecycle: subscribe to `tasks.sandbox.{tier}` queue group → claim task → set up workspace → execute tools via unique `sandbox.{podId}` subject → release.

## Dev/Prod Mode Support

`utils.ts` includes EPERM handling for tsx-wrapped agents:
- **Dev mode**: Agent spawned via `tsx src/agent/runner.ts` -- tsx wrapper may throw EPERM when parent sends SIGTERM/SIGKILL
- **Prod mode**: Agent spawned via `node dist/agent/runner.js` -- standard signal handling
- **`enforceTimeout()`**: Wraps `kill()` in try/catch to handle EPERM gracefully

## Seatbelt (macOS)

Uses `sandbox-exec -f policies/agent.sb` with `-D` parameter substitution for dynamic paths. Minimal env -- no credentials. Key rules:

- **Last matching rule wins.** Use specific denies, not blanket `deny network*`.
- **Node.js needs:** root readdir, OpenSSL at `/System/Library/OpenSSL`, resolv.conf, file-read-metadata, node install path.
- **stdio 'ignore' requires** `(allow file-write* (literal "/dev/null"))`.

## Nsjail (Linux)

Production sandbox. `--clone_newnet` (no network), `--clone_newuser`, `--clone_newpid`, `--clone_newipc`. Resource limits at kernel level. Seccomp-bpf via `policies/agent.kafel`. Bind-mounts workspace (rw), IPC socket dir, Node.js path.

## Common Tasks

### Adding a new sandbox provider

1. Create `src/providers/sandbox/<name>.ts` implementing `SandboxProvider`.
2. Export `create(config: Config)`.
3. Add to `PROVIDER_MAP` in `src/host/provider-map.ts`.
4. Ensure `spawn()` passes minimal env via `canonicalEnv(config)`.
5. Enforce `--network=none` or equivalent -- security invariant.
6. Mount workspace (rw), agent workspace (ro), user workspace (ro), IPC socket dir.
7. Add integration test in `tests/providers/sandbox/`.

## Gotchas

- **Seatbelt last-matching-rule-wins.** Blanket deny at end overrides earlier allows.
- **Node.js runtime needs specific filesystem allows** -- missing any causes silent SIGABRT (exit 134).
- **Use direct binary paths** (`node_modules/.bin/tsx`) not `npx` inside sandboxes.
- **Always have an integration test with the real sandbox**, not just subprocess fallback.
- **New host paths must be added to ALL providers.** SandboxConfig changes ripple to seatbelt (-D param + policy rule), nsjail (--bindmount_ro), bwrap (--ro-bind), docker (-v :ro), k8s (volume mounts).
- **EPERM on kill**: tsx-wrapped agents may throw EPERM on SIGTERM/SIGKILL. `enforceTimeout()` handles this with try/catch.
- **Identity/skills NOT mounted**: They come via stdin payload from DocumentStore. Don't add filesystem mounts for identity or skills.
- **K8s sandbox uses NATS, not Unix socket IPC**: Tool calls dispatch via NATS request/reply to sandbox worker pods.
- **child.killed is true after ANY kill() call**, not just after the process is dead.

## Key Files

- `src/providers/sandbox/types.ts` — SandboxConfig, SandboxProcess, SandboxProvider interfaces
- `src/providers/sandbox/canonical-paths.ts` — Canonical path constants, env builders, symlink helpers
- `src/providers/sandbox/k8s.ts` — Kubernetes sandbox provider
- `src/providers/sandbox/utils.ts` — Shared sandbox helpers
- `src/host/nats-sandbox-dispatch.ts` — NATS-based tool dispatch for k8s sandbox
- `src/sandbox-worker/` — Sandbox worker for k8s pods
- `src/pool-controller/` — Warm pod pool management
- `tests/providers/sandbox/k8s.test.ts`
