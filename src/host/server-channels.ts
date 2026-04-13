/**
 * Channel ingestion — message deduplication, thread gating, thread
 * backfill, bootstrap gate, emoji reactions, reconnection, and
 * per-message agent routing for multi-agent Slack UX.
 */

import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { ChannelProvider, InboundMessage, Attachment } from '../providers/channel/types.js';
import { canonicalize } from '../providers/channel/types.js';
import type { ContentBlock, ImageMimeType, UploadMimeType } from '../types.js';
import { IMAGE_MIME_TYPES, UPLOAD_MIME_TYPES } from '../types.js';
import { userWorkspaceDir } from '../paths.js';
import { safePath } from '../utils/safe-path.js';
import type { GcsFileStorage } from './gcs-file-storage.js';
import type { FileStore } from '../file-store.js';
import type { ConversationStoreProvider, SessionStoreProvider } from '../providers/storage/types.js';
import type { Router } from './router.js';
import type { Logger } from '../logger.js';
import type { CompletionDeps, CompletionResult, ExtractedFile } from './server-completions.js';
import { processCompletion } from './server-completions.js';
import { withRetry } from '../utils/retry.js';
import type { AgentProvisioner } from './agent-provisioner.js';
import type { AgentRegistry, AgentRegistryEntry } from './agent-registry.js';

// ── Channel reconnection constants ──
const CHANNEL_RECONNECT_MAX_RETRIES = 5;
const CHANNEL_RECONNECT_INITIAL_DELAY_MS = 2_000;
const CHANNEL_RECONNECT_MAX_DELAY_MS = 60_000;

/**
 * Download channel attachments and embed them as content blocks.
 * Images become image_data blocks, documents become file blocks (uploaded to GCS).
 * If all downloads fail, returns the text content as-is.
 */
export async function buildContentWithAttachments(
  textContent: string,
  attachments: Attachment[],
  logger: Logger,
  downloadFn?: (att: Attachment) => Promise<Buffer | undefined>,
  opts?: { gcsFileStorage?: GcsFileStorage; fileStore?: FileStore; agentName?: string; userId?: string },
): Promise<string | ContentBlock[]> {
  const supportedAttachments = attachments.filter(
    a => UPLOAD_MIME_TYPES.includes(a.mimeType as UploadMimeType),
  );
  if (supportedAttachments.length === 0) return textContent;

  const blocks: ContentBlock[] = [];
  if (textContent.trim()) {
    blocks.push({ type: 'text', text: textContent });
  }

  for (const att of supportedAttachments) {
    try {
      // Use provider-specific download function (handles auth), fall back to plain fetch
      let data: Buffer | undefined = att.content;
      if (!data && downloadFn) {
        data = await downloadFn(att);
      }
      if (!data && att.url) {
        const resp = await fetch(att.url);
        if (!resp.ok) {
          logger.warn('attachment_download_failed', { url: att.url, status: resp.status });
          continue;
        }
        data = Buffer.from(await resp.arrayBuffer());
      }
      if (!data || data.length === 0) continue;

      const isImage = IMAGE_MIME_TYPES.includes(att.mimeType as ImageMimeType);

      // Upload to GCS if available, creating file blocks with persistent fileIds
      if (opts?.gcsFileStorage) {
        const ext = att.filename?.split('.').pop() ?? (isImage ? 'png' : 'bin');
        const fileId = `files/${randomUUID()}.${ext}`;
        await opts.gcsFileStorage.upload(fileId, data, att.mimeType, att.filename ?? fileId);
        await opts.fileStore?.register(fileId, opts.agentName ?? 'system', opts.userId ?? 'unknown', att.mimeType, att.filename ?? '');

        if (isImage) {
          blocks.push({ type: 'image', fileId, mimeType: att.mimeType as ImageMimeType });
        } else {
          blocks.push({ type: 'file', fileId, mimeType: att.mimeType, filename: att.filename ?? fileId });
        }
      } else if (isImage) {
        // Inline image_data for non-GCS mode (images only)
        blocks.push({
          type: 'image_data',
          data: data.toString('base64'),
          mimeType: att.mimeType as ImageMimeType,
        });
      } else {
        // Non-GCS document attachments: inline as file_data
        blocks.push({
          type: 'file_data',
          data: data.toString('base64'),
          mimeType: att.mimeType,
          filename: att.filename ?? 'attachment',
        });
      }
    } catch (err) {
      logger.warn('attachment_download_failed', {
        filename: att.filename,
        error: (err as Error).message,
      });
    }
  }

  // If no attachments were processed, return plain text
  if (blocks.length <= 1 && blocks[0]?.type === 'text') return textContent;
  if (blocks.length === 0) return textContent;
  return blocks;
}

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
// Thread ownership tracking
// =====================================================

