import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { isAgentBootstrapMode, isAdmin, addAdmin, claimBootstrapAdmin, createServer, type AxServer } from '../../src/host/server.js';
import { loadConfig } from '../../src/config.js';
import type { ChannelProvider, InboundMessage, OutboundMessage, SessionAddress } from '../../src/providers/channel/types.js';

// ── Unit tests for helpers ──

describe('isAgentBootstrapMode', () => {
  let agentDir: string;

  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), 'ax-admin-test-'));
  });

  afterEach(() => {
    rmSync(agentDir, { recursive: true, force: true });
  });

  test('returns true when BOOTSTRAP.md exists and SOUL.md does not', () => {
    writeFileSync(join(agentDir, 'BOOTSTRAP.md'), '# Bootstrap');
    expect(isAgentBootstrapMode(agentDir)).toBe(true);
  });

  test('returns false when SOUL.md exists (bootstrap complete)', () => {
    writeFileSync(join(agentDir, 'BOOTSTRAP.md'), '# Bootstrap');
    writeFileSync(join(agentDir, 'SOUL.md'), '# Soul');
    expect(isAgentBootstrapMode(agentDir)).toBe(false);
  });

  test('returns false when neither file exists', () => {
    expect(isAgentBootstrapMode(agentDir)).toBe(false);
  });

  test('returns false when only SOUL.md exists', () => {
    writeFileSync(join(agentDir, 'SOUL.md'), '# Soul');
    expect(isAgentBootstrapMode(agentDir)).toBe(false);
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

    // The admin is process.env.USER (or 'default')
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

    // Simulate bootstrap completion: write SOUL.md into agent dir
    const agentDirPath = join(axHome, 'agents', 'main');
    writeFileSync(join(agentDirPath, 'SOUL.md'), '# Soul\nI am helpful.');

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
