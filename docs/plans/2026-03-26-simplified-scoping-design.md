# Simplified Scoping Architecture

**Date:** 2026-03-26
**Status:** Approved

## Problem

The current architecture has too many user-specific scoping layers:

- Credentials: `user:<agent>:<userId>` -> `agent:<agent>` -> global fallback
- Workspace FS: three mounted scopes (`agent/`, `user/`, `session/`)
- Identity: per-user `USER.md` on filesystem
- Skills: per-user skill directories

Agents should own their own credentials across all users. The sandbox
filesystem should be simple. User-specific state should only exist where
it genuinely matters.

## Design

### Surviving User-Specific Scopes

Only two things remain user-scoped:

1. **Memory** — per-user memory entries (existing Cortex provider)
2. **Workspace files** — GCS-backed file storage, accessed via IPC tools

### Scope Resolution Rule

Scope is determined by session type, not explicit tool parameters:

| Session type       | Workspace scope | Memory scope |
|--------------------|-----------------|--------------|
| DM / web chat      | `user` (userId) | `user`       |
| Group / channel    | `agent` (agentName) | `agent`  |
| Admin user         | Can specify explicitly | Can specify |

The agent doesn't think about scoping — the host resolves it from
`sessionScope` (`'dm' | 'channel' | 'thread' | 'group'`).

### Credentials

Simplified lookup chain:

```
resolveCredential(provider, envName, agentName):
  1. agent:<agentName>  ->  return if found
  2. process.env[envName]  ->  return if found
  3. return null
```

No user-level credential overrides. No `CredentialSessionContext`.

**Migration:** Existing user-scoped credentials (`user:<agent>:<userId>`) will be
migrated to agent scope (`agent:<agent>`) at startup. If an agent-scoped key already
exists, the user-scoped key is skipped (agent scope wins). A deprecation warning is
logged for each migrated key. The migration helper lives in `credential-scopes.ts`
and runs once during registry init. Call sites that reference
`CredentialSessionContext` (`server-completions.ts:setSessionCredentialContext`,
`server-request-handlers.ts:getSessionCredentialContext`,
`server-admin.ts:getSessionCredentialContext`) will be updated to remove `userId`
and pass only `agentName`/`env`.

### Sandbox Filesystem

Container layout:

```
/scratch     CWD, writable, emptyDir (k8s) / tmpdir (local), ephemeral
/skill/      read-only, populated from DB skill records
/tmp         writable, emptyDir
```

Removed:
- `/workspace` root
- `/workspace/agent`, `/workspace/user` mount points
- Mount/diff/commit pipeline
- Canonical symlinks for agent/user

### Workspace Provider

Thin GCS read/write/list service. No mounting, no diffing, no committing.

```typescript
export interface WorkspaceProvider {
  read(scope: 'agent' | 'user', id: string, path: string): Promise<Buffer | null>;
  write(scope: 'agent' | 'user', id: string, path: string, content: Buffer): Promise<void>;
  list(scope: 'agent' | 'user', id: string, prefix?: string): Promise<Array<{ path: string; size: number }>>;
  delete(scope: 'agent' | 'user', id: string, path: string): Promise<void>;
}
```

Accessed only via IPC workspace tools — not mounted into the sandbox.

**Replacing removed methods:**
- `downloadScope?` (previously used by the provision HTTP endpoint for sandbox pod
  workspace file fetching) is replaced by repeated calls to `read()` — the provision
  endpoint streams files individually by path instead of fetching a scope tarball.
- `listScopeIds?` (previously used at startup to enumerate users for domain scanning)
  is no longer needed — domain scanning will use the session store's existing user list
  (`sessionStore.listUsers()`) rather than enumerating workspace directories.

## Files to Change

### Rewrite

| File | Change |
|------|--------|
| `src/providers/workspace/types.ts` | New simple interface (read/write/list/delete) |
| `src/providers/workspace/gcs.ts` | Thin GCS wrapper, no transport/snapshot logic |
| `src/providers/workspace/none.ts` | No-op stub |
| `src/providers/workspace/local.ts` | Simple local FS version (dev mode) |
| `src/host/ipc-handlers/workspace.ts` | Remove mount, add scope resolution by session type |
| `src/host/credential-scopes.ts` | Remove user scoping, agent + env only |
| `src/providers/sandbox/canonical-paths.ts` | `/scratch` + `/skill`, remove agent/user |
| `src/host/server-completions.ts` | Remove workspace pre-mount, agent/user paths, simplify credential injection |
| `src/host/tool-router.ts` | Remove file I/O handlers and scopeSubdir |
| `src/agent/tool-catalog.ts` | Update workspace tool definitions |
| `src/providers/sandbox/k8s.ts` | workingDir `/scratch`, simplified volumes |

### Delete

| File | Reason |
|------|--------|
| `src/providers/workspace/shared.ts` | Orchestrator no longer needed |
| `src/host/workspace-release-screener.ts` | No commit pipeline |

### Simplify

| File | Change |
|------|--------|
| `src/paths.ts` | Remove `userWorkspaceDir`, `agentWorkspaceDir`, `userSkillsDir`, `agentSkillsDir` |
| `src/host/registry.ts` | Remove workspace screener wiring |
| `src/ipc-schemas.ts` | Update workspace action schemas |
| `src/config.ts` | Simplify workspace config (just bucket + prefix) |
| `src/types.ts` | Update WorkspaceProvider in ProviderRegistry |

### Tests

| File | Action |
|------|--------|
| `tests/host/credential-scopes.test.ts` | Rewrite for agent-only model |
| `tests/host/ipc-handlers/workspace.test.ts` | Rewrite for new interface |
| `tests/host/ipc-handlers/workspace-list-read.test.ts` | Rewrite |
| `tests/providers/workspace/shared.test.ts` | Delete |
| `tests/providers/workspace/gcs.test.ts` | Rewrite for thin wrapper |
| `tests/host/tool-router.test.ts` | Remove file I/O tests |
| `tests/providers/sandbox/canonical-paths.test.ts` | Update for new paths |

## Non-Goals

- GCS-backing for `/scratch` (can add later for pod restart durability)
- Cross-session persistence for scratch files
- User-level credential overrides
- Filesystem-based identity or skills
