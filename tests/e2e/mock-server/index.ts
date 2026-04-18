/**
 * Mock server — single HTTP server that dispatches to all mock handlers.
 *
 * Routes:
 * - /v1/chat/completions, /v1/models  → OpenRouter
 * - /storage/..., /upload/...          → GCS
 * - /graphql                           → Linear
 * - /health                            → health check
 * - /web-fetch-target                  → canned HTML for web_fetch tests
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { handleGCS, resetGCS } from './gcs.js';
import { handleOpenRouter, resetOpenRouter } from './openrouter.js';
import { handleLinear, resetLinear } from './linear.js';

let server: Server | null = null;

export interface MockServerInfo {
  port: number;
  host: string;
  url: string;
}

/** Start the mock server on all interfaces (0.0.0.0) so kind containers can reach it. */
export async function startMockServer(port = 0): Promise<MockServerInfo> {
  return new Promise((resolve, reject) => {
    server = createServer(routeRequest);
    server.on('error', reject);
    server.listen(port, '0.0.0.0', () => {
      const addr = server!.address() as AddressInfo;
      const info: MockServerInfo = {
        port: addr.port,
        host: '0.0.0.0',
        url: `http://0.0.0.0:${addr.port}`,
      };
      resolve(info);
    });
  });
}

/** Stop the mock server. */
export function stopMockServer(): void {
  if (server) {
    server.close();
    server = null;
  }
}

/** Reset all mock state (GCS files, turn queue position, Linear auth). */
export function resetAll(): void {
  resetGCS();
  resetOpenRouter();
  resetLinear();
}

function routeRequest(req: IncomingMessage, res: ServerResponse): void {
  const url = req.url ?? '';

  // Health check
  if (url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  // Canned HTML for web_fetch tests
  if (url === '/web-fetch-target') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><body><h1>Mock Web Page</h1><p>This is a test page for web_fetch acceptance testing.</p></body></html>');
    return;
  }

  // OpenRouter — /v1/chat/completions, /v1/models
  if (url.startsWith('/v1/')) {
    handleOpenRouter(req, res);
    return;
  }

  // GCS — /storage/..., /upload/...
  if (url.startsWith('/storage/') || url.startsWith('/upload/')) {
    handleGCS(req, res);
    return;
  }

  // Linear — /graphql
  if (url.startsWith('/graphql')) {
    handleLinear(req, res);
    return;
  }

  // Reset endpoint (for test cleanup)
  if (url === '/reset' && req.method === 'POST') {
    resetAll();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ reset: true }));
    return;
  }

  // 404 for everything else
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found', path: url }));
}
