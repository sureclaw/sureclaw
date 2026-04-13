/**
 * IPC handler: save_artifact — write a file for user download.
 *
 * Extracted from the workspace handler during workspace provider removal.
 * Writes directly to GCS (k8s) or a local temp path (dev), without
 * depending on the workspace provider.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { ProviderRegistry } from '../../types.js';
import type { IPCContext } from '../ipc-server.js';
import { safePath } from '../../utils/safe-path.js';
import type { GcsFileStorage } from '../gcs-file-storage.js';
import type { FileStore } from '../../file-store.js';

/** Extension to MIME type mapping for artifact uploads. */
const EXT_TO_MIME: Record<string, string> = {
  pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv', md: 'text/markdown',
  json: 'application/json', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
};

export interface ArtifactHandlerOptions {
  agentId: string;
  gcsFileStorage?: GcsFileStorage;
  fileStore?: FileStore;
  /** Callback invoked when a file is written and uploaded, so the response can include it. */
  onArtifactWritten?: (fileId: string, mimeType: string, filename: string) => void;
}

export function createArtifactHandlers(providers: ProviderRegistry, opts: ArtifactHandlerOptions) {
  return {
    save_artifact: async (req: any, ctx: IPCContext) => {
      const ext = req.path.split('.').pop() ?? '';
      const mimeType = EXT_TO_MIME[ext] ?? 'application/octet-stream';
      const originalFilename = req.path.split('/').pop() ?? req.path;
      // Detect base64-encoded binary content (e.g., PDFs, images, XLSX)
      const isBase64 = /^[A-Za-z0-9+/\n]+=*$/.test(req.content.replace(/\s/g, ''));
      const buf = isBase64 && req.content.length > 100
        ? Buffer.from(req.content, 'base64')
        : Buffer.from(req.content, 'utf-8');

      // Upload to GCS when available (k8s / cloud mode)
      if (opts.gcsFileStorage) {
        const fileId = `files/${randomUUID()}.${ext}`;
        await opts.gcsFileStorage.upload(fileId, buf, mimeType, originalFilename);
        await opts.fileStore?.register(fileId, opts.agentId, ctx.userId ?? 'unknown', mimeType, originalFilename);
        opts.onArtifactWritten?.(fileId, mimeType, originalFilename);

        await providers.audit.log({
          action: 'save_artifact',
          sessionId: ctx.sessionId,
          args: { tier: req.tier, path: req.path, bytes: req.content.length },
          result: 'success',
        });

        return { written: true, tier: req.tier, path: req.path, fileId };
      }

      // Local fallback: write to a temp directory under OS tmpdir
      const localDir = safePath(tmpdir(), 'ax-artifacts', ctx.sessionId);
      const segments = req.path.split(/[/\\]/).filter(Boolean);
      const filePath = safePath(localDir, ...segments);
      mkdirSync(dirname(filePath), { recursive: true });
      const localIsBase64 = /^[A-Za-z0-9+/\n]+=*$/.test(req.content.replace(/\s/g, ''));
      const localBuf = localIsBase64 && req.content.length > 100
        ? Buffer.from(req.content, 'base64')
        : Buffer.from(req.content, 'utf-8');
      writeFileSync(filePath, localBuf);

      await providers.audit.log({
        action: 'save_artifact',
        sessionId: ctx.sessionId,
        args: { tier: req.tier, path: req.path, bytes: req.content.length },
        result: 'success',
      });

      return { written: true, tier: req.tier, path: req.path };
    },
  };
}
