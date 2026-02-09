import { randomUUID } from 'node:crypto';
import type { ChannelProvider, InboundMessage, OutboundMessage, Config } from '../types.js';

/**
 * Slack channel provider using @slack/bolt with Socket Mode.
 *
 * Socket Mode uses WebSocket — no inbound HTTP listener needed (aligns with
 * "no listening ports" security posture). Requires:
 *   - SLACK_BOT_TOKEN (xoxb-)
 *   - SLACK_APP_TOKEN (xapp-) for Socket Mode
 *
 * Session mapping: Slack user + channel IDs → stable session IDs.
 */

interface SlackMessage {
  text: string;
  user: string;
  channel: string;
  ts: string;
  thread_ts?: string;
}

export async function create(_config: Config): Promise<ChannelProvider> {
  const botToken = process.env.SLACK_BOT_TOKEN;
  const appToken = process.env.SLACK_APP_TOKEN;

  if (!botToken || !appToken) {
    throw new Error(
      'Slack channel requires SLACK_BOT_TOKEN and SLACK_APP_TOKEN environment variables.\n' +
      'Enable Socket Mode in your Slack app settings and generate an app-level token.',
    );
  }

  // Dynamic import — @slack/bolt is an optional dependency
  const { App } = await import('@slack/bolt');

  let messageHandler: ((msg: InboundMessage) => void) | null = null;
  let botUserId: string | undefined;

  // Map (user, channel) → stable session ID
  const sessionMap = new Map<string, string>();
  function getSessionId(user: string, channel: string): string {
    const key = `${user}:${channel}`;
    let id = sessionMap.get(key);
    if (!id) {
      id = randomUUID();
      sessionMap.set(key, id);
    }
    return id;
  }

  const app = new App({
    token: botToken,
    appToken,
    socketMode: true,
  });

  // Handle direct messages
  app.message(async ({ message }) => {
    const msg = message as SlackMessage;
    if (!msg.text || !msg.user) return;
    if (msg.user === botUserId) return;

    if (messageHandler) {
      messageHandler({
        id: getSessionId(msg.user, msg.channel),
        channel: 'slack',
        sender: msg.user,
        content: msg.text,
        timestamp: new Date(parseFloat(msg.ts) * 1000),
        isGroup: false,
        groupId: msg.thread_ts,
      });
    }
  });

  // Handle @mentions in channels
  app.event('app_mention', async ({ event }) => {
    if (!event.text || !event.user) return;
    if (event.user === botUserId) return;

    // Strip the bot mention from the message text
    const text = event.text.replace(/<@[A-Z0-9]+>/g, '').trim();
    if (!text) return;

    if (messageHandler) {
      messageHandler({
        id: getSessionId(event.user, event.channel),
        channel: 'slack',
        sender: event.user,
        content: text,
        timestamp: new Date(parseFloat(event.ts) * 1000),
        isGroup: true,
        groupId: event.thread_ts ?? event.ts,
      });
    }
  });

  return {
    name: 'slack',

    async connect(): Promise<void> {
      await app.start();
      const authResult = await app.client.auth.test({ token: botToken });
      botUserId = authResult.user_id as string;
    },

    onMessage(handler: (msg: InboundMessage) => void): void {
      messageHandler = handler;
    },

    async send(target: string, content: OutboundMessage): Promise<void> {
      // target format: "channel_id" or "channel_id:thread_ts"
      const [channel, threadTs] = target.split(':');

      await app.client.chat.postMessage({
        token: botToken,
        channel,
        text: content.content,
        ...(threadTs ? { thread_ts: threadTs } : {}),
        ...(content.replyTo ? { thread_ts: content.replyTo } : {}),
      });
    },

    async disconnect(): Promise<void> {
      await app.stop();
    },
  };
}
