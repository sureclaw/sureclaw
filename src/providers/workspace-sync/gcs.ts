/**
 * GCS workspace sync provider.
 *
 * Write-through with eager-pull: local disk stays the fast path for reads,
 * GCS is the durable source of truth for multi-host and ephemeral deployments.
 *
 * Auth: Uses Application Default Credentials (ADC) — works with GKE
 * Workload Identity, service account keys, or `gcloud auth application-default login`.
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Storage } from '@google-cloud/storage';
import type { Config } from '../../types.js';
import type { WorkspaceSyncProvider, SyncResult } from './types.js';
import { loadManifest, saveManifest, updateManifestEntry, removeManifestEntry } from './manifest.js';
import { getLogger } from '../../logger.js';

const logger = getLogger().child({ component: 'workspace-sync-gcs' });
const hostId = randomUUID().slice(0, 8);

export async function create(config: Config): Promise<WorkspaceSyncProvider> {
  const syncConfig = config.workspace_sync;
  if (!syncConfig?.bucket) {
    throw new Error('workspace_sync.bucket is required for GCS workspace sync provider');
  }

  const storage = new Storage();
  const bucket = storage.bucket(syncConfig.bucket);
  const globalPrefix = syncConfig.prefix ?? '';

  function fullPrefix(remotePrefix: string): string {
    return globalPrefix ? `${globalPrefix}/${remotePrefix}` : remotePrefix;
  }

  return {
    async pull(localDir: string, remotePrefix: string): Promise<SyncResult> {
      const start = Date.now();
      const prefix = fullPrefix(remotePrefix);
      const manifest = loadManifest(localDir);
      let filesUpdated = 0;
      let filesDeleted = 0;
      let bytesTransferred = 0;

      // List all objects under the prefix
      const [files] = await bucket.getFiles({ prefix });
      const remoteKeys = new Set<string>();

      for (const file of files) {
        const relativePath = file.name.slice(prefix.length);
        if (!relativePath) continue; // skip the prefix-only entry
        remoteKeys.add(relativePath);

        const [metadata] = await file.getMetadata();
        const remoteEtag = metadata.etag ?? '';
        const remoteSize = Number(metadata.size ?? 0);

        // Check manifest: skip if ETags match
        const entry = manifest[relativePath];
        if (entry && entry.etag === remoteEtag) {
          continue;
        }

        // Download the file
        const destPath = join(localDir, relativePath);
        mkdirSync(dirname(destPath), { recursive: true });
        const [contents] = await file.download();
        writeFileSync(destPath, contents);
        bytesTransferred += contents.length;
        filesUpdated++;

        // Update manifest
        const writeTs = metadata.metadata?.['write-ts']
          ? Number(metadata.metadata['write-ts'])
          : Date.now();
        manifest[relativePath] = { etag: remoteEtag, writeTs, size: remoteSize };
      }

      // Delete local files that no longer exist in remote
      for (const localKey of Object.keys(manifest)) {
        if (!remoteKeys.has(localKey)) {
          try {
            unlinkSync(join(localDir, localKey));
          } catch { /* file may already be gone */ }
          delete manifest[localKey];
          filesDeleted++;
        }
      }

      saveManifest(localDir, manifest);
      const durationMs = Date.now() - start;
      logger.info('pull_complete', { remotePrefix, filesUpdated, filesDeleted, bytesTransferred, durationMs });
      return { filesUpdated, filesDeleted, bytesTransferred, durationMs };
    },

    async uploadFile(localDir: string, remotePrefix: string, relativePath: string): Promise<void> {
      const prefix = fullPrefix(remotePrefix);
      const localPath = join(localDir, relativePath);

      let data: Buffer;
      try {
        data = readFileSync(localPath);
      } catch (err) {
        logger.warn('upload_read_failed', { localPath, error: (err as Error).message });
        return;
      }

      const remoteName = `${prefix}${relativePath}`;
      const file = bucket.file(remoteName);
      await file.save(data, {
        metadata: {
          metadata: {
            'host-id': hostId,
            'write-ts': String(Date.now()),
          },
        },
      });

      // Update local manifest with the uploaded file's metadata
      const [metadata] = await file.getMetadata();
      updateManifestEntry(localDir, relativePath, {
        etag: metadata.etag ?? '',
        writeTs: Date.now(),
        size: data.length,
      });

      logger.debug('upload_complete', { remoteName, bytes: data.length });
    },

    async pushAll(localDir: string, remotePrefix: string): Promise<SyncResult> {
      const start = Date.now();
      let filesUpdated = 0;
      let bytesTransferred = 0;

      // Walk local directory recursively
      function walkDir(dir: string): string[] {
        const entries: string[] = [];
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (entry.name === '.gcs-manifest.json') continue;
          const fullPath = join(dir, entry.name);
          if (entry.isDirectory()) {
            entries.push(...walkDir(fullPath));
          } else {
            entries.push(fullPath);
          }
        }
        return entries;
      }

      const allFiles = walkDir(localDir);
      const prefix = fullPrefix(remotePrefix);
      const manifest = loadManifest(localDir);

      for (const filePath of allFiles) {
        const relativePath = relative(localDir, filePath);
        const data = readFileSync(filePath);
        const remoteName = `${prefix}${relativePath}`;
        const file = bucket.file(remoteName);

        await file.save(data, {
          metadata: {
            metadata: {
              'host-id': hostId,
              'write-ts': String(Date.now()),
            },
          },
        });

        const [metadata] = await file.getMetadata();
        manifest[relativePath] = {
          etag: metadata.etag ?? '',
          writeTs: Date.now(),
          size: data.length,
        };

        filesUpdated++;
        bytesTransferred += data.length;
      }

      saveManifest(localDir, manifest);
      const durationMs = Date.now() - start;
      logger.info('push_all_complete', { remotePrefix, filesUpdated, bytesTransferred, durationMs });
      return { filesUpdated, filesDeleted: 0, bytesTransferred, durationMs };
    },

    async deleteFile(remotePrefix: string, relativePath: string): Promise<void> {
      const prefix = fullPrefix(remotePrefix);
      const remoteName = `${prefix}${relativePath}`;
      try {
        await bucket.file(remoteName).delete();
      } catch (err) {
        logger.warn('delete_failed', { remoteName, error: (err as Error).message });
      }
    },
  };
}
