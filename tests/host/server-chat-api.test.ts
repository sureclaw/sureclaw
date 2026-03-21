import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { create } from '../../src/providers/storage/database.js';
import { create as createSqliteDb } from '../../src/providers/database/sqlite.js';
import type { StorageProvider } from '../../src/providers/storage/types.js';
import type { DatabaseProvider } from '../../src/providers/database/types.js';
import type { Config } from '../../src/types.js';
import { createChatApiHandler } from '../../src/host/server-chat-api.js';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const config = {} as Config;

function request(server: http.Server, method: string, path: string, body?: any): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, `http://localhost:${(server.address() as any).port}`);
    const req = http.request(url, { method, headers: { 'Content-Type': 'application/json' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode!, data: data ? JSON.parse(data) : null }));
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

describe('Chat API', () => {
  let storage: StorageProvider;
  let database: DatabaseProvider;
  let server: http.Server;
  let testHome: string;

  beforeEach(async () => {
    testHome = join(tmpdir(), `ax-chat-api-test-${randomUUID()}`);
    mkdirSync(testHome, { recursive: true });
    process.env.AX_HOME = testHome;
    database = await createSqliteDb(config);
    storage = await create(config, 'database', { database });
    const handler = createChatApiHandler(storage);
    server = http.createServer(async (req, res) => {
      const handled = await handler(req, res);
      if (!handled) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Not found' }));
      }
    });
    await new Promise<void>(resolve => server.listen(0, resolve));
  });

  afterEach(async () => {
    try { storage.close(); } catch {}
    try { await database.close(); } catch {}
    await new Promise<void>(resolve => server.close(() => resolve()));
    try { rmSync(testHome, { recursive: true, force: true }); } catch {}
    delete process.env.AX_HOME;
  });

  it('GET /v1/chat/sessions returns empty list initially', async () => {
    const { status, data } = await request(server, 'GET', '/v1/chat/sessions');
    expect(status).toBe(200);
    expect(data.sessions).toEqual([]);
  });

  it('POST /v1/chat/sessions creates a session', async () => {
    const { status, data } = await request(server, 'POST', '/v1/chat/sessions', { title: 'Test' });
    expect(status).toBe(201);
    expect(data.id).toBeTruthy();
    expect(data.title).toBe('Test');
  });

  it('GET /v1/chat/sessions/:id/history returns turns', async () => {
    const sessionId = 'test-session';
    await storage.chatSessions.create({ id: sessionId });
    await storage.conversations.append(sessionId, 'user', 'Hello');
    await storage.conversations.append(sessionId, 'assistant', 'Hi there!');

    const { status, data } = await request(server, 'GET', `/v1/chat/sessions/${sessionId}/history`);
    expect(status).toBe(200);
    expect(data.messages).toHaveLength(2);
    expect(data.messages[0].role).toBe('user');
    expect(data.messages[0].content).toBe('Hello');
    expect(data.messages[1].role).toBe('assistant');
  });

  it('GET /v1/chat/sessions/:id/history returns empty for unknown session', async () => {
    const { status, data } = await request(server, 'GET', '/v1/chat/sessions/nonexistent/history');
    expect(status).toBe(200);
    expect(data.messages).toEqual([]);
  });
});
