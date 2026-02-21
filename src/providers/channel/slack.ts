import type {
  ChannelProvider,
  ChannelAccessConfig,
  InboundMessage,
  OutboundMessage,
  SessionAddress,
  Attachment,
} from './types.js';
import type { Config } from '../../types.js';
import { getLogger } from '../../logger.js';

const SLACK_MAX_TEXT = 4000;
const HEALTH_CHECK_MS = 30_000;
const INITIAL_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 5 * 60 * 1000;

const DEFAULT_ACCESS: ChannelAccessConfig = {
  dmPolicy: 'open',
  requireMention: true,
  maxAttachmentBytes: 20 * 1024 * 1024,
};

interface SlackMessage {
  text: string;
  user: string;
  channel: string;
  ts: string;
  thread_ts?: string;
  channel_type?: string;
  files?: SlackFile[];
}

interface SlackFile {
  id: string;
  name: string;
  mimetype: string;
  size: number;
  url_private: string;
}

/**
 * Split text into chunks that fit within Slack's message size limit.
 * Prefers splitting at newline boundaries.
 */
function chunkText(text: string, limit: number = SLACK_MAX_TEXT): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }

    // Find last newline within limit
    let splitAt = remaining.lastIndexOf('\n', limit);
    if (splitAt <= 0) splitAt = limit; // No newline found — hard split

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, '');
  }

  return chunks;
}