/**
 * In-memory thread-to-agent mapping. Tracks which agent "owns" a thread.
 * When a bot responds in a thread, the thread is bound to that agent's ID.
 * This ensures that follow-up messages in the same thread go to the same agent.
 */
export class ThreadOwnershipMap {
  private readonly owners = new Map<string, string>();

  /** Record that agentId owns this thread (keyed by "channel:threadTs"). */
  set(channel: string, threadTs: string, agentId: string): void {
    this.owners.set(`${channel}:${threadTs}`, agentId);
  }

  /** Get the agent that owns a thread, if any. */
  get(channel: string, threadTs: string): string | undefined {
    return this.owners.get(`${channel}:${threadTs}`);
  }
}

// =====================================================
// Agent routing
// =====================================================

export interface AgentRoutingResult {
  agentId: string;
  displayName: string;
  agentKind: 'personal' | 'shared';
}

/**
 * Resolve which agent handles this message.
 *
 * Routing rules:
 * 1. Thread messages → thread owner (if tracked)
 * 2. DM/group → sender's personal agent (via provisioner)
 * 3. Channel @mention → boundAgentId if channel is owned by a shared agent,
 *    else sender's personal agent
 */
export async function resolveAgentForMessage(
  msg: InboundMessage,
  opts: {
    provisioner?: AgentProvisioner;
    agentRegistry?: AgentRegistry;
    threadOwners?: ThreadOwnershipMap;
    boundAgentId?: string;
    fallbackAgentName: string;
  },
): Promise<AgentRoutingResult> {
  const { provisioner, agentRegistry, threadOwners, boundAgentId, fallbackAgentName } = opts;

  // 1. Thread ownership: if we've already responded in this thread, keep the same agent
  if (msg.session.scope === 'thread' && threadOwners) {
    const channel = msg.session.identifiers.channel;
    const threadTs = msg.session.identifiers.thread;
    if (channel && threadTs) {
      const ownerId = threadOwners.get(channel, threadTs);
      if (ownerId && agentRegistry) {
        const owner = await agentRegistry.get(ownerId);
        if (owner) {
          return {
            agentId: owner.id,
            displayName: owner.displayName,
            agentKind: owner.agentKind,
          };
        }
      }
    }
  }

  // 2. If channel is bound to a shared agent, use that agent
  if (boundAgentId && agentRegistry) {
    const bound = await agentRegistry.get(boundAgentId);
    if (bound) {
      return {
        agentId: bound.id,
        displayName: bound.displayName,
        agentKind: bound.agentKind,
      };
    }
  }

  // 3. Use provisioner to get/create personal agent for the sender
  if (provisioner) {
    try {
      const agent = await provisioner.resolveAgent(msg.sender);
      return {
        agentId: agent.id,
        displayName: agent.displayName,
        agentKind: agent.agentKind,
      };
    } catch (err) {
      // Fall through to default
    }
  }

  // 4. Fallback: use the default agentName
  return {
    agentId: fallbackAgentName,
    displayName: fallbackAgentName,
    agentKind: 'personal',
  };
}

// =====================================================
// Response prefix
// =====================================================

/**
 * Prepend a display-name prefix for personal agents responding in shared channels/threads.
 * Shared agents don't need a prefix because they have their own Slack bot identity.
 * DMs also don't need a prefix since the conversation is 1:1.
 */
export function maybeAddResponsePrefix(
  content: string,
  routing: AgentRoutingResult,
  sessionScope: string | undefined,
): string {
  // No prefix needed for shared agents (they have their own bot identity)
  if (routing.agentKind === 'shared') return content;
  // No prefix needed in DMs (1:1 conversation)
  if (sessionScope === 'dm') return content;
  // Add prefix in channels and threads for personal agents
  if (sessionScope === 'channel' || sessionScope === 'thread') {
    return `[${routing.displayName}] ${content}`;
  }
  return content;
}

