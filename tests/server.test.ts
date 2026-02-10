import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { createServer, type AxServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';

/** Send an HTTP request over a Unix socket */
function sendRequest(
  socket: string,
  path: string,
  opts: { method?: string; body?: unknown } = {},
): Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const bodyStr = opts.body ? JSON.stringify(opts.body) : undefined;
    const req = httpRequest(
      {
        socketPath: socket,
        path,
        method: opts.method ?? 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf-8'),
            headers: res.headers,
          });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

describe('Server', () => {
  let server: AxServer;
  let socketPath: string;

  beforeEach(() => {
    socketPath = join(tmpdir(), `ax-test-${randomUUID()}.sock`);
  });

  afterEach(async () => {
    if (server) {
      await server.stop();
    }
    try {
      unlinkSync(socketPath);
    } catch {
      // ignore
    }
  });

  // --- Lifecycle ---

  it('should start server on Unix socket', async () => {
    const config = loadConfig('tests/integration/ax-test.yaml');
    server = await createServer(config, { socketPath });
    await server.start();
    expect(server.listening).toBe(true);
  });

  it('should remove stale socket on startup', async () => {
    writeFileSync(socketPath, '');
    const config = loadConfig('tests/integration/ax-test.yaml');
    server = await createServer(config, { socketPath });
    await server.start();
    expect(server.listening).toBe(true);
  });

  it('should stop server gracefully', async () => {
    const config = loadConfig('tests/integration/ax-test.yaml');
    server = await createServer(config, { socketPath });
    await server.start();
    await server.stop();
    expect(server.listening).toBe(false);
  });

  // --- Request/Response ---

  it('should return OpenAI-format non-streaming response', async () => {
    const config = loadConfig('tests/integration/ax-test.yaml');
    server = await createServer(config, { socketPath });
    await server.start();

    const res = await sendRequest(socketPath, '/v1/chat/completions', {
      body: { messages: [{ role: 'user', content: 'hello' }] },
    });

    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.id).toMatch(/^chatcmpl-/);
    expect(data.object).toBe('chat.completion');
    expect(data.choices).toHaveLength(1);
    expect(data.choices[0].message.role).toBe('assistant');
    expect(data.choices[0].message.content.length).toBeGreaterThan(0);
    expect(data.choices[0].finish_reason).toBe('stop');
    expect(typeof data.created).toBe('number');
    expect(data.usage).toBeDefined();
  });

  it('should return SSE stream for streaming requests', async () => {
    const config = loadConfig('tests/integration/ax-test.yaml');
    server = await createServer(config, { socketPath });
    await server.start();

    const res = await sendRequest(socketPath, '/v1/chat/completions', {
      body: { messages: [{ role: 'user', content: 'hello' }], stream: true },
    });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/event-stream');

    const lines = res.body.split('\n').filter((l) => l.startsWith('data: '));
    // role chunk, content chunk, finish chunk, [DONE]
    expect(lines.length).toBeGreaterThanOrEqual(4);

    const roleChunk = JSON.parse(lines[0].replace('data: ', ''));
    expect(roleChunk.object).toBe('chat.completion.chunk');
    expect(roleChunk.choices[0].delta.role).toBe('assistant');

    const contentChunk = JSON.parse(lines[1].replace('data: ', ''));
    expect(contentChunk.choices[0].delta.content.length).toBeGreaterThan(0);

    const finishChunk = JSON.parse(lines[2].replace('data: ', ''));
    expect(finishChunk.choices[0].finish_reason).toBe('stop');

    expect(lines[3]).toBe('data: [DONE]');
  });

  it('should return 400 for empty messages array', async () => {
    const config = loadConfig('tests/integration/ax-test.yaml');
    server = await createServer(config, { socketPath });
    await server.start();

    const res = await sendRequest(socketPath, '/v1/chat/completions', {
      body: { messages: [] },
    });

    expect(res.status).toBe(400);
    const data = JSON.parse(res.body);
    expect(data.error.message).toContain('messages');
  });

  it('should return 400 for invalid JSON body', async () => {
    const config = loadConfig('tests/integration/ax-test.yaml');
    server = await createServer(config, { socketPath });
    await server.start();

    // Send raw invalid JSON through the socket
    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpRequest(
        {
          socketPath,
          path: '/v1/chat/completions',
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': 12 },
        },
        (r) => {
          const chunks: Buffer[] = [];
          r.on('data', (chunk) => chunks.push(chunk));
          r.on('end', () => resolve({
            status: r.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf-8'),
          }));
          r.on('error', reject);
        },
      );
      req.on('error', reject);
      req.write('not json {{{');
      req.end();
    });

    expect(res.status).toBe(400);
    const data = JSON.parse(res.body);
    expect(data.error.message).toContain('Invalid JSON');
  });

  it('should return 404 for unknown endpoints', async () => {
    const config = loadConfig('tests/integration/ax-test.yaml');
    server = await createServer(config, { socketPath });
    await server.start();

    const res = await sendRequest(socketPath, '/v1/unknown', { method: 'GET' });
    expect(res.status).toBe(404);
  });

  it('should return model list from /v1/models', async () => {
    const config = loadConfig('tests/integration/ax-test.yaml');
    server = await createServer(config, { socketPath });
    await server.start();

    const res = await sendRequest(socketPath, '/v1/models', { method: 'GET' });

    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.object).toBe('list');
    expect(data.data).toHaveLength(1);
    expect(data.data[0].owned_by).toBe('ax');
  });
});