export async function create(config: Config): Promise<ChannelProvider> {
  const botToken = process.env.SLACK_BOT_TOKEN;
  const appToken = process.env.SLACK_APP_TOKEN;

  if (!botToken || !appToken) {
    throw new Error(
      'Slack channel requires SLACK_BOT_TOKEN and SLACK_APP_TOKEN environment variables.\n' +
      'Enable Socket Mode in your Slack app settings and generate an app-level token.',
    );
  }

  // Read access config from ax.yaml channel_config.slack (supports both camelCase and snake_case)
  const rawConfig: Record<string, any> = (config.channel_config?.slack ?? {}) as Record<string, any>;
  const access: ChannelAccessConfig = {
    dmPolicy: rawConfig.dmPolicy ?? rawConfig.dm_policy ?? DEFAULT_ACCESS.dmPolicy,
    allowedUsers: rawConfig.allowedUsers ?? rawConfig.allowed_users,
    requireMention: rawConfig.requireMention ?? rawConfig.require_mention ?? DEFAULT_ACCESS.requireMention,
    mentionPatterns: rawConfig.mentionPatterns ?? rawConfig.mention_patterns,
    maxAttachmentBytes: rawConfig.maxAttachmentBytes ?? rawConfig.max_attachment_bytes ?? DEFAULT_ACCESS.maxAttachmentBytes,
    allowedMimeTypes: rawConfig.allowedMimeTypes ?? rawConfig.allowed_mime_types,
  };

  // Dynamic import — @slack/bolt is an optional dependency
  const { App, SocketModeReceiver } = await import('@slack/bolt');

  const slackLogger = getLogger().child({ component: 'slack' });

  let messageHandler: ((msg: InboundMessage) => Promise<void>) | null = null;
  let botUserId: string | undefined;
  let teamId: string | undefined;
  let healthCheckInterval: ReturnType<typeof setInterval> | null = null;
  let reconnecting = false;
  let intentionalDisconnect = false;

  // Create receiver explicitly so we can monitor socket health.
  // Disable the library's built-in auto-reconnect — it has an unhandled promise
  // rejection bug in delayReconnectAttempt when start() fails during reconnection.
  // We run our own health-check loop (ensureConnected) instead.
  const receiver = new SocketModeReceiver({ appToken });
  (receiver.client as any).autoReconnectEnabled = false;
  const app = new App({
    token: botToken,
    receiver,
  });

  // Catch errors emitted by the socket-mode client so they don't become
  // unhandled 'error' events on the EventEmitter.
  receiver.client.on('error', (err: unknown) => {
    slackLogger.warn('slack_socket_error', { error: err instanceof Error ? err.message : String(err) });
  });

  async function ensureConnected(): Promise<void> {
    if (intentionalDisconnect || reconnecting) return;

    const ws = (receiver.client as any).websocket;
    if (ws?.isActive?.()) return;

    reconnecting = true;
    let delay = INITIAL_BACKOFF_MS;

    while (!intentionalDisconnect) {
      try {
        // Quick probe: can we reach Slack at all?
        await app.client.auth.test({ token: botToken });
      } catch (err) {
        // Network still down — wait and try again
        slackLogger.warn('slack_probe_failed', { error: (err as Error).message, backoffMs: delay });
        await new Promise(r => setTimeout(r, delay));
        delay = Math.min(delay * 2, MAX_BACKOFF_MS);
        continue;
      }

      try {
        // Network is reachable — attempt full socket reconnect
        await app.stop().catch(() => {});
        await app.start();
        const authResult = await app.client.auth.test({ token: botToken });
        botUserId = authResult.user_id as string;
        teamId = authResult.team_id as string;
        slackLogger.info('slack_reconnected');
        reconnecting = false;
        return;
      } catch (err) {
        // Socket reconnect failed — retry with backoff
        slackLogger.warn('slack_reconnect_failed', { error: (err as Error).message, backoffMs: delay });
        await new Promise(r => setTimeout(r, delay));
        delay = Math.min(delay * 2, MAX_BACKOFF_MS);
      }
    }
    reconnecting = false;
  }

  function buildSession(
    user: string,
    channel: string,
    threadTs?: string,
    channelType?: string,
  ): SessionAddress {
    // DMs: scoped per user
    if (channelType === 'im') {
      return {
        provider: 'slack',
        scope: 'dm',
        identifiers: { peer: user },
      };
    }

    // Group DMs (multi-party): scoped per group channel
    if (channelType === 'mpim') {
      return {
        provider: 'slack',
        scope: 'group',
        identifiers: { channel },
      };
    }

    // Thread: own session with parent pointing to channel
    if (threadTs) {
      return {
        provider: 'slack',
        scope: 'thread',
        identifiers: { channel, thread: threadTs },
        parent: {
          provider: 'slack',
          scope: 'channel',
          identifiers: { channel },
        },
      };
    }

    // Channel: shared across all users
    return {
      provider: 'slack',
      scope: 'channel',
      identifiers: { channel },
    };
  }

  function buildAttachments(files?: SlackFile[]): Attachment[] {
    if (!files?.length) return [];
    return files
      .filter(f => f.size <= access.maxAttachmentBytes)
      .filter(f => {
        if (!access.allowedMimeTypes?.length) return true;
        return access.allowedMimeTypes.some(pattern => {
          if (pattern.endsWith('/*')) {
            return f.mimetype.startsWith(pattern.slice(0, -1));
          }
          return f.mimetype === pattern;
        });
      })
      .map(f => ({
        filename: f.name,
        mimeType: f.mimetype,
        size: f.size,
        url: f.url_private,
      }));
  }

  // Handle DMs, group DMs, and thread replies — top-level channel messages are handled by app_mention
  app.message(async ({ message }) => {
    const msg = message as SlackMessage;
    if (!msg.text || !msg.user) return;
    if (msg.user === botUserId) return;
    if (!messageHandler) return;

    const isDm = msg.channel_type === 'im' || msg.channel_type === 'mpim';
    const isThreadReply = !!msg.thread_ts;

    // Drop top-level channel messages — only app_mention handles those
    if (!isDm && !isThreadReply) return;

    await messageHandler({
      id: msg.ts,
      session: buildSession(msg.user, msg.channel, msg.thread_ts, msg.channel_type),
      sender: msg.user,
      content: msg.text,
      attachments: buildAttachments(msg.files),
      timestamp: new Date(parseFloat(msg.ts) * 1000),
      replyTo: msg.thread_ts,
      raw: message,
      isMention: false,
    });
  });

  // Handle @mentions in channels
  app.event('app_mention', async ({ event }) => {
    if (!event.text || !event.user) return;
    if (event.user === botUserId) return;
    if (!messageHandler) return;

    // Strip bot mention from text
    let text = event.text.trim();
    if (botUserId) {
      text = text.replace(new RegExp(`<@${botUserId}>\\s*`, 'g'), '').trim();
    }
    if (!text) return;

    await messageHandler({
      id: event.ts,
      session: buildSession(event.user, event.channel, event.thread_ts ?? event.ts),
      sender: event.user,
      content: text,
      attachments: buildAttachments((event as any).files),
      timestamp: new Date(parseFloat(event.ts) * 1000),
      replyTo: event.thread_ts,
      raw: event,
      isMention: true,
    });
  });

  return {
    name: 'slack',

    async connect(): Promise<void> {
      intentionalDisconnect = false;
      await app.start();
      const authResult = await app.client.auth.test({ token: botToken });
      botUserId = authResult.user_id as string;
      teamId = authResult.team_id as string;
      healthCheckInterval = setInterval(() => {
        ensureConnected().catch((err) => {
          slackLogger.warn('slack_health_check_error', { error: err instanceof Error ? err.message : String(err) });
        });
      }, HEALTH_CHECK_MS);
    },

    onMessage(handler: (msg: InboundMessage) => Promise<void>): void {
      messageHandler = handler;
    },

    shouldRespond(msg: InboundMessage): boolean {
      if (msg.session.provider !== 'slack') return true;

      if (msg.session.scope === 'dm') {
        if (access.dmPolicy === 'disabled') return false;
        if (access.dmPolicy === 'allowlist') {
          return access.allowedUsers?.includes(msg.sender) ?? false;
        }
        return true; // 'open'
      }

      // Channel and thread messages — mention gating is handled by Slack event
      // subscription (app_mention only fires when bot is mentioned).
      return true;
    },

    async send(session: SessionAddress, content: OutboundMessage): Promise<void> {
      const channel = session.identifiers.channel ?? session.identifiers.peer;
      if (!channel) throw new Error('SessionAddress has no channel or peer identifier for send()');

      const threadTs = session.identifiers.thread ?? content.replyTo;

      // Upload attachments first
      if (content.attachments?.length) {
        for (const att of content.attachments) {
          if (att.content) {
            await app.client.files.uploadV2({
              token: botToken,
              channel_id: channel,
              file: att.content,
              filename: att.filename,
              ...(threadTs ? { thread_ts: threadTs } : {}),
            });
          }
        }
      }

      // Send text in chunks
      const chunks = chunkText(content.content);
      for (const chunk of chunks) {
        await app.client.chat.postMessage({
          token: botToken,
          channel,
          text: chunk,
          ...(threadTs ? { thread_ts: threadTs } : {}),
        });
      }
    },

    async fetchThreadHistory(channel: string, threadTs: string, limit: number = 20): Promise<{sender: string; content: string; ts: string}[]> {
      try {
        const response = await app.client.conversations.replies({
          token: botToken,
          channel,
          ts: threadTs,
          limit,
          inclusive: true,
        }) as { ok: boolean; messages?: Array<{ user?: string; text?: string; ts?: string }> };

        if (!response.messages) return [];

        return response.messages
          .filter((m): m is { user: string; text: string; ts: string } =>
            !!m.user && !!m.text && !!m.ts)
          .map(m => ({ sender: m.user, content: m.text, ts: m.ts }));
      } catch {
        return [];
      }
    },

    async addReaction(session: SessionAddress, messageId: string, emoji: string): Promise<void> {
      const channel = session.identifiers.channel ?? session.identifiers.peer;
      if (!channel) return;
      await app.client.reactions.add({ token: botToken, channel, name: emoji, timestamp: messageId });
    },

    async removeReaction(session: SessionAddress, messageId: string, emoji: string): Promise<void> {
      const channel = session.identifiers.channel ?? session.identifiers.peer;
      if (!channel) return;
      await app.client.reactions.remove({ token: botToken, channel, name: emoji, timestamp: messageId }).catch(() => {});
    },

    async disconnect(): Promise<void> {
      intentionalDisconnect = true;
      if (healthCheckInterval) {
        clearInterval(healthCheckInterval);
        healthCheckInterval = null;
      }
      await app.stop();
    },
  };
}
