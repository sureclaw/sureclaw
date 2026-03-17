// src/providers/workspace/types.ts — Workspace provider types
//
// Manages persistent file workspaces for agent sessions with three scopes
// (agent, user, session), automatic change detection, and scan-before-persist
// semantics.

// ═══════════════════════════════════════════════════════
// Scopes & Mounts
// ═══════════════════════════════════════════════════════

export type WorkspaceScope = 'agent' | 'user' | 'session';

export interface WorkspaceMounts {
  /** Paths the sandbox should bind-mount (one per activated scope). */
  paths: Partial<Record<WorkspaceScope, string>>;
}

export interface MountOptions {
  /** User ID for resolving the 'user' scope directory. Falls back to sessionId if omitted. */
  userId?: string;
}

// ═══════════════════════════════════════════════════════
// Commit Results
// ═══════════════════════════════════════════════════════

export interface CommitResult {
  scopes: Partial<Record<WorkspaceScope, ScopeCommitResult>>;
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

// ═══════════════════════════════════════════════════════
// File Changes
// ═══════════════════════════════════════════════════════

export interface FileChange {
  path: string;
  type: 'added' | 'modified' | 'deleted';
  content?: Buffer; // undefined for deletes
  size: number;
}

// ═══════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════

export interface WorkspaceConfig {
  basePath: string;
  maxFileSize: number;
  maxFiles: number;
  maxCommitSize: number;
  ignorePatterns: string[];
  /** Backend-specific options (bucket, prefix, repoUrl, etc.) are read
   *  directly from the raw config by each backend — not declared here. */
}

// ═══════════════════════════════════════════════════════
// Backend Sub-Interface
// ═══════════════════════════════════════════════════════

export interface WorkspaceBackend {
  /** Set up workspace with current persisted state as base. Returns merged path. */
  mount(scope: WorkspaceScope, id: string): Promise<string>;

  /** Compute changeset since mount. */
  diff(scope: WorkspaceScope, id: string): Promise<FileChange[]>;

  /** Persist approved changes. */
  commit(scope: WorkspaceScope, id: string, changes: FileChange[]): Promise<void>;
}

// ═══════════════════════════════════════════════════════
// Remote File Changes (k8s NATS mode)
// ═══════════════════════════════════════════════════════

export interface RemoteFileChange {
  scope: WorkspaceScope;
  path: string;
  type: 'added' | 'modified' | 'deleted';
  content?: Buffer;
  size: number;
}

// ═══════════════════════════════════════════════════════
// File Listing (admin dashboard browsing)
// ═══════════════════════════════════════════════════════

export interface WorkspaceFileEntry {
  path: string;
  size: number;
}

// ═══════════════════════════════════════════════════════
// Provider Interface
// ═══════════════════════════════════════════════════════

export interface WorkspaceProvider {
  /** Activate scopes and populate content into workspace directories. */
  mount(sessionId: string, scopes: WorkspaceScope[], opts?: MountOptions): Promise<WorkspaceMounts>;

  /** Diff, scan, and persist changes for all mounted scopes. */
  commit(sessionId: string): Promise<CommitResult>;

  /** Clean up session scope, unmount overlays. */
  cleanup(sessionId: string): Promise<void>;

  /** Returns which scopes are currently active for a session. */
  activeMounts(sessionId: string): WorkspaceScope[];

  /** Store file changes received from remote agent (k8s NATS mode). */
  setRemoteChanges?(sessionId: string, changes: RemoteFileChange[]): void;

  /** List files in a workspace scope (admin browsing). Optional — not all backends support it. */
  listFiles?(scope: WorkspaceScope, id: string): Promise<WorkspaceFileEntry[]>;

  /** Download all files in a scope with content. Used by the provision HTTP endpoint
   *  so sandbox pods can fetch workspace files from the host (the pod has no GCS credentials). */
  downloadScope?(scope: WorkspaceScope, id: string): Promise<Array<{ path: string; content: Buffer }>>;
}
