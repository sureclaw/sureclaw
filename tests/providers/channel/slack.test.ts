import { describe, test, expect, vi, beforeEach } from 'vitest';
import type { InboundMessage, SessionAddress } from '../../../src/providers/channel/types.js';
import type { Config } from '../../../src/types.js';

// Minimal config for testing
function testConfig(channelConfig?: Record<string, unknown>): Config {
  return {
    profile: 'default' as any,
    providers: {
      llm: 'mock', memory: 'file', scanner: 'basic', channels: ['slack'],
      web: 'none', browser: 'none', credentials: 'env', skills: 'readonly',
      audit: 'file', sandbox: 'subprocess', scheduler: 'none',
    },
    channel_config: channelConfig as any,
    sandbox: { timeout_sec: 30, memory_mb: 512 },
    scheduler: {
      active_hours: { start: '09:00', end: '17:00', timezone: 'UTC' },
      max_token_budget: 1000, heartbeat_interval_min: 60,
    },
  } as Config;
}

// Mock Slack Bolt App
const mockPostMessage = vi.fn().mockResolvedValue({ ok: true });
const mockFilesUploadV2 = vi.fn().mockResolvedValue({ ok: true });
const mockAuthTest = vi.fn().mockResolvedValue({ user_id: 'UBOT', team_id: 'T01' });
const mockStart = vi.fn().mockResolvedValue(undefined);
const mockStop = vi.fn().mockResolvedValue(undefined);
const eventHandlers = new Map<string, Function>();

vi.mock('@slack/bolt', () => ({
  App: class MockApp {
    constructor() {}
    message(handler: Function) { eventHandlers.set('message', handler); }
    event(name: string, handler: Function) { eventHandlers.set(name, handler); }
    start = mockStart;
    stop = mockStop;
    client = {
      auth: { test: mockAuthTest },
      chat: { postMessage: mockPostMessage },
      files: { uploadV2: mockFilesUploadV2 },
    };
  },
}));

