/**
 * Chat UI static file serving.
 * Serves the built chat UI from dist/chat-ui/ at the root path.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendError } from './server-http.js';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
};

function resolveChatUIDir(): string {
  // Sibling of host/ when running from dist/: dist/chat-ui/
  const siblingDir = resolve(import.meta.dirname, '../chat-ui');
  if (existsSync(siblingDir)) return siblingDir;
  // Fallback: dist/chat-ui/ when running from src/host/ (dev mode with tsx)
  const distDir = resolve(import.meta.dirname, '../../dist/chat-ui');
  if (existsSync(distDir)) return distDir;
  return siblingDir;
}

export function createChatUIHandler() {
  const chatUIDir = resolveChatUIDir();

  return (_req: IncomingMessage, res: ServerResponse, pathname: string): void => {
    if (!existsSync(chatUIDir)) {
      sendError(res, 404, 'Chat UI not built. Run: npm run build:chat');
      return;
    }

    // Strip leading slash, default to index.html
    let filePath = pathname === '/' ? 'index.html' : pathname.slice(1);

    // Path traversal check
    if (filePath.includes('..')) {
      sendError(res, 400, 'Invalid path');
      return;
    }

    const fullPath = join(chatUIDir, filePath);
    const ext = extname(fullPath);

    if (existsSync(fullPath)) {
      const content = readFileSync(fullPath);
      const mime = MIME_TYPES[ext] ?? 'application/octet-stream';
      const isHtml = ext === '.html';
      res.writeHead(200, {
        'Content-Type': mime,
        'Content-Length': content.length,
        'Cache-Control': isHtml ? 'no-cache' : 'public, max-age=31536000, immutable',
      });
      res.end(content);
    } else {
      // SPA fallback: serve index.html for non-asset routes
      const indexPath = join(chatUIDir, 'index.html');
      if (existsSync(indexPath)) {
        const content = readFileSync(indexPath);
        res.writeHead(200, {
          'Content-Type': 'text/html',
          'Content-Length': content.length,
          'Cache-Control': 'no-cache',
        });
        res.end(content);
      } else {
        sendError(res, 404, 'Not found');
      }
    }
  };
}
