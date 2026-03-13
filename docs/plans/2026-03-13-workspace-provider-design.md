# Workspace Provider Design

> **Status:** Proposed
> **Date:** 2026-03-13
> **Context:** Incorporating the Secure LLM Workspace Architecture into AX as a new provider category.

---

## 1. Overview

A new provider category in AX's registry: `WorkspaceProvider`. It manages persistent file workspaces for agent sessions with three scopes, automatic change detection, and scan-before-persist semantics.

**Key responsibilities:**

- Manage workspace lifecycle across turns (mount, diff, scan, commit)
- Track which scopes have been mounted per session (lazy mount on first `workspace_mount` call, auto-mount on subsequent turns)
- Delegate filesystem mechanics to a pluggable `WorkspaceBackend` sub-interface (mount, diff, commit)
- Delegate content scanning to AX's existing `ScannerProvider` + structural checks (file size, ignore patterns, binary detection)

**Not responsible for:**

- Sandbox execution (that's `SandboxProvider`)
- Message-level scanning (that's the router + `ScannerProvider`)

---

## 2. Workspace Scopes

Three workspace scopes, all available from day one:

### Agent Workspace — `/workspace/agent/`

Shared persistent workspace across all users interacting with the agent. Persists across sessions. Typical contents: shared artifacts, generated code, collaboration assets.

### User Workspace — `/workspace/user/`

Private workspace scoped to an individual user. Persists across sessions. Only visible to that user. Typical contents: personal artifacts, configuration, private outputs.

### Session Workspace — `/workspace/session/`

Temporary scratch space for the current conversation session. Persists across turns within a session. Destroyed when the session ends. Typical contents: temporary files, build artifacts, intermediate outputs.

---

## 3. Provider Interface

```typescript
// src/providers/workspace/types.ts

export interface WorkspaceProvider {
  /** Activate scopes and populate content into workspace directories. */
  mount(sessionId: string, scopes: WorkspaceScope[]): Promise<WorkspaceMounts>;

  /** Diff, scan, and persist changes for all mounted scopes. */
  commit(sessionId: string): Promise<CommitResult>;

  /** Clean up session scope, unmount overlays. */
  cleanup(sessionId: string): Promise<void>;

  /** Returns which scopes are currently active for a session. */
  activeMounts(sessionId: string): WorkspaceScope[];
}

export type WorkspaceScope = 'agent' | 'user' | 'session';

export interface WorkspaceMounts {
  /** Paths the sandbox should bind-mount (merged overlay views). */
  paths: Record<WorkspaceScope, string>;
}

export interface CommitResult {
  scopes: Record<WorkspaceScope, ScopeCommitResult>;
}

export interface ScopeCommitResult {
  status: 'committed' | 'rejected' | 'empty';
  filesChanged: number;
  bytesChanged: number;
  rejections?: FileRejection[];
}

export interface FileRejection {
  path: string;
  reason: string;
}
```

### 3.1 Backend Sub-Interface

Each workspace provider implementation composes shared orchestration logic (scanning, scope tracking, structural checks) with a storage-specific backend:

```typescript
export interface WorkspaceBackend {
  /** Set up workspace with current persisted state as base. Returns merged path. */
  mount(scope: WorkspaceScope, id: string): Promise<string>;

  /** Compute changeset since mount. */
  diff(scope: WorkspaceScope, id: string): Promise<FileChange[]>;

  /** Persist approved changes. */
  commit(scope: WorkspaceScope, id: string, changes: FileChange[]): Promise<void>;
}

export interface FileChange {
  path: string;
  type: 'added' | 'modified' | 'deleted';
  content?: Buffer; // undefined for deletes
  size: number;
}
```

The `id` passed to the backend is scope-dependent:

- `agent` scope: the agent name (e.g., `"assistant"`)
- `user` scope: the user ID
- `session` scope: the session ID

---

## 4. Mount Behavior

### Lazy Mount, Then Auto-Mount

- **First turn in a session:** No workspace mounted. Agent calls `workspace_mount` via IPC to request scopes.
- **Subsequent turns:** Host remembers which scopes were mounted and pre-populates them automatically before sandbox spawn.
- **Scope escalation is additive.** Calling `workspace_mount(["session"])` then later `workspace_mount(["agent"])` means both are active. Scopes accumulate within a session.

### Pod Compatibility (gVisor / Kubernetes)

Filesystem mounts cannot be added to a running gVisor pod after creation. The design separates the filesystem mount from content population:

- **Pod spec always mounts all three paths** as empty directories (`/workspace/agent/`, `/workspace/user/`, `/workspace/session/`).
- **`workspace_mount` does not perform a filesystem mount.** It tells the host to populate the already-present directory with persisted content via the backend.
- Before `workspace_mount` is called, the directory exists but is empty.
- After the call, the backend restores persisted content into it.

This works everywhere:

- **gVisor/K8s:** Volumes declared in pod spec, always present, populated on demand.
- **Overlayfs on Linux:** Overlay layers set up when scope is activated.
- **Subprocess local dev:** Directories always exist, backend populates content.

---

## 5. Host Orchestration

How the workspace provider integrates into AX's host turn lifecycle:

```
Host receives message
    │
    ├── Check session's remembered scopes (workspace.activeMounts)
    │   └── If scopes previously mounted → workspace.mount(sessionId, rememberedScopes)
    │
    ├── Spawn sandbox with workspace paths as bind-mounts
    │   └── /workspace/agent/, /workspace/user/, /workspace/session/
    │       (all paths exist; only activated scopes have content)
    │
    ├── Agent executes (may call workspace_mount IPC to add scopes)
    │   └── Host handles IPC: calls workspace.mount() for new scopes,
    │       backend populates content into already-present directories
    │
    ├── Agent turn ends
    │
    ├── workspace.commit(sessionId)
    │   ├── For each active scope:
    │   │   ├── backend.diff() → compute changeset
    │   │   ├── Structural checks (file size, ignore patterns, max files)
    │   │   ├── scanner.scanOutput() on each changed file's content
    │   │   ├── backend.commit(approved changes only)
    │   │   └── Log rejections to audit provider
    │   └── Return CommitResult
    │
    ├── Publish events to event hub:
    │   ├── workspace.commit — for each committed scope
    │   └── workspace.commit.rejected — for any rejections
    │
    ├── Store remembered scopes for next turn
    │
    └── workspace.cleanup() only when session ends
        └── Destroys session scope; agent and user scopes persist
```

---

## 6. Commit Pipeline

### Scanning — Two Layers

The workspace provider applies two layers of scanning before persistence:

**Layer 1 — Structural checks (workspace provider's responsibility):**

- File size limits
- Max file count per commit
- Max total commit size
- Ignore patterns (`.git/`, `node_modules/`, etc.)
- Binary file detection

**Layer 2 — Content scanning (delegated to AX's ScannerProvider):**

- Prompt injection detection
- Canary token checks
- PII scanning
- Pattern matching

Files that fail either layer are excluded from the commit and logged as rejections.

### Commit Filtering Defaults

```
max files per commit:    500
max commit size:         50 MB
max single file size:    10 MB

default ignore patterns:
  .git/
  node_modules/
  venv/
  __pycache__/
  *.log
  *.tmp
  build/
  dist/
```

---

## 7. Agent IPC Integration

### IPC Schema

```typescript
// src/ipc-schemas.ts — new action
workspace_mount: z.object({
  action: z.literal('workspace_mount'),
  scopes: z.array(z.enum(['agent', 'user', 'session'])),
}).strict()
```

### Agent-Side Tool

Registered in `ipc-tools.ts` when the workspace provider is not `none`:

```typescript
// workspace_mount tool definition
{
  name: 'workspace_mount',
  description: 'Mount workspace scopes for file persistence. Scopes: session (temporary), user (private), agent (shared). Additive — call multiple times to add scopes.',
  parameters: {
    scopes: { type: 'array', items: { type: 'string', enum: ['session', 'user', 'agent'] } }
  },
  execute: async ({ scopes }) => {
    const result = await ipc.call({ action: 'workspace_mount', scopes });
    return result; // { mounted: ['session', 'agent'], paths: { session: '/workspace/session', agent: '/workspace/agent' } }
  }
}
```

### Host-Side IPC Handler

1. Records requested scopes for this session (additive — merges with existing)
2. Calls `workspace.mount(sessionId, newScopes)` for any not-yet-active scopes
3. Backend populates content into already-present directories
4. Returns confirmation + paths to agent

---

## 8. Event Hub Integration

The workspace provider publishes events to AX's event hub for observability. The event hub routes them to whatever backend is configured (NATS, structured logs, etc.). No NATS-specific config in the workspace provider.

```typescript
eventHub.publish('workspace.mount', {
  sessionId,
  scopes: ['agent', 'session'],
  agentId: 'assistant'
});

eventHub.publish('workspace.commit', {
  sessionId,
  scope: 'agent',
  agentId: 'assistant',
  filesChanged: 3,
  bytesChanged: 12400
});

eventHub.publish('workspace.commit.rejected', {
  sessionId,
  scope: 'agent',
  rejections: [{ path: 'suspicious.sh', reason: 'scanner flagged' }]
});
```

---

## 9. Backend Implementations

### `none` — Stub (default)

No workspace persistence. `workspace_mount` tool is not registered. AX behaves exactly as it does today. No breaking change.

### `local` — Local Filesystem

```
mount:   Creates/uses directory at <basePath>/<scope>/<id>/
         Sets up overlayfs if available (Linux, macOS with FUSE).
         Falls back to file-copy snapshot for diff comparison.
         Base = persisted state, upper = runtime changes.

diff:    With overlayfs: reads upper dir for changes.
         Without overlayfs: compares file hashes against snapshot taken at mount time.

commit:  Moves approved changes from upper layer into base directory.
         (Or copies changed files over snapshot state.)
```

### `gcs` — Google Cloud Storage (GKE production)

```
mount:   Downloads persisted state from GCS bucket into base layer.
         gs://<bucket>/<scope>/<id>/
         Sets up overlayfs with base = downloaded state.

diff:    Reads upper dir, computes changeset.

commit:  Uploads approved changes to GCS bucket.
```

---

## 10. Configuration

### Provider Registry

```typescript
// src/host/provider-map.ts — new category
workspace: {
  none:  './providers/workspace/none.js',
  local: './providers/workspace/local.js',
  gcs:   './providers/workspace/gcs.js',
}

// src/types.ts — ProviderRegistry gains:
workspace: WorkspaceProvider;
```

### Config

```yaml
# ax.yaml
providers:
  workspace: none         # default: no workspace persistence (backward compatible)
  # workspace: local      # local filesystem + overlay
  # workspace: gcs        # GCS backend for GKE

# Workspace settings (when workspace != none)
workspace:
  basePath: ~/.ax/workspaces
  maxFileSize: 10MB
  maxFiles: 500
  maxCommitSize: 50MB
  ignorePatterns:
    - .git/
    - node_modules/
    - venv/
    - __pycache__/
    - "*.log"
    - "*.tmp"
    - build/
    - dist/
```

---

## 11. New Files

```
src/providers/workspace/
  types.ts              # WorkspaceProvider, WorkspaceBackend, FileChange, etc.
  none.ts               # Stub — no-op provider
  local.ts              # Local filesystem + overlay backend
  shared.ts             # Shared orchestration: scan pipeline, structural checks, scope tracking
  gcs.ts                # GCS backend (added later)
```

---

## 12. Trust Boundary

The workspace provider maintains AX's trust boundary:

- **Workers cannot write directly to permanent storage.** All writes go through the commit pipeline: diff → structural checks → scanner → persist.
- **Storage credentials exist only in the host.** The GCS backend runs host-side. The agent never sees storage credentials.
- **All file changes are audited.** Every commit and rejection is logged.
- **Scanning is mandatory.** Even the `local` backend runs both structural checks and content scanning before persistence. There is no config flag to skip scanning.

---

## 13. Security Invariants

These properties cannot be weakened by configuration:

- Every file change passes through the scanner before persistence.
- The agent cannot bypass the commit pipeline — it writes to an overlay, not to permanent storage.
- Structural limits (file size, count, commit size) are enforced before scanning.
- Ignore patterns are applied before the agent sees the diff (filtered out of the changeset).
- All commit events (approved and rejected) are published to the event hub and audit provider.