// =====================================================
// Channel handler registration
// =====================================================

export interface ChannelHandlerDeps {
  completionDeps: CompletionDeps;
  conversationStore: ConversationStoreProvider;
  sessionStore: SessionStoreProvider;
  sessionCanaries: Map<string, string>;
  router: Router;
  agentName: string;
  agentDir: string;
  deduplicator: ChannelDeduplicator;
  logger: Logger;
  isAgentBootstrapMode: (agentName: string) => boolean;
  isAdmin: (agentDir: string, userId: string) => boolean;
  claimBootstrapAdmin: (agentDir: string, userId: string) => boolean;
  /** Dynamic agent provisioner for per-message routing. */
  provisioner?: AgentProvisioner;
  /** Agent registry for looking up agent metadata. */
  agentRegistry?: AgentRegistry;
  /** Thread ownership tracker — shared across all channel handlers. */
  threadOwners?: ThreadOwnershipMap;
  /** If set, this channel is bound to a specific shared agent. */
  boundAgentId?: string;
}

/**
 * Wire up a single channel provider — registers onMessage handler with
 * dedup, thread gating, backfill, bootstrap gate, eyes emoji, and
 * completion processing. Supports per-message agent routing.
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
    provisioner, agentRegistry, threadOwners, boundAgentId,
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
      const turnCount = await conversationStore.count(sessionId);
      if (turnCount === 0) {
        logger.debug('thread_message_gated', { provider: channel.name, sessionId, reason: 'bot_not_in_thread' });
        return;
      }
    }

    // Thread backfill: on first entry into a thread, fetch prior messages
    if (msg.session.scope === 'thread' && msg.isMention && channel.fetchThreadHistory) {
      const turnCount = await conversationStore.count(sessionId);
      if (turnCount === 0) {
        const threadChannel = msg.session.identifiers.channel;
        const threadTs = msg.session.identifiers.thread;
        if (threadChannel && threadTs) {
          try {
            const threadMessages = await channel.fetchThreadHistory(threadChannel, threadTs, 20);
            for (const tm of threadMessages) {
              if (tm.ts === msg.id) continue; // skip current message
              await conversationStore.append(sessionId, 'user', tm.content, tm.sender);
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
    if (isBootstrap(agentName) && !isAdminFn(agentDir, msg.sender)) {
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
      // ── Per-message agent routing ──
      const routing = await resolveAgentForMessage(msg, {
        provisioner,
        agentRegistry,
        threadOwners,
        boundAgentId,
        fallbackAgentName: agentName,
      });
      logger.debug('channel_agent_routed', {
        provider: channel.name,
        sender: msg.sender,
        agentId: routing.agentId,
        agentKind: routing.agentKind,
        scope: msg.session.scope,
      });

      const result = await router.processInbound(msg);
      if (!result.queued) {
        await channel.send(msg.session, {
          content: `Message blocked: ${result.scanResult.reason ?? 'security scan failed'}`,
        });
        return;
      }
      sessionCanaries.set(result.sessionId, result.canaryToken);

      // Download attachments and embed as content blocks (images + documents)
      const downloadFn = channel.downloadAttachment?.bind(channel);
      const messageContent = msg.attachments.length > 0
        ? await buildContentWithAttachments(msg.content, msg.attachments, logger, downloadFn, {
            gcsFileStorage: completionDeps.gcsFileStorage,
            fileStore: completionDeps.fileStore,
            agentName,
            userId: msg.sender,
          })
        : msg.content;

      // Determine if reply is optional (LLM can choose not to respond)
      const replyOptional = !msg.isMention;

      // Override agent_name in completion deps for per-message routing
      const routedConfig = routing.agentId !== agentName
        ? { ...completionDeps.config, agent_name: routing.agentId }
        : completionDeps.config;
      const routedDeps = routing.agentId !== agentName
        ? { ...completionDeps, config: routedConfig }
        : completionDeps;

      const { responseContent, contentBlocks, extractedFiles, agentName: resultAgent, userId: resultUser } = await processCompletion(
        routedDeps, messageContent, `ch-${randomUUID().slice(0, 8)}`, [], sessionId,
        { sessionId: result.sessionId, messageId: result.messageId!, canaryToken: result.canaryToken },
        msg.sender,
        replyOptional,
        msg.session.scope,
      );

      // Track thread ownership after successful response
      if (threadOwners && msg.session.scope === 'thread') {
        const threadChannel = msg.session.identifiers.channel;
        const threadTs = msg.session.identifiers.thread;
        if (threadChannel && threadTs) {
          threadOwners.set(threadChannel, threadTs, routing.agentId);
        }
      }
      // Also track ownership for new threads started from channel @mentions
      if (threadOwners && msg.session.scope === 'thread' && msg.isMention) {
        const threadChannel = msg.session.identifiers.channel;
        const threadTs = msg.session.identifiers.thread;
        if (threadChannel && threadTs) {
          threadOwners.set(threadChannel, threadTs, routing.agentId);
        }
      }

      // If LLM chose not to reply, skip sending
      if (responseContent.trim()) {
        // Build outbound attachments from extracted files (already in memory)
        // or fall back to reading from disk for pre-existing image file refs.
        const outboundAttachments: Attachment[] = [];
        if (contentBlocks) {
          // Index extracted files by fileId for O(1) lookup
          const extractedMap = new Map<string, ExtractedFile>();
          if (extractedFiles) {
            for (const ef of extractedFiles) extractedMap.set(ef.fileId, ef);
          }

          for (const block of contentBlocks) {
            if (block.type === 'image') {
              const extracted = extractedMap.get(block.fileId);
              if (extracted) {
                // Use in-memory Buffer directly — no disk read needed
                outboundAttachments.push({
                  filename: block.fileId.split('/').pop() ?? block.fileId,
                  mimeType: block.mimeType,
                  size: extracted.data.length,
                  content: extracted.data,
                });
              } else {
                // Fallback: read from disk (e.g. agent wrote file via workspace provider)
                const agent = resultAgent ?? agentName;
                const user = resultUser ?? msg.sender ?? 'default';
                try {
                  const wsDir = userWorkspaceDir(agent, user);
                  const segments = block.fileId.split('/').filter(Boolean);
                  const filePath = safePath(wsDir, ...segments);
                  const data = readFileSync(filePath);
                  outboundAttachments.push({
                    filename: segments[segments.length - 1] ?? block.fileId,
                    mimeType: block.mimeType,
                    size: data.length,
                    content: data,
                  });
                } catch (err) {
                  logger.warn('outbound_attachment_failed', {
                    fileId: block.fileId,
                    error: (err as Error).message,
                  });
                }
              }
            }
          }
        }
        // Strip markdown image references for files being uploaded as attachments.
        // Agents emit ![alt](generated-xxx.png) but Slack/channels don't render markdown
        // images — the actual file is uploaded separately via the attachment flow.
        let finalContent = responseContent;
        if (outboundAttachments.length > 0) {
          const attachedFilenames = new Set(outboundAttachments.map(a => a.filename));
          finalContent = finalContent.replace(
            /!\[[^\]]*\]\(([^)]+)\)/g,
            (_match, src: string) => {
              const basename = src.split('/').pop() ?? src;
              return attachedFilenames.has(basename) ? '' : _match;
            },
          );
          // Clean up leftover blank lines from stripped references
          finalContent = finalContent.replace(/\n{3,}/g, '\n\n').trim();
        }

        // Add display name prefix for personal agents in shared contexts
        finalContent = maybeAddResponsePrefix(finalContent, routing, msg.session.scope);

        await channel.send(msg.session, {
          content: finalContent,
          ...(outboundAttachments.length > 0 ? { attachments: outboundAttachments } : {}),
        });
      }

      // Track last channel session for "last" delivery target resolution
      await sessionStore.trackSession(routing.agentId, msg.session);
    } catch (err) {
      logger.error('channel_response_failed', {
        provider: channel.name,
        error: (err as Error).message,
        stack: (err as Error).stack,
      });
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
    async () => {
      try {
        await channel.connect();
      } catch (err) {
        // Some SDKs (e.g. @slack/bolt) reject with undefined — wrap so we get a real Error
        if (err == null) {
          throw new Error(`${channel.name} connect() rejected without an error value`);
        }
        throw err;
      }
    },
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
