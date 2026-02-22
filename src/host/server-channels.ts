/**
 * Channel ingestion — message deduplication, thread gating, thread
 * backfill, bootstrap gate, emoji reactions, and reconnection.
 */

import { randomUUID } from 'node:crypto';
import type { ChannelProvider, InboundMessage } from '../providers/channel/types.js';
import { canonicalize } from '../providers/channel/types.js';
import type { ConversationStore } from '../conversation-store.js';
import type { SessionStore } from '../session-store.js';
import type { Router } from './router.js';
import type { Logger } from '../logger.js';
import type { CompletionDeps, CompletionResult } from './server-completions.js';
import { processCompletion } from './server-completions.js';
import { withRetry } from '../utils/retry.js';

// ── Channel reconnection constants ──
const CHANNEL_RECONNECT_MAX_RETRIES = 5;
const CHANNEL_RECONNECT_INITIAL_DELAY_MS = 2_000;
const CHANNEL_RECONNECT_MAX_DELAY_MS = 60_000;

// =====================================================
// Deduplication
// =====================================================

export interface DeduplicatorOptions {
  windowMs?: number;
  maxEntries?: number;
}

export class ChannelDeduplicator {
  private readonly windowMs: number;
  private readonly maxEntries: number;
  private readonly seen = new Map<string, number>();

  constructor(opts?: DeduplicatorOptions) {
    this.windowMs = opts?.windowMs ?? 60_000;
    this.maxEntries = opts?.maxEntries ?? 1000;
  }

  isDuplicate(key: string): boolean {
    const now = Date.now();
    const seen = this.seen.get(key);
    if (seen !== undefined && now - seen < this.windowMs) {
      return true;
    }
    this.seen.set(key, now);
    // Lazy prune when over capacity
    if (this.seen.size > this.maxEntries) {
      for (const [k, ts] of this.seen) {
        if (now - ts >= this.windowMs) this.seen.delete(k);
      }
    }
    return false;
  }
}

// =====================================================
// Channel handler registration
// =====================================================

export interface ChannelHandlerDeps {
  completionDeps: CompletionDeps;
  conversationStore: ConversationStore;
  sessionStore: SessionStore;
  sessionCanaries: Map<string, string>;
  router: Router;
  agentName: string;
  agentDir: string;
  deduplicator: ChannelDeduplicator;
  logger: Logger;
  isAgentBootstrapMode: (agentDir: string) => boolean;
  isAdmin: (agentDir: string, userId: string) => boolean;
  claimBootstrapAdmin: (agentDir: string, userId: string) => boolean;
}

/**
 * Wire up a single channel provider — registers onMessage handler with
 * dedup, thread gating, backfill, bootstrap gate, eyes emoji, and
 * completion processing.
 */
