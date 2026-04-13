import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { isAgentBootstrapMode, isAdmin, addAdmin, claimBootstrapAdmin, createServer, type AxServer } from '../../src/host/server-local.js';
import { loadConfig } from '../../src/config.js';
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

// ── Unit tests for helpers ──

describe('isAgentBootstrapMode', () => {
  let axHome: string;
  let originalAxHome: string | undefined;
  let configDir: string;   // ~/.ax/agents/main/agent/
  let identityDir: string; // ~/.ax/agents/main/agent/identity/

  beforeEach(() => {
    originalAxHome = process.env.AX_HOME;
    axHome = mkdtempSync(join(tmpdir(), 'ax-admin-test-'));
    process.env.AX_HOME = axHome;
    configDir = join(axHome, 'agents', 'main', 'agent');
    identityDir = join(axHome, 'agents', 'main', 'agent', 'identity');
    mkdirSync(identityDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(axHome, { recursive: true, force: true });
    if (originalAxHome !== undefined) {
      process.env.AX_HOME = originalAxHome;
    } else {
      delete process.env.AX_HOME;
    }
  });

  test('returns true when BOOTSTRAP.md exists and SOUL.md does not', () => {
    writeFileSync(join(configDir, 'BOOTSTRAP.md'), '# Bootstrap');
    expect(isAgentBootstrapMode('main')).toBe(true);
  });

  test('returns true when only SOUL.md exists (still missing IDENTITY.md)', () => {
    writeFileSync(join(configDir, 'BOOTSTRAP.md'), '# Bootstrap');
    writeFileSync(join(identityDir, 'SOUL.md'), '# Soul');
    expect(isAgentBootstrapMode('main')).toBe(true);
  });

  test('returns true when only IDENTITY.md exists (still missing SOUL.md)', () => {
    writeFileSync(join(configDir, 'BOOTSTRAP.md'), '# Bootstrap');
    writeFileSync(join(identityDir, 'IDENTITY.md'), '# Identity');
    expect(isAgentBootstrapMode('main')).toBe(true);
  });

  test('returns false when both SOUL.md and IDENTITY.md exist (bootstrap complete)', () => {
    writeFileSync(join(configDir, 'BOOTSTRAP.md'), '# Bootstrap');
    writeFileSync(join(identityDir, 'SOUL.md'), '# Soul');
    writeFileSync(join(identityDir, 'IDENTITY.md'), '# Identity');
    expect(isAgentBootstrapMode('main')).toBe(false);
  });

  test('returns false when neither file exists', () => {
    expect(isAgentBootstrapMode('main')).toBe(false);
  });

  test('returns false when only SOUL.md exists (no BOOTSTRAP.md)', () => {
    writeFileSync(join(identityDir, 'SOUL.md'), '# Soul');
    expect(isAgentBootstrapMode('main')).toBe(false);
  });
});

describe('isAdmin', () => {
  let agentDir: string;

  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), 'ax-admin-test-'));
  });

  afterEach(() => {
    rmSync(agentDir, { recursive: true, force: true });
  });

  test('returns true when userId is in admins file', () => {
    writeFileSync(join(agentDir, 'admins'), 'alice\nbob\n');
    expect(isAdmin(agentDir, 'alice')).toBe(true);
    expect(isAdmin(agentDir, 'bob')).toBe(true);
  });

  test('returns false when userId is not in admins file', () => {
    writeFileSync(join(agentDir, 'admins'), 'alice\n');
    expect(isAdmin(agentDir, 'eve')).toBe(false);
  });

  test('returns false when admins file does not exist', () => {
    expect(isAdmin(agentDir, 'alice')).toBe(false);
  });

  test('handles blank lines and whitespace in admins file', () => {
    writeFileSync(join(agentDir, 'admins'), '  alice  \n\n  bob  \n\n');
    expect(isAdmin(agentDir, 'alice')).toBe(true);
    expect(isAdmin(agentDir, 'bob')).toBe(true);
  });
});

