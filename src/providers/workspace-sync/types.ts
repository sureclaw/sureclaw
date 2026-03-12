/**
 * Workspace sync provider interface.
 *
 * Syncs enterprise workspace tiers (agent/ and user/) to a remote backing
 * store (e.g. GCS). Local filesystem remains the fast path for reads;
 * the remote store is the source of truth for cross-host durability.
 */

export interface WorkspaceSyncProvider {
  /** Pull remote state → local directory. Returns files updated. */
  pull(localDir: string, remotePrefix: string): Promise<SyncResult>;

  /** Upload a single file after local write (fire-and-forget path). */
  uploadFile(localDir: string, remotePrefix: string, relativePath: string): Promise<void>;

  /** Upload all files in local dir to remote (full push). */
  pushAll(localDir: string, remotePrefix: string): Promise<SyncResult>;

  /** Delete a file from remote. */
  deleteFile(remotePrefix: string, relativePath: string): Promise<void>;
}

export interface SyncResult {
  filesUpdated: number;
  filesDeleted: number;
  bytesTransferred: number;
  durationMs: number;
}

export interface SyncManifestEntry {
  etag: string;
  writeTs: number;
  size: number;
}
