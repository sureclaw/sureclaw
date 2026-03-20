import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { createServer, type AxServer } from '../../src/host/server-local.js';
import { loadConfig } from '../../src/config.js';
import { workspaceDir, agentSkillsDir } from '../../src/paths.js';
import type { ChannelProvider, InboundMessage, OutboundMessage, SessionAddress } from '../../src/providers/channel/types.js';

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

/** Send an HTTP request over TCP to the server's TCP port */
function sendTcpRequest(
  server: AxServer,
  path: string,
  opts: { method?: string; body?: unknown } = {},
): Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }> {
  const addr = server.tcpAddress;
  if (!addr) throw new Error('Server has no TCP address');
  return new Promise((resolve, reject) => {
    const bodyStr = opts.body ? JSON.stringify(opts.body) : undefined;
    const req = httpRequest(
      {
        hostname: addr.host,
        port: addr.port,
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
  let testAxHome: string;
  let originalAxHome: string | undefined;

  beforeEach(() => {
    socketPath = join(tmpdir(), `ax-test-${randomUUID()}.sock`);
    // Isolate AX_HOME so persistent workspaces don't leak into the real ~/.ax/data/workspaces/
    testAxHome = join(tmpdir(), `ax-test-home-${randomUUID()}`);
    mkdirSync(testAxHome, { recursive: true });
    originalAxHome = process.env.AX_HOME;
    process.env.AX_HOME = testAxHome;
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
    // Restore AX_HOME
    if (originalAxHome !== undefined) {
      process.env.AX_HOME = originalAxHome;
    } else {
      delete process.env.AX_HOME;
    }
    // Clean up temp dir
    rmSync(testAxHome, { recursive: true, force: true });
  });

  // --- Lifecycle ---

  it('should start server on Unix socket', async () => {
    const config = loadConfig('tests/integration/ax-test.yaml');
    server = await createServer(config, { socketPath });
    await server.start();
    expect(server.listening).toBe(true);
  });

  it('should listen on TCP port when --port is specified', async () => {
    const config = loadConfig('tests/integration/ax-test.yaml');
    // Use port 0 to let the OS pick a free port
    server = await createServer(config, { socketPath, port: 0 });
    await server.start();
    expect(server.listening).toBe(true);

    // Also verify the Unix socket works
    const socketRes = await sendRequest(socketPath, '/v1/models', { method: 'GET' });
    expect(socketRes.status).toBe(200);

    // Verify TCP endpoint works via the address on the server
    const tcpRes = await sendTcpRequest(server, '/v1/models', { method: 'GET' });
    expect(tcpRes.status).toBe(200);
    const data = JSON.parse(tcpRes.body);
    expect(data.object).toBe('list');
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

  // --- Persistent Workspaces ---

  it('should return 400 for invalid session_id', async () => {
    const config = loadConfig('tests/integration/ax-test.yaml');
    server = await createServer(config, { socketPath });
    await server.start();

    const res = await sendRequest(socketPath, '/v1/chat/completions', {
      body: {
        messages: [{ role: 'user', content: 'hello' }],
        session_id: '../../../etc/passwd',
      },
    });

    expect(res.status).toBe(400);
    const data = JSON.parse(res.body);
    expect(data.error.message).toContain('session_id');
  });

  it('should derive persistent workspace from user field', async () => {
    const config = loadConfig('tests/integration/ax-test.yaml');
    server = await createServer(config, { socketPath });
    await server.start();

    const res = await sendRequest(socketPath, '/v1/chat/completions', {
      body: {
        messages: [{ role: 'user', content: 'hello' }],
        model: 'agent:main',
        user: 'alice/conv-001',
      },
    });

    expect(res.status).toBe(200);

    // Workspace should be created under the derived session ID: main:http:alice:conv-001
    const wsDir = workspaceDir('main:http:alice:conv-001');
    expect(existsSync(wsDir)).toBe(true);
  });

  it('should create persistent workspace when session_id is provided', async () => {
    const config = loadConfig('tests/integration/ax-test.yaml');
    server = await createServer(config, { socketPath });
    await server.start();

    const sessionId = randomUUID();

    const res = await sendRequest(socketPath, '/v1/chat/completions', {
      body: {
        messages: [{ role: 'user', content: 'hello' }],
        session_id: sessionId,
      },
    });

    expect(res.status).toBe(200);

    // Workspace directory should persist after request
    const wsDir = workspaceDir(sessionId);
    expect(existsSync(wsDir)).toBe(true);
  });

  it('should use persistent skills dir (peer of workspace), not copy into workspace', async () => {
    // Create a skill file in the persistent skills directory (~/.ax/agents/main/agent/skills/)
    const persistentSkillsDir = agentSkillsDir('main');
    mkdirSync(persistentSkillsDir, { recursive: true });
    const testSkillPath = join(persistentSkillsDir, '_test-skill.md');
    writeFileSync(testSkillPath, '# Test Skill\nThis is a test skill.');

    try {
      const config = loadConfig('tests/integration/ax-test.yaml');
      server = await createServer(config, { socketPath });
      await server.start();

      const sessionId = randomUUID();
      const res = await sendRequest(socketPath, '/v1/chat/completions', {
        body: {
          messages: [{ role: 'user', content: 'hello' }],
          session_id: sessionId,
        },
      });

      expect(res.status).toBe(200);

      // Skills should exist at the persistent location (peer of workspace)
      expect(existsSync(persistentSkillsDir)).toBe(true);
      const skills = readdirSync(persistentSkillsDir);
      expect(skills).toContain('_test-skill.md');

      // Skills should NOT be copied into the session workspace
      const wsDir = workspaceDir(sessionId);
      const wsSkillsDir = join(wsDir, 'skills');
      expect(existsSync(wsSkillsDir)).toBe(false);
    } finally {
      // Cleanup handled by afterEach (testAxHome removal)
    }
  });

  // --- Channel Deduplication ---

  it('should deduplicate channel messages with the same ID', async () => {
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
      id: 'test-msg-1',
      session: { provider: 'test', scope: 'channel', identifiers: { channel: 'C123', peer: 'U123' } },
      sender: 'U123',
      content: 'hello',
      attachments: [],
      timestamp: new Date(),
    };

    // Simulate Slack delivering the same event multiple times
    // (e.g., due to socket reconnection or missed ack)
    await Promise.all([
      messageHandler!(msg),
      messageHandler!(msg),
      messageHandler!(msg),
    ]);

    // Should receive exactly ONE response despite 3 deliveries
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].content.content.length).toBeGreaterThan(0);
  });

  it('should block sequential retries within the dedup window', async () => {
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
    // Use a generous dedup window — the first messageHandler! call runs the full
    // LLM pipeline and can take 5-10s under CI load, so 5s was too short.
    server = await createServer(config, { socketPath, channels: [mockChannel], dedupeWindowMs: 30_000 });
    await server.start();

    const msg: InboundMessage = {
      id: 'test-msg-seq',
      session: { provider: 'test', scope: 'channel', identifiers: { channel: 'C123', peer: 'U123' } },
      sender: 'U123',
      content: 'hello',
      attachments: [],
      timestamp: new Date(),
    };

    // First delivery — processed
    await messageHandler!(msg);
    expect(sentMessages).toHaveLength(1);

    // Sequential retry right after completion — should be blocked (within window)
    await messageHandler!(msg);
    expect(sentMessages).toHaveLength(1);
  });

  it('should process channel message again after dedup window expires', async () => {
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
    server = await createServer(config, { socketPath, channels: [mockChannel], dedupeWindowMs: 50 });
    await server.start();

    const msg: InboundMessage = {
      id: 'test-msg-ttl',
      session: { provider: 'test', scope: 'channel', identifiers: { channel: 'C123', peer: 'U123' } },
      sender: 'U123',
      content: 'hello',
      attachments: [],
      timestamp: new Date(),
    };

    // First delivery — should be processed
    await messageHandler!(msg);
    expect(sentMessages).toHaveLength(1);

    // Wait for dedup window to expire
    await new Promise(r => setTimeout(r, 80));

    // Second delivery after window — should be processed again
    await messageHandler!(msg);
    expect(sentMessages).toHaveLength(2);
  });

  it('should accept request without session_id (ephemeral workspace)', async () => {
    const config = loadConfig('tests/integration/ax-test.yaml');
    server = await createServer(config, { socketPath });
    await server.start();

    const res = await sendRequest(socketPath, '/v1/chat/completions', {
      body: {
        messages: [{ role: 'user', content: 'hello' }],
      },
    });

    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.choices[0].message.content.length).toBeGreaterThan(0);
  });

  // --- Eyes Emoji & Thread Gating ---
  // The admins file starts empty on first run. The first channel user to send
  // a message is auto-promoted via claimBootstrapAdmin. Use a consistent user
  // for tests that need to pass the bootstrap gate.
  const adminUser = process.env.USER ?? 'default';

  it('should add and remove eyes emoji around channel message processing', async () => {
    const sentMessages: { session: SessionAddress; content: OutboundMessage }[] = [];
    const reactions: { action: string; emoji: string; messageId: string }[] = [];
    let messageHandler: ((msg: InboundMessage) => Promise<void>) | null = null;

    const mockChannel: ChannelProvider = {
      name: 'test-emoji',
      async connect() {},
      onMessage(handler) { messageHandler = handler; },
      shouldRespond() { return true; },
      async send(session, content) { sentMessages.push({ session, content }); },
      async disconnect() {},
      async addReaction(_session, messageId, emoji) { reactions.push({ action: 'add', emoji, messageId }); },
      async removeReaction(_session, messageId, emoji) { reactions.push({ action: 'remove', emoji, messageId }); },
    };

    const config = loadConfig('tests/integration/ax-test.yaml');
    server = await createServer(config, { socketPath, channels: [mockChannel] });
    await server.start();

    const msg: InboundMessage = {
      id: 'emoji-test-1',
      session: { provider: 'test', scope: 'dm', identifiers: { peer: adminUser } },
      sender: adminUser,
      content: 'hello',
      attachments: [],
      timestamp: new Date(),
      isMention: true,
    };

    await messageHandler!(msg);

    // Eyes emoji should have been added then removed
    expect(reactions).toEqual([
      { action: 'add', emoji: 'eyes', messageId: 'emoji-test-1' },
      { action: 'remove', emoji: 'eyes', messageId: 'emoji-test-1' },
    ]);
    // Response should have been sent
    expect(sentMessages).toHaveLength(1);
  });

  it('should gate thread messages when bot has not participated', async () => {
    const sentMessages: { session: SessionAddress; content: OutboundMessage }[] = [];
    let messageHandler: ((msg: InboundMessage) => Promise<void>) | null = null;

    const mockChannel: ChannelProvider = {
      name: 'test-gate',
      async connect() {},
      onMessage(handler) { messageHandler = handler; },
      shouldRespond() { return true; },
      async send(session, content) { sentMessages.push({ session, content }); },
      async disconnect() {},
    };

    const config = loadConfig('tests/integration/ax-test.yaml');
    server = await createServer(config, { socketPath, channels: [mockChannel] });
    await server.start();

    // Thread reply with isMention=false and no prior conversation — should be gated
    const msg: InboundMessage = {
      id: 'gate-test-1',
      session: { provider: 'test', scope: 'thread', identifiers: { channel: 'C01', thread: '1000.0001' } },
      sender: 'U123',
      content: 'a reply',
      attachments: [],
      timestamp: new Date(),
      isMention: false,
    };

    await messageHandler!(msg);

    // Message should have been dropped — no response sent
    expect(sentMessages).toHaveLength(0);
  });

  it('should process thread messages when bot has participated (via prior mention)', async () => {
    const sentMessages: { session: SessionAddress; content: OutboundMessage }[] = [];
    let messageHandler: ((msg: InboundMessage) => Promise<void>) | null = null;

    const mockChannel: ChannelProvider = {
      name: 'test-thread',
      async connect() {},
      onMessage(handler) { messageHandler = handler; },
      shouldRespond() { return true; },
      async send(session, content) { sentMessages.push({ session, content }); },
      async disconnect() {},
    };

    const config = loadConfig('tests/integration/ax-test.yaml');
    server = await createServer(config, { socketPath, channels: [mockChannel] });
    await server.start();

    const threadSession: SessionAddress = {
      provider: 'test', scope: 'thread',
      identifiers: { channel: 'C02', thread: '2000.0001' },
    };

    // First: mention in thread (creates conversation store entry)
    const mention: InboundMessage = {
      id: 'thread-mention-1',
      session: threadSession,
      sender: adminUser,
      content: 'hey bot help me',
      attachments: [],
      timestamp: new Date(),
      isMention: true,
    };
    await messageHandler!(mention);
    expect(sentMessages).toHaveLength(1);

    // Second: non-mention reply in same thread — should now be processed
    const reply: InboundMessage = {
      id: 'thread-reply-1',
      session: threadSession,
      sender: adminUser,
      content: 'thanks for that',
      attachments: [],
      timestamp: new Date(),
      isMention: false,
    };
    await messageHandler!(reply);
    expect(sentMessages).toHaveLength(2);
  });

  it('should call fetchThreadHistory on first mention in a thread', async () => {
    const sentMessages: { session: SessionAddress; content: OutboundMessage }[] = [];
    const fetchedThreads: { channel: string; threadTs: string }[] = [];
    let messageHandler: ((msg: InboundMessage) => Promise<void>) | null = null;

    const mockChannel: ChannelProvider = {
      name: 'test-backfill',
      async connect() {},
      onMessage(handler) { messageHandler = handler; },
      shouldRespond() { return true; },
      async send(session, content) { sentMessages.push({ session, content }); },
      async disconnect() {},
      async fetchThreadHistory(channel, threadTs, _limit) {
        fetchedThreads.push({ channel, threadTs });
        return [
          { sender: 'U999', content: 'earlier message', ts: '3000.0001' },
        ];
      },
    };

    const config = loadConfig('tests/integration/ax-test.yaml');
    server = await createServer(config, { socketPath, channels: [mockChannel] });
    await server.start();

    const msg: InboundMessage = {
      id: 'backfill-test-1',
      session: { provider: 'test', scope: 'thread', identifiers: { channel: 'C03', thread: '3000.0001' } },
      sender: adminUser,
      content: 'hey bot',
      attachments: [],
      timestamp: new Date(),
      isMention: true,
    };

    await messageHandler!(msg);

    // fetchThreadHistory should have been called
    expect(fetchedThreads).toEqual([{ channel: 'C03', threadTs: '3000.0001' }]);
    // Response should still be sent
    expect(sentMessages).toHaveLength(1);
  });
});
