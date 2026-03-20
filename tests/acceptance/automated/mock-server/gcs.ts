/**
 * Minimal GCS-compatible HTTP handler backed by an in-memory Map.
 *
 * When the @google-cloud/storage SDK has STORAGE_EMULATOR_HOST set,
 * it hits these endpoints instead of the real GCS API.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// In-memory store
// ---------------------------------------------------------------------------

interface StoredObject {
  bucket: string;
  name: string;
  content: Buffer;
  contentType: string;
}

const files = new Map<string, StoredObject>();

// Pending resumable uploads: upload_id -> { bucket, name, contentType }
const pendingUploads = new Map<
  string,
  { bucket: string; name: string; contentType: string }
>();

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

/** Clear all stored data (files + pending uploads). */
export function resetGCS(): void {
  files.clear();
  pendingUploads.clear();
}

/** Return the internal file map for test assertions. */
export function getGCSFiles(): Map<string, StoredObject> {
  return files;
}

// ---------------------------------------------------------------------------
// Metadata helper
// ---------------------------------------------------------------------------

function objectMeta(obj: StoredObject) {
  const now = new Date().toISOString();
  return {
    kind: 'storage#object',
    id: `${obj.bucket}/${obj.name}`,
    name: obj.name,
    bucket: obj.bucket,
    size: String(obj.content.length),
    contentType: obj.contentType,
    timeCreated: now,
    updated: now,
  };
}

// ---------------------------------------------------------------------------
// Body collection helper
// ---------------------------------------------------------------------------

function collectBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Route matching helpers
// ---------------------------------------------------------------------------

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export async function handleGCS(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const method = req.method ?? 'GET';
  const parsed = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const pathname = parsed.pathname;
  const query = parsed.searchParams;

  try {
    // -----------------------------------------------------------------------
    // Upload endpoints: /upload/storage/v1/b/{bucket}/o
    // -----------------------------------------------------------------------
    const uploadMatch = pathname.match(
      /^\/upload\/storage\/v1\/b\/([^/]+)\/o$/,
    );
    if (uploadMatch) {
      const bucket = decodeURIComponent(uploadMatch[1]);
      const uploadType = query.get('uploadType');

      // Resumable upload — initiate
      if (method === 'POST' && uploadType === 'resumable') {
        const name = query.get('name') ?? '';
        const body = await collectBody(req);
        let contentType = 'application/octet-stream';
        try {
          const parsed = JSON.parse(body.toString());
          if (parsed.contentType) contentType = parsed.contentType;
        } catch {
          // ignore parse errors
        }

        const uploadId = randomUUID();
        pendingUploads.set(uploadId, { bucket, name, contentType });

        const location = `http://${req.headers.host}/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=resumable&upload_id=${uploadId}`;
        res.writeHead(200, { Location: location, 'Content-Length': '0' });
        res.end();
        return;
      }

      // Resumable upload — PUT with upload_id
      if (method === 'PUT' && uploadType === 'resumable') {
        const uploadId = query.get('upload_id') ?? '';
        const pending = pendingUploads.get(uploadId);
        if (!pending) {
          json(res, 404, { error: { code: 404, message: 'Upload not found' } });
          return;
        }

        const content = await collectBody(req);
        const obj: StoredObject = {
          bucket: pending.bucket,
          name: pending.name,
          content,
          contentType: pending.contentType,
        };
        files.set(`${obj.bucket}/${obj.name}`, obj);
        pendingUploads.delete(uploadId);
        json(res, 200, objectMeta(obj));
        return;
      }

      // Multipart (single-shot) upload
      if (method === 'POST' && uploadType === 'multipart') {
        const name = query.get('name') ?? '';
        const content = await collectBody(req);
        const contentType =
          req.headers['content-type'] ?? 'application/octet-stream';
        const obj: StoredObject = { bucket, name, content, contentType };
        files.set(`${bucket}/${name}`, obj);
        json(res, 200, objectMeta(obj));
        return;
      }
    }

    // -----------------------------------------------------------------------
    // Object endpoints: /storage/v1/b/{bucket}/o[/{name}]
    // -----------------------------------------------------------------------
    const objectsMatch = pathname.match(
      /^\/storage\/v1\/b\/([^/]+)\/o(?:\/(.+))?$/,
    );
    if (objectsMatch) {
      const bucket = decodeURIComponent(objectsMatch[1]);
      const rawName = objectsMatch[2]; // may be undefined (list) or URL-encoded

      // List objects
      if (!rawName && method === 'GET') {
        const prefix = query.get('prefix') ?? '';
        const items: unknown[] = [];
        for (const obj of files.values()) {
          if (obj.bucket === bucket && obj.name.startsWith(prefix)) {
            items.push(objectMeta(obj));
          }
        }
        json(res, 200, { kind: 'storage#objects', items });
        return;
      }

      if (rawName) {
        const name = decodeURIComponent(rawName);
        const key = `${bucket}/${name}`;

        // Download content
        if (method === 'GET' && query.get('alt') === 'media') {
          const obj = files.get(key);
          if (!obj) {
            json(res, 404, { error: { code: 404, message: 'Not Found' } });
            return;
          }
          res.writeHead(200, {
            'Content-Type': obj.contentType,
            'Content-Length': obj.content.length,
          });
          res.end(obj.content);
          return;
        }

        // Get metadata
        if (method === 'GET') {
          const obj = files.get(key);
          if (!obj) {
            json(res, 404, { error: { code: 404, message: 'Not Found' } });
            return;
          }
          json(res, 200, objectMeta(obj));
          return;
        }

        // Delete
        if (method === 'DELETE') {
          const deleted = files.delete(key);
          if (!deleted) {
            json(res, 404, { error: { code: 404, message: 'Not Found' } });
            return;
          }
          res.writeHead(204);
          res.end();
          return;
        }
      }
    }

    // -----------------------------------------------------------------------
    // Fallback
    // -----------------------------------------------------------------------
    json(res, 404, { error: { code: 404, message: `Unknown route: ${method} ${pathname}` } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    json(res, 500, { error: { code: 500, message } });
  }
}