export function registerChannelHandler(
  channel: ChannelProvider,
  deps: ChannelHandlerDeps,
): void {
  const {
    completionDeps, conversationStore, sessionStore, sessionCanaries,
    router, agentName, agentDir, deduplicator, logger,
    isAgentBootstrapMode: isBootstrap, isAdmin: isAdminFn,
    claimBootstrapAdmin: claimBootstrapAdminFn,
  } = deps;

  channel.onMessage(async (msg: InboundMessage) => {
    if (!channel.shouldRespond(msg)) {
      logger.debug('channel_message_filtered', { provider: channel.name, sender: msg.sender });
      return;
    }

    // Deduplicate: Slack (and other providers) may deliver the same event
    // multiple times due to socket reconnections or missed acks.
    const dedupeKey = `${channel.name}:${msg.id}`;
    if (deduplicator.isDuplicate(dedupeKey)) {
      logger.debug('channel_message_deduplicated', { provider: channel.name, messageId: msg.id });
      return;
    }

    // Thread gating: only process thread messages if the bot has participated
    const sessionId = canonicalize(msg.session);
    if (msg.session.scope === 'thread' && !msg.isMention) {
      const turnCount = conversationStore.count(sessionId);
      if (turnCount === 0) {
        logger.debug('thread_message_gated', { provider: channel.name, sessionId, reason: 'bot_not_in_thread' });
        return;
      }
    }

    // Thread backfill: on first entry into a thread, fetch prior messages
    if (msg.session.scope === 'thread' && msg.isMention && channel.fetchThreadHistory) {
      const turnCount = conversationStore.count(sessionId);
      if (turnCount === 0) {
        const threadChannel = msg.session.identifiers.channel;
        const threadTs = msg.session.identifiers.thread;
        if (threadChannel && threadTs) {
          try {
            const threadMessages = await channel.fetchThreadHistory(threadChannel, threadTs, 20);
            for (const tm of threadMessages) {
              if (tm.ts === msg.id) continue; // skip current message
              conversationStore.append(sessionId, 'user', tm.content, tm.sender);
            }
            logger.debug('thread_backfill', { sessionId, messagesAdded: threadMessages.length });
          } catch (err) {
            logger.warn('thread_backfill_failed', { sessionId, error: (err as Error).message });
          }
        }
      }
    }

    // Bootstrap gate: only admins can interact while the agent is being set up.
    // The first channel user to message during bootstrap is auto-promoted to admin.
    if (isBootstrap(agentDir) && !isAdminFn(agentDir, msg.sender)) {
      if (claimBootstrapAdminFn(agentDir, msg.sender)) {
        logger.info('bootstrap_admin_claimed', { provider: channel.name, sender: msg.sender });
      } else {
        logger.info('bootstrap_gate_blocked', { provider: channel.name, sender: msg.sender });
        await channel.send(msg.session, {
          content: 'This agent is still being set up. Only admins can interact during bootstrap.',
        });
        return;
      }
    }

    // Eyes emoji: acknowledge receipt
    if (channel.addReaction) {
      channel.addReaction(msg.session, msg.id, 'eyes').catch(() => {});
    }

    try {
      const result = await router.processInbound(msg);
      if (!result.queued) {
        await channel.send(msg.session, {
          content: `Message blocked: ${result.scanResult.reason ?? 'security scan failed'}`,
        });
        return;
      }
      sessionCanaries.set(result.sessionId, result.canaryToken);

      // Determine if reply is optional (LLM can choose not to respond)
      const replyOptional = !msg.isMention;

      const { responseContent } = await processCompletion(
        completionDeps, msg.content, `ch-${randomUUID().slice(0, 8)}`, [], sessionId,
        { sessionId: result.sessionId, messageId: result.messageId!, canaryToken: result.canaryToken },
        msg.sender,
        replyOptional,
      );

      // If LLM chose not to reply, skip sending
      if (responseContent.trim()) {
        await channel.send(msg.session, { content: responseContent });
      }

      // Track last channel session for "last" delivery target resolution
      sessionStore.trackSession(agentName, msg.session);
    } finally {
      // Remove eyes emoji regardless of outcome
      if (channel.removeReaction) {
        channel.removeReaction(msg.session, msg.id, 'eyes').catch(() => {});
      }
    }
  });
}

// =====================================================
// Channel connection with retry
// =====================================================

/**
 * Connect a channel provider with retry and exponential backoff.
 *
 * If the initial connection fails, retries up to CHANNEL_RECONNECT_MAX_RETRIES
 * times with exponential backoff. Logs each attempt.
 */
export async function connectChannelWithRetry(
  channel: ChannelProvider,
  logger: Logger,
): Promise<void> {
  await withRetry(
    () => channel.connect(),
    {
      maxRetries: CHANNEL_RECONNECT_MAX_RETRIES,
      initialDelayMs: CHANNEL_RECONNECT_INITIAL_DELAY_MS,
      maxDelayMs: CHANNEL_RECONNECT_MAX_DELAY_MS,
      label: `channel:${channel.name}`,
      isRetryable: (err) => {
        // Auth errors are permanent — don't retry with bad tokens
        const msg = err instanceof Error ? err.message.toLowerCase() : '';
        if (msg.includes('invalid_auth') || msg.includes('401') || msg.includes('403')) return false;
        if (msg.includes('not_authed') || msg.includes('token')) return false;
        return true;
      },
    },
  );
}