describe('addAdmin', () => {
  let agentDir: string;

  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), 'ax-admin-test-'));
  });

  afterEach(() => {
    rmSync(agentDir, { recursive: true, force: true });
  });

  test('appends userId to existing admins file', () => {
    writeFileSync(join(agentDir, 'admins'), 'alice\n');
    addAdmin(agentDir, 'bob');
    const content = readFileSync(join(agentDir, 'admins'), 'utf-8');
    expect(content).toBe('alice\nbob\n');
  });

  test('preserves existing entries', () => {
    writeFileSync(join(agentDir, 'admins'), 'alice\nbob\n');
    addAdmin(agentDir, 'charlie');
    expect(isAdmin(agentDir, 'alice')).toBe(true);
    expect(isAdmin(agentDir, 'bob')).toBe(true);
    expect(isAdmin(agentDir, 'charlie')).toBe(true);
  });
});

describe('claimBootstrapAdmin', () => {
  let agentDir: string;

  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), 'ax-admin-test-'));
    writeFileSync(join(agentDir, 'admins'), 'default\n');
  });

  afterEach(() => {
    rmSync(agentDir, { recursive: true, force: true });
  });

  test('first claim succeeds and adds user to admins', () => {
    expect(claimBootstrapAdmin(agentDir, 'U12345')).toBe(true);
    expect(isAdmin(agentDir, 'U12345')).toBe(true);
  });

  test('second claim fails (already claimed)', () => {
    expect(claimBootstrapAdmin(agentDir, 'U12345')).toBe(true);
    expect(claimBootstrapAdmin(agentDir, 'U67890')).toBe(false);
    expect(isAdmin(agentDir, 'U67890')).toBe(false);
  });

  test('claim file contains the userId of the claimer', () => {
    claimBootstrapAdmin(agentDir, 'U12345');
    const content = readFileSync(join(agentDir, '.bootstrap-admin-claimed'), 'utf-8');
    expect(content).toBe('U12345');
  });

  test('claim file prevents subsequent claims', () => {
    claimBootstrapAdmin(agentDir, 'U12345');
    expect(existsSync(join(agentDir, '.bootstrap-admin-claimed'))).toBe(true);
    expect(claimBootstrapAdmin(agentDir, 'U99999')).toBe(false);
  });

  test('re-claims when admins file is empty but claim file exists (stale claim)', () => {
    // Simulate stale state: previous claim succeeded, then admins was reset
    claimBootstrapAdmin(agentDir, 'U12345');
    expect(existsSync(join(agentDir, '.bootstrap-admin-claimed'))).toBe(true);

    // Reset admins file (user cleared it to re-bootstrap)
    writeFileSync(join(agentDir, 'admins'), '', 'utf-8');

    // New user should be able to claim since admins is empty
    expect(claimBootstrapAdmin(agentDir, 'U99999')).toBe(true);
    expect(isAdmin(agentDir, 'U99999')).toBe(true);
  });
});

// ── Integration test for channel bootstrap gate ──