describe('Slack channel provider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    eventHandlers.clear();
    delete process.env.SLACK_BOT_TOKEN;
    delete process.env.SLACK_APP_TOKEN;
  });

  test('throws without credentials', async () => {
    const { create } = await import('../../../src/providers/channel/slack.js');
    await expect(create(testConfig())).rejects.toThrow('SLACK_BOT_TOKEN');
  });

  test('throws without SLACK_APP_TOKEN', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test';
    const { create } = await import('../../../src/providers/channel/slack.js');
    await expect(create(testConfig())).rejects.toThrow('SLACK_APP_TOKEN');
  });

  test('connects and resolves bot user id', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test';
    process.env.SLACK_APP_TOKEN = 'xapp-test';
    const { create } = await import('../../../src/providers/channel/slack.js');
    const provider = await create(testConfig());
    await provider.connect();
    expect(mockStart).toHaveBeenCalled();
    expect(mockAuthTest).toHaveBeenCalled();
    await provider.disconnect();
  });

  describe('shouldRespond', () => {
    test('allows DMs when policy is open (default)', async () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test';
      process.env.SLACK_APP_TOKEN = 'xapp-test';
      const { create } = await import('../../../src/providers/channel/slack.js');
      const provider = await create(testConfig());

      const msg: InboundMessage = {
        id: '1234.5678',
        session: { provider: 'slack', scope: 'dm', identifiers: { peer: 'U123' } },
        sender: 'U123',
        content: 'hello',
        attachments: [],
        timestamp: new Date(),
      };
      expect(provider.shouldRespond(msg)).toBe(true);
    });

    test('blocks DMs when policy is disabled', async () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test';
      process.env.SLACK_APP_TOKEN = 'xapp-test';
      const { create } = await import('../../../src/providers/channel/slack.js');
      const provider = await create(testConfig({ slack: { dm_policy: 'disabled' } }));

      const msg: InboundMessage = {
        id: '1234.5678',
        session: { provider: 'slack', scope: 'dm', identifiers: { peer: 'U123' } },
        sender: 'U123',
        content: 'hello',
        attachments: [],
        timestamp: new Date(),
      };
      expect(provider.shouldRespond(msg)).toBe(false);
    });

    test('allowlist blocks unlisted users', async () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test';
      process.env.SLACK_APP_TOKEN = 'xapp-test';
      const { create } = await import('../../../src/providers/channel/slack.js');
      const provider = await create(testConfig({
        slack: { dm_policy: 'allowlist', allowed_users: ['U999'] },
      }));

      const msg: InboundMessage = {
        id: '1234.5678',
        session: { provider: 'slack', scope: 'dm', identifiers: { peer: 'U123' } },
        sender: 'U123',
        content: 'hello',
        attachments: [],
        timestamp: new Date(),
      };
      expect(provider.shouldRespond(msg)).toBe(false);
    });

    test('allowlist permits listed users', async () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test';
      process.env.SLACK_APP_TOKEN = 'xapp-test';
      const { create } = await import('../../../src/providers/channel/slack.js');
      const provider = await create(testConfig({
        slack: { dm_policy: 'allowlist', allowed_users: ['U123'] },
      }));

      const msg: InboundMessage = {
        id: '1234.5678',
        session: { provider: 'slack', scope: 'dm', identifiers: { peer: 'U123' } },
        sender: 'U123',
        content: 'hello',
        attachments: [],
        timestamp: new Date(),
      };
      expect(provider.shouldRespond(msg)).toBe(true);
    });

    test('channel messages are always allowed', async () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test';
      process.env.SLACK_APP_TOKEN = 'xapp-test';
      const { create } = await import('../../../src/providers/channel/slack.js');
      const provider = await create(testConfig());

      const msg: InboundMessage = {
        id: '1234.5678',
        session: { provider: 'slack', scope: 'channel', identifiers: { channel: 'C01', peer: 'U123' } },
        sender: 'U123',
        content: 'hello',
        attachments: [],
        timestamp: new Date(),
      };
      expect(provider.shouldRespond(msg)).toBe(true);
    });
  });

  describe('send', () => {
    test('posts message to channel', async () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test';
      process.env.SLACK_APP_TOKEN = 'xapp-test';
      const { create } = await import('../../../src/providers/channel/slack.js');
      const provider = await create(testConfig());

      const session: SessionAddress = {
        provider: 'slack',
        scope: 'channel',
        identifiers: { channel: 'C01', peer: 'U123' },
      };
      await provider.send(session, { content: 'Hello!' });

      expect(mockPostMessage).toHaveBeenCalledWith(
        expect.objectContaining({ channel: 'C01', text: 'Hello!' }),
      );
    });

    test('posts threaded reply when thread identifier present', async () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test';
      process.env.SLACK_APP_TOKEN = 'xapp-test';
      const { create } = await import('../../../src/providers/channel/slack.js');
      const provider = await create(testConfig());

      const session: SessionAddress = {
        provider: 'slack',
        scope: 'thread',
        identifiers: { channel: 'C01', thread: '1234.5678', peer: 'U123' },
      };
      await provider.send(session, { content: 'Thread reply' });

      expect(mockPostMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'C01',
          text: 'Thread reply',
          thread_ts: '1234.5678',
        }),
      );
    });

    test('sends to peer for DM sessions', async () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test';
      process.env.SLACK_APP_TOKEN = 'xapp-test';
      const { create } = await import('../../../src/providers/channel/slack.js');
      const provider = await create(testConfig());

      const session: SessionAddress = {
        provider: 'slack',
        scope: 'dm',
        identifiers: { peer: 'U123' },
      };
      await provider.send(session, { content: 'DM reply' });

      expect(mockPostMessage).toHaveBeenCalledWith(
        expect.objectContaining({ channel: 'U123', text: 'DM reply' }),
      );
    });

    test('chunks long messages at newline boundaries', async () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test';
      process.env.SLACK_APP_TOKEN = 'xapp-test';
      const { create } = await import('../../../src/providers/channel/slack.js');
      const provider = await create(testConfig());

      const session: SessionAddress = {
        provider: 'slack',
        scope: 'channel',
        identifiers: { channel: 'C01' },
      };
      // Create a message that exceeds 4000 chars
      const longLine = 'A'.repeat(3000);
      const content = `${longLine}\n${'B'.repeat(3000)}`;
      await provider.send(session, { content });

      expect(mockPostMessage).toHaveBeenCalledTimes(2);
    });

    test('throws when session has no channel or peer', async () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test';
      process.env.SLACK_APP_TOKEN = 'xapp-test';
      const { create } = await import('../../../src/providers/channel/slack.js');
      const provider = await create(testConfig());

      const session: SessionAddress = {
        provider: 'slack',
        scope: 'channel',
        identifiers: {},
      };
      await expect(provider.send(session, { content: 'test' }))
        .rejects.toThrow('no channel or peer');
    });
  });
});
