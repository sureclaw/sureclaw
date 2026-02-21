// src/providers/channel/types.ts — Channel provider types

// ─── Session Addressing ────────────────────────────

export type SessionScope = 'dm' | 'channel' | 'thread' | 'group';

export interface SessionAddress {
  provider: string;
  scope: SessionScope;
  identifiers: {
    workspace?: string;
    channel?: string;
    thread?: string;
    peer?: string;
    dmChannel?: string;
  };
  parent?: SessionAddress;
}

/**
 * Deterministic serialization of a SessionAddress for use as map keys.
 * Format: "provider:scope:workspace:channel:thread:peer" (omits empty segments).
 */
export function canonicalize(addr: SessionAddress): string {
  const parts = [addr.provider, addr.scope];
  const ids = addr.identifiers;
  if (ids.workspace) parts.push(ids.workspace);
  if (ids.channel) parts.push(ids.channel);
  if (ids.thread) parts.push(ids.thread);
  if (ids.peer) parts.push(ids.peer);
  return parts.join(':');
}

// ─── Media ─────────────────────────────────────────

export interface Attachment {
  filename: string;
  mimeType: string;
  size: number;
  content?: Buffer;
  url?: string;
}

// ─── Messages ──────────────────────────────────────

export interface InboundMessage {
  id: string;
  session: SessionAddress;
  sender: string;
  content: string;
  attachments: Attachment[];
  timestamp: Date;
  replyTo?: string;
  raw?: unknown;
  isMention?: boolean;  // true when user explicitly @mentioned the bot
}

export interface OutboundMessage {
  content: string;
  attachments?: Attachment[];
  replyTo?: string;
}

// ─── Access Control ────────────────────────────────

export type DMPolicy = 'open' | 'allowlist' | 'disabled';

export interface ChannelAccessConfig {
  dmPolicy: DMPolicy;
  allowedUsers?: string[];
  requireMention: boolean;
  mentionPatterns?: string[];
  maxAttachmentBytes: number;
  allowedMimeTypes?: string[];
}

// ─── Provider Interface ────────────────────────────

export interface ChannelProvider {
  name: string;
  connect(): Promise<void>;
  onMessage(handler: (msg: InboundMessage) => Promise<void>): void;
  shouldRespond(msg: InboundMessage): boolean;
  send(session: SessionAddress, content: OutboundMessage): Promise<void>;
  disconnect(): Promise<void>;
  addReaction?(session: SessionAddress, messageId: string, emoji: string): Promise<void>;
  removeReaction?(session: SessionAddress, messageId: string, emoji: string): Promise<void>;
  fetchThreadHistory?(channel: string, threadTs: string, limit?: number): Promise<{sender: string; content: string; ts: string}[]>;
}
