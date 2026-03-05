/**
 * File upload/download API for the web UI.
 *
 * Stores files in the enterprise user workspace under a `files/` subdirectory.
 * Images referenced in chat messages use fileId values relative to the
 * workspace root (e.g. "files/abc123.png").
 *
 * Endpoints:
 *   POST /v1/files?agent=<name>&user=<id>   — upload a file (raw binary body)
 *   GET  /v1/files/<fileId>?agent=<name>&user=<id> — download a file
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { userWorkspaceDir } from '../paths.js';
import { safePath } from '../utils/safe-path.js';
import { sendError } from './server-http.js';
import type { ImageMimeType } from '../types.js';
import { IMAGE_MIME_TYPES } from '../types.js';
import { getLogger } from '../logger.js';
import type { FileStore } from '../file-store.js';

const logger = getLogger().child({ component: 'files' });

export interface FileDeps {
  fileStore?: FileStore;
}

/** Max upload size: 10 MB. */
const MAX_FILE_SIZE = 10 * 1024 * 1024;

/** Map MIME types to file extensions. */
const MIME_TO_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

/** Map extensions back to MIME types for download. */
const EXT_TO_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/** Read raw binary body from a request, with a size limit. */
async function readBinaryBody(req: IncomingMessage, maxSize: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxSize) throw new Error('File too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/** Valid name segment: alphanumeric, underscore, hyphen, dot, @ — same as paths.ts validatePathSegment. */
const SAFE_NAME_RE = /^[a-zA-Z0-9_.@-]+$/;

/** Extract a query parameter from a URL string. */
function getQueryParam(url: string, name: string): string | undefined {
  const idx = url.indexOf('?');
  if (idx < 0) return undefined;
  const params = new URLSearchParams(url.slice(idx));
  return params.get(name) ?? undefined;
}

/**
 * Handle POST /v1/files — upload a file to the user workspace.
 *
 * Expects raw binary body with Content-Type header indicating MIME type.
 * Returns JSON: { fileId, mimeType, size }
 */
export async function handleFileUpload(
  req: IncomingMessage,
  res: ServerResponse,
  deps?: FileDeps,
): Promise<void> {
  const url = req.url ?? '';
  const agent = getQueryParam(url, 'agent');
  const user = getQueryParam(url, 'user');

  if (!agent || !SAFE_NAME_RE.test(agent) || !user || !SAFE_NAME_RE.test(user)) {
    sendError(res, 400, 'Missing or invalid agent/user query parameters');
    return;
  }

  // Validate MIME type
  const contentType = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (!IMAGE_MIME_TYPES.includes(contentType as ImageMimeType)) {
    sendError(res, 400, `Unsupported content type: ${contentType}. Allowed: ${IMAGE_MIME_TYPES.join(', ')}`);
    return;
  }

  // Read binary body
  let body: Buffer;
  try {
    body = await readBinaryBody(req, MAX_FILE_SIZE);
  } catch {
    sendError(res, 413, `File too large. Maximum size: ${MAX_FILE_SIZE / (1024 * 1024)}MB`);
    return;
  }

  if (body.length === 0) {
    sendError(res, 400, 'Empty file body');
    return;
  }

  // Generate unique filename and store
  const ext = MIME_TO_EXT[contentType] ?? '.bin';
  const filename = `${randomUUID()}${ext}`;
  const wsDir = userWorkspaceDir(agent, user);
  const filesDir = safePath(wsDir, 'files');
  mkdirSync(filesDir, { recursive: true });
  const filePath = safePath(filesDir, filename);
  writeFileSync(filePath, body);

  const fileId = `files/${filename}`;
  deps?.fileStore?.register(fileId, agent, user, contentType);
  const responseBody = JSON.stringify({ fileId, mimeType: contentType, size: body.length });
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(responseBody),
  });
  res.end(responseBody);
}

/**
 * Handle GET /v1/files/<fileId> — download a file from the user workspace.
 *
 * Requires agent and user query parameters. Serves the file with correct Content-Type.
 */
export async function handleFileDownload(
  req: IncomingMessage,
  res: ServerResponse,
  deps?: FileDeps,
): Promise<void> {
  const url = req.url ?? '';

  // Extract fileId from URL path: /v1/files/<fileId>
  const pathPart = url.split('?')[0];
  const prefix = '/v1/files/';
  if (!pathPart.startsWith(prefix)) {
    sendError(res, 400, 'Invalid file path');
    return;
  }
  const fileId = decodeURIComponent(pathPart.slice(prefix.length));
  if (!fileId) {
    sendError(res, 400, 'Missing file ID');
    return;
  }

  // Resolve agent/user: prefer query params, fall back to FileStore lookup
  let agent = getQueryParam(url, 'agent');
  let user = getQueryParam(url, 'user');

  if ((!agent || !user) && deps?.fileStore) {
    const entry = await deps.fileStore.lookup(fileId);
    if (entry) {
      agent = entry.agentName;
      user = entry.userId;
    }
  }

  if (!agent || !SAFE_NAME_RE.test(agent) || !user || !SAFE_NAME_RE.test(user)) {
    sendError(res, 404, 'File not found');
    return;
  }

  // Resolve file path safely
  const wsDir = userWorkspaceDir(agent, user);
  const segments = fileId.split('/').filter(Boolean);
  const filePath = safePath(wsDir, ...segments);

  if (!existsSync(filePath)) {
    logger.debug('file_not_found', { fileId, agent, user, wsDir, filePath });
    sendError(res, 404, 'File not found');
    return;
  }

  // Determine MIME type from extension
  const ext = extname(basename(filePath)).toLowerCase();
  const mimeType = EXT_TO_MIME[ext] ?? 'application/octet-stream';

  const data = readFileSync(filePath);
  res.writeHead(200, {
    'Content-Type': mimeType,
    'Content-Length': data.length,
    'Cache-Control': 'private, max-age=3600',
  });
  res.end(data);
}
