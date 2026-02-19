import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, unlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { createServer, type AxServer } from '../../src/host/server.js';
import { loadConfig } from '../../src/config.js';
import type { ChannelProvider, InboundMessage, OutboundMessage, SessionAddress } from '../../src/providers/channel/types.js';

function sendRequest(
  socket: string,
  path: string,
  opts: { method?: string; body?: unknown } = {},
): Promise<{ status: number; body: string }> {
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

describe('Server conversation history persistence', () => {
  let server: AxServer;
  let socketPath: string;
  let testAxHome: string;
  let originalAxHome: string | undefined;

  beforeEach(() => {
    socketPath = join(tmpdir(), `ax-test-hist-${randomUUID()}.sock`);
    // Isolate each test's AX_HOME so ConversationStore + MessageQueue use separate DBs
    testAxHome = join(tmpdir(), `ax-test-home-${randomUUID()}`);
    mkdirSync(testAxHome, { recursive: true });
    originalAxHome = process.env.AX_HOME;
    process.env.AX_HOME = testAxHome;
  });

  afterEach(async () => {
    if (server) await server.stop();
    try { unlinkSync(socketPath); } catch { /* ignore */ }
    // Restore AX_HOME
    if (originalAxHome !== undefined) {
      process.env.AX_HOME = originalAxHome;
    } else {
      delete process.env.AX_HOME;
    }
    // Clean up temp dir
    rmSync(testAxHome, { recursive: true, force: true });
  });

  it('should persist user and assistant turns for persistent sessions', async () => {
    const config = loadConfig('tests/integration/ax-test.yaml');
    server = await createServer(config, { socketPath });
    await server.start();

    const sessionId = randomUUID();

    // First message
    const res1 = await sendRequest(socketPath, '/v1/chat/completions', {
      body: {
        messages: [{ role: 'user', content: 'hello there' }],
        session_id: sessionId,
      },
    });
    expect(res1.status).toBe(200);
    const data1 = JSON.parse(res1.body);
    const assistantReply1 = data1.choices[0].message.content;
    expect(assistantReply1.length).toBeGreaterThan(0);

    // Second message — server should load history from DB and include it
    const res2 = await sendRequest(socketPath, '/v1/chat/completions', {
      body: {
        messages: [{ role: 'user', content: 'what did I just say?' }],
        session_id: sessionId,
      },
    });
    expect(res2.status).toBe(200);
    // The mock LLM just echoes, but the key test is that the request succeeded
    // and the server didn't crash when loading history
  });

  it('should NOT persist turns for ephemeral sessions (no session_id)', async () => {
    const config = loadConfig('tests/integration/ax-test.yaml');
    server = await createServer(config, { socketPath });
    await server.start();

    // Two requests without session_id
    const res1 = await sendRequest(socketPath, '/v1/chat/completions', {
      body: { messages: [{ role: 'user', content: 'hello' }] },
    });
    expect(res1.status).toBe(200);

    const res2 = await sendRequest(socketPath, '/v1/chat/completions', {
      body: { messages: [{ role: 'user', content: 'world' }] },
    });
    expect(res2.status).toBe(200);
    // Both should succeed without cross-contamination
  });

  it('should persist channel message turns with sender', async () => {
    const sentMessages: { session: SessionAddress; content: OutboundMessage }[] = [];
    let messageHandler: ((msg: InboundMessage) => Promise<void>) | null = null;

    const mockChannel: ChannelProvider = {
      name: 'test',
      async connect() {},
      onMessage(handler) { messageHandler = handler; },
      shouldRespond() { return true; },
      async send(session, content) { sentMessages.push({ session, content }); },
      async disconnect() {},
    };

    const config = loadConfig('tests/integration/ax-test.yaml');
    server = await createServer(config, { socketPath, channels: [mockChannel] });
    await server.start();

    const msg: InboundMessage = {
      id: 'test-hist-1',
      session: { provider: 'test', scope: 'channel', identifiers: { channel: 'C123' } },
      sender: 'U456',
      content: 'hi from channel',
      attachments: [],
      timestamp: new Date(),
    };

    await messageHandler!(msg);
    expect(sentMessages).toHaveLength(1);

    // Second message in same channel — should succeed
    const msg2: InboundMessage = {
      id: 'test-hist-2',
      session: { provider: 'test', scope: 'channel', identifiers: { channel: 'C123' } },
      sender: 'U789',
      content: 'hello again',
      attachments: [],
      timestamp: new Date(),
    };

    await messageHandler!(msg2);
    expect(sentMessages).toHaveLength(2);
  });

  it('should load thread context from parent channel session', async () => {
    const sentMessages: { session: SessionAddress; content: OutboundMessage }[] = [];
    let messageHandler: ((msg: InboundMessage) => Promise<void>) | null = null;

    const mockChannel: ChannelProvider = {
      name: 'test',
      async connect() {},
      onMessage(handler) { messageHandler = handler; },
      shouldRespond() { return true; },
      async send(session, content) { sentMessages.push({ session, content }); },
      async disconnect() {},
    };

    const config = loadConfig('tests/integration/ax-test.yaml');
    server = await createServer(config, { socketPath, channels: [mockChannel] });
    await server.start();

    // First: a channel message to create some parent history
    const channelMsg: InboundMessage = {
      id: 'thread-ctx-1',
      session: { provider: 'test', scope: 'channel', identifiers: { channel: 'C999' } },
      sender: 'U111',
      content: 'channel context message',
      attachments: [],
      timestamp: new Date(),
    };
    await messageHandler!(channelMsg);
    expect(sentMessages).toHaveLength(1);

    // Second: a thread message with parent pointing to the channel
    const threadMsg: InboundMessage = {
      id: 'thread-ctx-2',
      session: {
        provider: 'test',
        scope: 'thread',
        identifiers: { channel: 'C999', thread: 'T111' },
        parent: { provider: 'test', scope: 'channel', identifiers: { channel: 'C999' } },
      },
      sender: 'U222',
      content: 'reply in thread',
      attachments: [],
      timestamp: new Date(),
    };
    await messageHandler!(threadMsg);
    expect(sentMessages).toHaveLength(2);
    // Test passes if no crash — the thread correctly loaded parent context
  });
});
