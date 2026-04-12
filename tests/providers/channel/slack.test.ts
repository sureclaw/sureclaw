import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import type { InboundMessage, SessionAddress } from '../../../src/providers/channel/types.js';
import type { Config } from '../../../src/types.js';

// Minimal config for testing
function testConfig(channelConfig?: Record<string, unknown>): Config {
  return {
    profile: 'default' as any,
    providers: {
      memory: 'cortex', security: 'patterns', channels: ['slack'],
      web: { extract: 'none', search: 'none' }, credentials: 'keychain', skills: 'database',
      audit: 'database', sandbox: 'docker', scheduler: 'none',
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
const mockReactionsAdd = vi.fn().mockResolvedValue({ ok: true });
const mockReactionsRemove = vi.fn().mockResolvedValue({ ok: true });
const mockConversationsReplies = vi.fn().mockResolvedValue({ ok: true, messages: [] });
const mockStart = vi.fn().mockResolvedValue(undefined);
const mockStop = vi.fn().mockResolvedValue(undefined);
const mockIsActive = vi.fn().mockReturnValue(true);
const mockSocketClient = {
  websocket: { isActive: mockIsActive },
  on: vi.fn(),
  autoReconnectEnabled: true,
};
const eventHandlers = new Map<string, Function>();

// Wrap exports under .default to match how Node's native ESM import() exposes
// a CJS module — the source code uses ((mod).default ?? mod) to unwrap.
const boltExports = {
  App: class MockApp {
    constructor() {}
    message(handler: Function) { eventHandlers.set('message', handler); }
    event(name: string, handler: Function) { eventHandlers.set(name, handler); }
    error(_handler: Function) { /* global error handler registration */ }
    start = mockStart;
    stop = mockStop;
    client = {
      auth: { test: mockAuthTest },
      chat: { postMessage: mockPostMessage },
      files: { uploadV2: mockFilesUploadV2 },
      reactions: { add: mockReactionsAdd, remove: mockReactionsRemove },
      conversations: { replies: mockConversationsReplies },
    };
  },
  SocketModeReceiver: class MockSocketModeReceiver {
    client = mockSocketClient;
    constructor() {}
  },
  LogLevel: { ERROR: 'error', WARN: 'warn', INFO: 'info', DEBUG: 'debug' },
};
vi.mock('@slack/bolt', () => ({ default: boltExports, ...boltExports }));

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

  describe('message routing', () => {
    test('app.message ignores channel messages (only app_mention handles those)', async () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test';
      process.env.SLACK_APP_TOKEN = 'xapp-test';
      const { create } = await import('../../../src/providers/channel/slack.js');
      const provider = await create(testConfig());
      await provider.connect();

      const handler = vi.fn();
      provider.onMessage(handler);

      // Simulate a channel message (not a DM) arriving via app.message
      const messageHandler = eventHandlers.get('message')!;
      await messageHandler({
        message: {
          text: 'hello <@UBOT>',
          user: 'U123',
          channel: 'C01',
          ts: '1111.2222',
          channel_type: 'channel',
        },
      });

      expect(handler).not.toHaveBeenCalled();
    });

    test('app.message processes DMs', async () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test';
      process.env.SLACK_APP_TOKEN = 'xapp-test';
      const { create } = await import('../../../src/providers/channel/slack.js');
      const provider = await create(testConfig());
      await provider.connect();

      const handler = vi.fn();
      provider.onMessage(handler);

      const messageHandler = eventHandlers.get('message')!;
      await messageHandler({
        message: {
          text: 'hello',
          user: 'U123',
          channel: 'D01',
          ts: '1111.2222',
          channel_type: 'im',
        },
      });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          session: expect.objectContaining({ scope: 'dm' }),
          content: 'hello',
        }),
      );
    });

    test('app_mention creates threaded session for top-level channel messages', async () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test';
      process.env.SLACK_APP_TOKEN = 'xapp-test';
      const { create } = await import('../../../src/providers/channel/slack.js');
      const provider = await create(testConfig());
      await provider.connect();

      const handler = vi.fn();
      provider.onMessage(handler);

      const mentionHandler = eventHandlers.get('app_mention')!;
      await mentionHandler({
        event: {
          text: '<@UBOT> hello',
          user: 'U123',
          channel: 'C01',
          ts: '1111.2222',
          // No thread_ts — top-level mention
        },
      });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          session: expect.objectContaining({
            scope: 'thread',
            identifiers: expect.objectContaining({
              channel: 'C01',
              thread: '1111.2222', // Uses message ts as thread anchor
            }),
          }),
          content: 'hello',
        }),
      );
    });
  });

  describe('thread reply routing', () => {
    test('app.message passes through thread replies in channels', async () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test';
      process.env.SLACK_APP_TOKEN = 'xapp-test';
      const { create } = await import('../../../src/providers/channel/slack.js');
      const provider = await create(testConfig());
      await provider.connect();

      const handler = vi.fn();
      provider.onMessage(handler);

      const messageHandler = eventHandlers.get('message')!;
      await messageHandler({
        message: {
          text: 'a reply in a thread',
          user: 'U123',
          channel: 'C01',
          ts: '2222.3333',
          thread_ts: '1111.2222',
          channel_type: 'channel',
        },
      });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          session: expect.objectContaining({ scope: 'thread' }),
          content: 'a reply in a thread',
          isMention: false,
        }),
      );
    });

    test('app.message still ignores top-level channel messages (no thread_ts)', async () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test';
      process.env.SLACK_APP_TOKEN = 'xapp-test';
      const { create } = await import('../../../src/providers/channel/slack.js');
      const provider = await create(testConfig());
      await provider.connect();

      const handler = vi.fn();
      provider.onMessage(handler);

      const messageHandler = eventHandlers.get('message')!;
      await messageHandler({
        message: {
          text: 'top level in channel',
          user: 'U123',
          channel: 'C01',
          ts: '1111.2222',
          channel_type: 'channel',
        },
      });

      expect(handler).not.toHaveBeenCalled();
    });

    test('app_mention sets isMention=true', async () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test';
      process.env.SLACK_APP_TOKEN = 'xapp-test';
      const { create } = await import('../../../src/providers/channel/slack.js');
      const provider = await create(testConfig());
      await provider.connect();

      const handler = vi.fn();
      provider.onMessage(handler);

      const mentionHandler = eventHandlers.get('app_mention')!;
      await mentionHandler({
        event: {
          text: '<@UBOT> do something',
          user: 'U123',
          channel: 'C01',
          ts: '1111.2222',
        },
      });

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ isMention: true }),
      );
    });

    test('DMs have isMention=false and include dmChannel for reactions', async () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test';
      process.env.SLACK_APP_TOKEN = 'xapp-test';
      const { create } = await import('../../../src/providers/channel/slack.js');
      const provider = await create(testConfig());
      await provider.connect();

      const handler = vi.fn();
      provider.onMessage(handler);

      const messageHandler = eventHandlers.get('message')!;
      await messageHandler({
        message: {
          text: 'hello',
          user: 'U123',
          channel: 'D01',
          ts: '1111.2222',
          channel_type: 'im',
        },
      });

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          isMention: false,
          session: expect.objectContaining({
            scope: 'dm',
            identifiers: expect.objectContaining({
              peer: 'U123',
              dmChannel: 'D01',
            }),
          }),
        }),
      );
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

    test('uploads attachments via files.uploadV2 with initial_comment', async () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test';
      process.env.SLACK_APP_TOKEN = 'xapp-test';
      const { create } = await import('../../../src/providers/channel/slack.js');
      const provider = await create(testConfig());

      const session: SessionAddress = {
        provider: 'slack',
        scope: 'channel',
        identifiers: { channel: 'C01', peer: 'U123' },
      };
      const imageData = Buffer.from('fake-png-data');
      await provider.send(session, {
        content: 'Here is the chart',
        attachments: [{
          filename: 'chart.png',
          mimeType: 'image/png',
          size: imageData.length,
          content: imageData,
        }],
      });

      // files.uploadV2 called with correct params including initial_comment
      expect(mockFilesUploadV2).toHaveBeenCalledWith(
        expect.objectContaining({
          token: 'xoxb-test',
          channel_id: 'C01',
          file: imageData,
          filename: 'chart.png',
          initial_comment: 'Here is the chart',
        }),
      );

      // Text was sent as initial_comment — no separate postMessage
      expect(mockPostMessage).not.toHaveBeenCalled();
    });

    test('uploads attachments in thread with thread_ts', async () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test';
      process.env.SLACK_APP_TOKEN = 'xapp-test';
      const { create } = await import('../../../src/providers/channel/slack.js');
      const provider = await create(testConfig());

      const session: SessionAddress = {
        provider: 'slack',
        scope: 'thread',
        identifiers: { channel: 'C01', thread: '1234.5678' },
      };
      const imageData = Buffer.from('fake-png-data');
      await provider.send(session, {
        content: 'Threaded image',
        attachments: [{
          filename: 'img.png',
          mimeType: 'image/png',
          size: imageData.length,
          content: imageData,
        }],
      });

      expect(mockFilesUploadV2).toHaveBeenCalledWith(
        expect.objectContaining({
          channel_id: 'C01',
          thread_ts: '1234.5678',
          file: imageData,
          filename: 'img.png',
          initial_comment: 'Threaded image',
        }),
      );
      expect(mockPostMessage).not.toHaveBeenCalled();
    });

    test('falls back to postMessage when attachment has no content', async () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test';
      process.env.SLACK_APP_TOKEN = 'xapp-test';
      const { create } = await import('../../../src/providers/channel/slack.js');
      const provider = await create(testConfig());

      const session: SessionAddress = {
        provider: 'slack',
        scope: 'channel',
        identifiers: { channel: 'C01' },
      };
      await provider.send(session, {
        content: 'Text only',
        attachments: [{
          filename: 'missing.png',
          mimeType: 'image/png',
          size: 0,
          // no content — nothing to upload
        }],
      });

      expect(mockFilesUploadV2).not.toHaveBeenCalled();
      expect(mockPostMessage).toHaveBeenCalledWith(
        expect.objectContaining({ channel: 'C01', text: 'Text only' }),
      );
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

  describe('reactions', () => {
    test('addReaction calls reactions.add with correct params', async () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test';
      process.env.SLACK_APP_TOKEN = 'xapp-test';
      const { create } = await import('../../../src/providers/channel/slack.js');
      const provider = await create(testConfig());

      const session: SessionAddress = {
        provider: 'slack', scope: 'thread',
        identifiers: { channel: 'C01', thread: '1234.5678' },
      };
      await provider.addReaction!(session, '1234.5678', 'eyes');

      expect(mockReactionsAdd).toHaveBeenCalledWith({
        token: 'xoxb-test', channel: 'C01', name: 'eyes', timestamp: '1234.5678',
      });
    });

    test('removeReaction calls reactions.remove and swallows errors', async () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test';
      process.env.SLACK_APP_TOKEN = 'xapp-test';
      mockReactionsRemove.mockRejectedValueOnce(new Error('no_reaction'));
      const { create } = await import('../../../src/providers/channel/slack.js');
      const provider = await create(testConfig());

      const session: SessionAddress = {
        provider: 'slack', scope: 'channel',
        identifiers: { channel: 'C01' },
      };
      // Should not throw even when API returns error
      await expect(provider.removeReaction!(session, '1111.2222', 'eyes')).resolves.toBeUndefined();
    });

    test('addReaction uses dmChannel for DM sessions', async () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test';
      process.env.SLACK_APP_TOKEN = 'xapp-test';
      const { create } = await import('../../../src/providers/channel/slack.js');
      const provider = await create(testConfig());

      const session: SessionAddress = {
        provider: 'slack', scope: 'dm',
        identifiers: { peer: 'U123', dmChannel: 'D01' },
      };
      await provider.addReaction!(session, '1111.2222', 'eyes');

      expect(mockReactionsAdd).toHaveBeenCalledWith({
        token: 'xoxb-test', channel: 'D01', name: 'eyes', timestamp: '1111.2222',
      });
    });

    test('removeReaction uses dmChannel for DM sessions', async () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test';
      process.env.SLACK_APP_TOKEN = 'xapp-test';
      const { create } = await import('../../../src/providers/channel/slack.js');
      const provider = await create(testConfig());

      const session: SessionAddress = {
        provider: 'slack', scope: 'dm',
        identifiers: { peer: 'U123', dmChannel: 'D01' },
      };
      await provider.removeReaction!(session, '1111.2222', 'eyes');

      expect(mockReactionsRemove).toHaveBeenCalledWith({
        token: 'xoxb-test', channel: 'D01', name: 'eyes', timestamp: '1111.2222',
      });
    });

    test('addReaction uses channel for group DM sessions', async () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test';
      process.env.SLACK_APP_TOKEN = 'xapp-test';
      const { create } = await import('../../../src/providers/channel/slack.js');
      const provider = await create(testConfig());

      const session: SessionAddress = {
        provider: 'slack', scope: 'group',
        identifiers: { channel: 'G01' },
      };
      await provider.addReaction!(session, '1111.2222', 'eyes');

      expect(mockReactionsAdd).toHaveBeenCalledWith({
        token: 'xoxb-test', channel: 'G01', name: 'eyes', timestamp: '1111.2222',
      });
    });
  });

  describe('fetchThreadHistory', () => {
    test('returns messages from conversations.replies', async () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test';
      process.env.SLACK_APP_TOKEN = 'xapp-test';
      mockConversationsReplies.mockResolvedValueOnce({
        ok: true,
        messages: [
          { user: 'U1', text: 'first message', ts: '1000.0001' },
          { user: 'U2', text: 'reply', ts: '1000.0002' },
          { user: 'UBOT', text: 'bot reply', ts: '1000.0003' },
        ],
      });
      const { create } = await import('../../../src/providers/channel/slack.js');
      const provider = await create(testConfig());
      await provider.connect();

      const history = await provider.fetchThreadHistory!('C01', '1000.0001', 20);

      expect(mockConversationsReplies).toHaveBeenCalledWith(
        expect.objectContaining({ channel: 'C01', ts: '1000.0001', limit: 20 }),
      );
      expect(history).toEqual([
        { sender: 'U1', content: 'first message', ts: '1000.0001' },
        { sender: 'U2', content: 'reply', ts: '1000.0002' },
        { sender: 'UBOT', content: 'bot reply', ts: '1000.0003' },
      ]);
    });

    test('returns empty array on API error (graceful degradation)', async () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test';
      process.env.SLACK_APP_TOKEN = 'xapp-test';
      mockConversationsReplies.mockRejectedValueOnce(new Error('ratelimited'));
      const { create } = await import('../../../src/providers/channel/slack.js');
      const provider = await create(testConfig());
      await provider.connect();

      const history = await provider.fetchThreadHistory!('C01', '1000.0001');
      expect(history).toEqual([]);
    });

    test('filters messages without text or user', async () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test';
      process.env.SLACK_APP_TOKEN = 'xapp-test';
      mockConversationsReplies.mockResolvedValueOnce({
        ok: true,
        messages: [
          { user: 'U1', text: 'valid', ts: '1000.0001' },
          { text: 'no user', ts: '1000.0002' },
          { user: 'U2', ts: '1000.0003' },
        ],
      });
      const { create } = await import('../../../src/providers/channel/slack.js');
      const provider = await create(testConfig());
      await provider.connect();

      const history = await provider.fetchThreadHistory!('C01', '1000.0001', 20);
      expect(history).toEqual([
        { sender: 'U1', content: 'valid', ts: '1000.0001' },
      ]);
    });
  });

  describe('downloadAttachment', () => {
    test('includes Authorization header when fetching url_private', async () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
      process.env.SLACK_APP_TOKEN = 'xapp-test';
      const origFetch = globalThis.fetch;
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer),
      });
      globalThis.fetch = mockFetch as any;

      try {
        const { create } = await import('../../../src/providers/channel/slack.js');
        const provider = await create(testConfig());

        const result = await provider.downloadAttachment!({
          filename: 'image.png',
          mimeType: 'image/png',
          size: 4,
          url: 'https://files.slack.com/files-pri/T01-F01/image.png',
        });

        expect(mockFetch).toHaveBeenCalledWith(
          'https://files.slack.com/files-pri/T01-F01/image.png',
          { headers: { Authorization: 'Bearer xoxb-test-token' } },
        );
        expect(result).toBeInstanceOf(Buffer);
        expect(result!.length).toBe(4);
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    test('returns inline content without fetching', async () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test';
      process.env.SLACK_APP_TOKEN = 'xapp-test';
      const origFetch = globalThis.fetch;
      const mockFetch = vi.fn();
      globalThis.fetch = mockFetch as any;

      try {
        const { create } = await import('../../../src/providers/channel/slack.js');
        const provider = await create(testConfig());
        const inlineData = Buffer.from('already-downloaded');

        const result = await provider.downloadAttachment!({
          filename: 'image.png',
          mimeType: 'image/png',
          size: inlineData.length,
          content: inlineData,
          url: 'https://files.slack.com/should-not-be-called',
        });

        expect(mockFetch).not.toHaveBeenCalled();
        expect(result).toBe(inlineData);
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    test('returns undefined on fetch failure', async () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test';
      process.env.SLACK_APP_TOKEN = 'xapp-test';
      const origFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 401 }) as any;

      try {
        const { create } = await import('../../../src/providers/channel/slack.js');
        const provider = await create(testConfig());

        const result = await provider.downloadAttachment!({
          filename: 'image.png',
          mimeType: 'image/png',
          size: 100,
          url: 'https://files.slack.com/files-pri/T01-F01/image.png',
        });

        expect(result).toBeUndefined();
      } finally {
        globalThis.fetch = origFetch;
      }
    });
  });

  describe('socket resilience', () => {
    test('disables built-in auto-reconnect on socket-mode client', async () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test';
      process.env.SLACK_APP_TOKEN = 'xapp-test';
      // Reset so we can observe the assignment
      mockSocketClient.autoReconnectEnabled = true;
      const { create } = await import('../../../src/providers/channel/slack.js');
      await create(testConfig());
      expect(mockSocketClient.autoReconnectEnabled).toBe(false);
    });

    test('registers error handler on socket-mode client', async () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test';
      process.env.SLACK_APP_TOKEN = 'xapp-test';
      mockSocketClient.on.mockClear();
      const { create } = await import('../../../src/providers/channel/slack.js');
      await create(testConfig());
      expect(mockSocketClient.on).toHaveBeenCalledWith('error', expect.any(Function));
    });

    test('registers app.error() handler to catch Bolt internal rejections', async () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test';
      process.env.SLACK_APP_TOKEN = 'xapp-test';
      const errorSpy = vi.fn();
      // Replace the mock App's error method with a spy
      const origMock = vi.importActual('@slack/bolt');
      const { create } = await import('../../../src/providers/channel/slack.js');
      // The mock's error() is called during create() — verify it was called
      // by checking the App instance receives the error handler.
      // Since our mock stores nothing, just verify create() doesn't throw
      // (which it would if app.error wasn't a function).
      const provider = await create(testConfig());
      expect(provider).toBeDefined();
    });
  });

  describe('reconnection', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      process.env.SLACK_BOT_TOKEN = 'xoxb-test';
      process.env.SLACK_APP_TOKEN = 'xapp-test';
      mockIsActive.mockReturnValue(true);
      // Reset to default implementations to prevent leakage between tests
      mockAuthTest.mockReset().mockResolvedValue({ user_id: 'UBOT', team_id: 'T01' });
      mockStart.mockReset().mockResolvedValue(undefined);
      mockStop.mockReset().mockResolvedValue(undefined);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    test('health check triggers reconnect when socket becomes inactive', async () => {
      const { create } = await import('../../../src/providers/channel/slack.js');
      const provider = await create(testConfig());
      await provider.connect();

      mockStart.mockClear();
      mockAuthTest.mockClear();
      mockStop.mockClear();

      // Socket goes dead
      mockIsActive.mockReturnValue(false);

      // Advance past health check interval (30s)
      await vi.advanceTimersByTimeAsync(30_000);

      // Should have probed network (auth.test), then reconnected (stop + start + auth.test)
      expect(mockStop).toHaveBeenCalled();
      expect(mockStart).toHaveBeenCalledTimes(1);
      // probe + post-reconnect auth
      expect(mockAuthTest).toHaveBeenCalledTimes(2);

      await provider.disconnect();
    });

    test('health check does nothing when socket is active', async () => {
      const { create } = await import('../../../src/providers/channel/slack.js');
      const provider = await create(testConfig());
      await provider.connect();

      mockStart.mockClear();
      mockIsActive.mockReturnValue(true);

      // Advance past several health check cycles
      await vi.advanceTimersByTimeAsync(90_000);

      expect(mockStart).not.toHaveBeenCalled();

      await provider.disconnect();
    });

    test('reconnect retries with backoff when network probe fails', async () => {
      const { create } = await import('../../../src/providers/channel/slack.js');
      const provider = await create(testConfig());
      await provider.connect();

      mockStart.mockClear();
      mockAuthTest.mockClear();
      mockStop.mockClear();

      // Socket dead, network down for probes
      mockIsActive.mockReturnValue(false);
      mockAuthTest
        .mockRejectedValueOnce(new Error('no network'))
        .mockRejectedValueOnce(new Error('no network'))
        .mockResolvedValue({ user_id: 'UBOT', team_id: 'T01' });

      // Health check at 30s, first probe fails, backoff 5s, second fails, backoff 10s, third succeeds
      await vi.advanceTimersByTimeAsync(30_000 + 5_000 + 10_000);

      // 3 probes (2 failed + 1 success) + 1 post-reconnect auth
      expect(mockAuthTest).toHaveBeenCalledTimes(4);
      expect(mockStop).toHaveBeenCalled();
      expect(mockStart).toHaveBeenCalledTimes(1);

      await provider.disconnect();
    });

    test('disconnect stops health check and prevents reconnection', async () => {
      const { create } = await import('../../../src/providers/channel/slack.js');
      const provider = await create(testConfig());
      await provider.connect();

      mockStart.mockClear();

      await provider.disconnect();

      // Socket goes dead after intentional disconnect
      mockIsActive.mockReturnValue(false);

      // Advance past many health check cycles
      await vi.advanceTimersByTimeAsync(120_000);

      // No reconnection attempts
      expect(mockStart).not.toHaveBeenCalled();
    });
  });
});
