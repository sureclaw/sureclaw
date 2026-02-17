import type {
  ChannelProvider,
  ChannelAccessConfig,
  InboundMessage,
  OutboundMessage,
  SessionAddress,
  Attachment,
} from './types.js';
import type { Config } from '../../types.js';

const SLACK_MAX_TEXT = 4000;

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
  const { App } = await import('@slack/bolt');

  let messageHandler: ((msg: InboundMessage) => Promise<void>) | null = null;
  let botUserId: string | undefined;
  let teamId: string | undefined;

  const app = new App({
    token: botToken,
    appToken,
    socketMode: true,
  });

  function buildSession(
    user: string,
    channel: string,
    threadTs?: string,
    isDM?: boolean,
  ): SessionAddress {
    if (isDM) {
      return {
        provider: 'slack',
        scope: 'dm',
        identifiers: { workspace: teamId, peer: user },
      };
    }

    if (threadTs) {
      const channelSession: SessionAddress = {
        provider: 'slack',
        scope: 'channel',
        identifiers: { workspace: teamId, channel, peer: user },
      };
      return {
        provider: 'slack',
        scope: 'thread',
        identifiers: { workspace: teamId, channel, thread: threadTs, peer: user },
        parent: channelSession,
      };
    }

    return {
      provider: 'slack',
      scope: 'channel',
      identifiers: { workspace: teamId, channel, peer: user },
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

  // Handle direct messages only — channel messages are handled by app_mention
  app.message(async ({ message }) => {
    const msg = message as SlackMessage;
    if (!msg.text || !msg.user) return;
    if (msg.user === botUserId) return;
    if (!messageHandler) return;

    // Only process DMs here; channel messages are handled by app_mention
    if (msg.channel_type !== 'im') return;

    await messageHandler({
      id: msg.ts,
      session: buildSession(msg.user, msg.channel, msg.thread_ts, true),
      sender: msg.user,
      content: msg.text,
      attachments: buildAttachments(msg.files),
      timestamp: new Date(parseFloat(msg.ts) * 1000),
      replyTo: msg.thread_ts,
      raw: message,
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
    });
  });

  return {
    name: 'slack',

    async connect(): Promise<void> {
      await app.start();
      const authResult = await app.client.auth.test({ token: botToken });
      botUserId = authResult.user_id as string;
      teamId = authResult.team_id as string;
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

    async disconnect(): Promise<void> {
      await app.stop();
    },
  };
}