describe('bootstrap gate (channel integration)', () => {
  let server: AxServer;
  let socketPath: string;
  let originalAxHome: string | undefined;
  let axHome: string;

  beforeEach(() => {
    socketPath = join(tmpdir(), `ax-gate-test-${randomUUID()}.sock`);
    originalAxHome = process.env.AX_HOME;
    axHome = mkdtempSync(join(tmpdir(), 'ax-gate-home-'));
    process.env.AX_HOME = axHome;
  });

  afterEach(async () => {
    if (server) await server.stop();
    try { unlinkSync(socketPath); } catch { /* ignore */ }
    rmSync(axHome, { recursive: true, force: true });
    if (originalAxHome !== undefined) {
      process.env.AX_HOME = originalAxHome;
    } else {
      delete process.env.AX_HOME;
    }
  });

  test('auto-promotes first channel user to admin during bootstrap', async () => {
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

    // First stranger during bootstrap gets auto-promoted to admin.
    const msg: InboundMessage = {
      id: 'gate-test-1',
      session: { provider: 'test', scope: 'channel', identifiers: { channel: 'C123', peer: 'first-user' } },
      sender: 'first-user',
      content: 'hello',
      attachments: [],
      timestamp: new Date(),
    };

    await messageHandler!(msg);

    // First user should get a real response, not the bootstrap gate message
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].content.content).not.toContain('still being set up');
  });

  test('blocks second non-admin during bootstrap after first claims admin', async () => {
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

    // First user claims admin
    const msg1: InboundMessage = {
      id: 'gate-test-1a',
      session: { provider: 'test', scope: 'channel', identifiers: { channel: 'C123', peer: 'first-user' } },
      sender: 'first-user',
      content: 'hello',
      attachments: [],
      timestamp: new Date(),
    };
    await messageHandler!(msg1);

    // Second user should be blocked
    const msg2: InboundMessage = {
      id: 'gate-test-1b',
      session: { provider: 'test', scope: 'channel', identifiers: { channel: 'C123', peer: 'stranger' } },
      sender: 'stranger',
      content: 'hello',
      attachments: [],
      timestamp: new Date(),
    };
    await messageHandler!(msg2);

    expect(sentMessages).toHaveLength(2);
    // First message: real response (auto-promoted)
    expect(sentMessages[0].content.content).not.toContain('still being set up');
    // Second message: blocked
    expect(sentMessages[1].content.content).toContain('still being set up');
  });

  test('allows admin during bootstrap mode', async () => {
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

    // First channel user is auto-promoted to admin via claimBootstrapAdmin
    const adminId = process.env.USER ?? 'default';
    const msg: InboundMessage = {
      id: 'gate-test-2',
      session: { provider: 'test', scope: 'channel', identifiers: { channel: 'C123', peer: adminId } },
      sender: adminId,
      content: 'hello',
      attachments: [],
      timestamp: new Date(),
    };

    await messageHandler!(msg);

    // Admin should get a real response, not the bootstrap gate message
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].content.content).not.toContain('still being set up');
  });

  test('bootstrap completion cleans up BOOTSTRAP.md and .bootstrap-admin-claimed', async () => {
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

    const agentTopDir = join(axHome, 'agents', 'test-agent');
    const agentConfigDir = join(axHome, 'agents', 'test-agent', 'agent');
    const identityFilesDir = join(axHome, 'agents', 'test-agent', 'agent', 'identity');

    // Verify bootstrap mode is active (BOOTSTRAP.md was copied from templates)
    expect(existsSync(join(agentConfigDir, 'BOOTSTRAP.md'))).toBe(true);
    expect(isAgentBootstrapMode('test-agent')).toBe(true);

    // First user claims admin
    const msg: InboundMessage = {
      id: 'lifecycle-1',
      session: { provider: 'test', scope: 'channel', identifiers: { channel: 'C123', peer: 'admin-user' } },
      sender: 'admin-user',
      content: 'hello',
      attachments: [],
      timestamp: new Date(),
    };
    await messageHandler!(msg);
    expect(existsSync(join(agentTopDir, '.bootstrap-admin-claimed'))).toBe(true);

    // Simulate bootstrap completion: write both SOUL.md and IDENTITY.md to identity dir
    writeFileSync(join(identityFilesDir, 'SOUL.md'), '# Soul\nI am helpful.');
    writeFileSync(join(identityFilesDir, 'IDENTITY.md'), '# Identity\nName: Test Agent');

    // Bootstrap mode is now complete
    expect(isAgentBootstrapMode('test-agent')).toBe(false);
  });

  test('server restart does not recreate BOOTSTRAP.md after bootstrap completes', async () => {
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

    // First server: start, complete bootstrap, stop
    server = await createServer(config, { socketPath, channels: [mockChannel] });
    await server.start();

    const agentConfigDir = join(axHome, 'agents', 'test-agent', 'agent');
    const identityFilesDir = join(axHome, 'agents', 'test-agent', 'agent', 'identity');

    // Complete bootstrap: write SOUL.md + IDENTITY.md, delete BOOTSTRAP.md from both locations
    writeFileSync(join(identityFilesDir, 'SOUL.md'), '# Soul\nI am helpful.');
    writeFileSync(join(identityFilesDir, 'IDENTITY.md'), '# Identity\nName: Test Agent');
    try { unlinkSync(join(agentConfigDir, 'BOOTSTRAP.md')); } catch { /* ignore */ }
    try { unlinkSync(join(identityFilesDir, 'BOOTSTRAP.md')); } catch { /* ignore */ }

    expect(existsSync(join(agentConfigDir, 'BOOTSTRAP.md'))).toBe(false);
    expect(isAgentBootstrapMode('test-agent')).toBe(false);

    await server.stop();

    // Second server: restart with same AX_HOME — BOOTSTRAP.md must NOT come back
    const socketPath2 = join(tmpdir(), `ax-gate-test-${randomUUID()}.sock`);
    server = await createServer(config, { socketPath: socketPath2, channels: [mockChannel] });
    await server.start();

    expect(existsSync(join(agentConfigDir, 'BOOTSTRAP.md'))).toBe(false);
    expect(isAgentBootstrapMode('test-agent')).toBe(false);

    // Clean up extra socket
    try { unlinkSync(socketPath2); } catch { /* ignore */ }
  });

  test('allows non-admin after bootstrap completes', async () => {
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

    // Simulate bootstrap completion: write SOUL.md and IDENTITY.md into identity files dir
    const identityFilesDir = join(axHome, 'agents', 'test-agent', 'agent', 'identity');
    writeFileSync(join(identityFilesDir, 'SOUL.md'), '# Soul\nI am helpful.');
    writeFileSync(join(identityFilesDir, 'IDENTITY.md'), '# Identity\nName: Test Agent');

    const msg: InboundMessage = {
      id: 'gate-test-3',
      session: { provider: 'test', scope: 'channel', identifiers: { channel: 'C123', peer: 'stranger' } },
      sender: 'stranger',
      content: 'hello',
      attachments: [],
      timestamp: new Date(),
    };

    await messageHandler!(msg);

    // Non-admin should get through after bootstrap
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].content.content).not.toContain('still being set up');
  });
});

// ── Integration test for HTTP bootstrap gate ──

describe('bootstrap gate (HTTP integration)', () => {
  let server: AxServer;
  let socketPath: string;
  let originalAxHome: string | undefined;
  let axHome: string;

  beforeEach(() => {
    socketPath = join(tmpdir(), `ax-gate-http-${randomUUID()}.sock`);
    originalAxHome = process.env.AX_HOME;
    axHome = mkdtempSync(join(tmpdir(), 'ax-gate-http-home-'));
    process.env.AX_HOME = axHome;
  });

  afterEach(async () => {
    if (server) await server.stop();
    try { unlinkSync(socketPath); } catch { /* ignore */ }
    rmSync(axHome, { recursive: true, force: true });
    if (originalAxHome !== undefined) {
      process.env.AX_HOME = originalAxHome;
    } else {
      delete process.env.AX_HOME;
    }
  });

  test('auto-promotes first HTTP user to admin during bootstrap', async () => {
    const config = loadConfig('tests/integration/ax-test.yaml');
    server = await createServer(config, { socketPath });
    await server.start();

    const agentTopDir = join(axHome, 'agents', 'test-agent');

    // Verify bootstrap mode is active
    expect(isAgentBootstrapMode('test-agent')).toBe(true);

    // First HTTP user should be auto-promoted to admin
    const res = await sendRequest(socketPath, '/v1/chat/completions', {
      body: {
        messages: [{ role: 'user', content: 'hello' }],
        user: 'vinay@canopyworks.com/conv-001',
      },
    });

    expect(res.status).toBe(200);
    expect(isAdmin(agentTopDir, 'vinay@canopyworks.com')).toBe(true);
    expect(existsSync(join(agentTopDir, '.bootstrap-admin-claimed'))).toBe(true);
  });

  test('blocks second HTTP user during bootstrap after first claims admin', async () => {
    const config = loadConfig('tests/integration/ax-test.yaml');
    server = await createServer(config, { socketPath });
    await server.start();

    // First HTTP user claims admin
    const res1 = await sendRequest(socketPath, '/v1/chat/completions', {
      body: {
        messages: [{ role: 'user', content: 'hello' }],
        user: 'first-user/conv-001',
      },
    });
    expect(res1.status).toBe(200);

    // Second HTTP user should be blocked
    const res2 = await sendRequest(socketPath, '/v1/chat/completions', {
      body: {
        messages: [{ role: 'user', content: 'hello' }],
        user: 'stranger/conv-002',
      },
    });
    expect(res2.status).toBe(403);
    const data = JSON.parse(res2.body);
    expect(data.error?.message).toContain('still being set up');
  });

  test('allows HTTP requests without user field during bootstrap (no gate)', async () => {
    const config = loadConfig('tests/integration/ax-test.yaml');
    server = await createServer(config, { socketPath });
    await server.start();

    // Request with no user field should not be gated
    const res = await sendRequest(socketPath, '/v1/chat/completions', {
      body: {
        messages: [{ role: 'user', content: 'hello' }],
      },
    });

    // Should succeed (no userId → bootstrap gate is skipped)
    expect(res.status).toBe(200);
  });
});
