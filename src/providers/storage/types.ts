// src/providers/storage/types.ts — StorageProvider interface
//
// Defines async interfaces for all storage sub-stores. Both the SQLite
// (local dev) and PostgreSQL (k8s) providers implement these interfaces.
//
// Phase 1: SQLite wraps existing sync classes with Promise.resolve().
// Phase 2: PostgreSQL uses native async pg queries.

import type { ContentBlock } from '../../types.js';
import type { SessionAddress } from '../channel/types.js';

// ═══════════════════════════════════════════════════════
// Message Queue
// ═══════════════════════════════════════════════════════

export interface QueuedMessage {
  id: string;
  session_id: string;
  channel: string;
  sender: string;
  content: string;
  status: 'pending' | 'processing' | 'done' | 'error';
  created_at: string;
  processed_at: string | null;
}

export interface MessageQueueStore {
  enqueue(msg: { sessionId: string; channel: string; sender: string; content: string }): Promise<string>;
  dequeue(): Promise<QueuedMessage | null>;
  dequeueById(id: string): Promise<QueuedMessage | null>;
  complete(id: string): Promise<void>;
  fail(id: string): Promise<void>;
  pending(): Promise<number>;
}

// ═══════════════════════════════════════════════════════
// Conversation Store
// ═══════════════════════════════════════════════════════

export interface StoredTurn {
  id: number;
  session_id: string;
  role: 'user' | 'assistant';
  sender: string | null;
  content: string;
  created_at: number;
  is_summary: number;
  summarized_up_to: number | null;
}

export interface ConversationStoreProvider {
  append(sessionId: string, role: 'user' | 'assistant', content: string | ContentBlock[], sender?: string): Promise<void>;
  load(sessionId: string, maxTurns?: number): Promise<StoredTurn[]>;
  prune(sessionId: string, keep: number): Promise<void>;
  count(sessionId: string): Promise<number>;
  clear(sessionId: string): Promise<void>;
  loadOlderTurns(sessionId: string, keepRecent: number): Promise<StoredTurn[]>;
  replaceTurnsWithSummary(sessionId: string, maxIdToReplace: number, summaryContent: string): Promise<void>;
}

// ═══════════════════════════════════════════════════════
// Session Store
// ═══════════════════════════════════════════════════════

export interface SessionStoreProvider {
  trackSession(agentId: string, session: SessionAddress): Promise<void>;
  getLastChannelSession(agentId: string): Promise<SessionAddress | undefined>;
}

// ═══════════════════════════════════════════════════════
// Document Store
// ═══════════════════════════════════════════════════════

/**
 * Key-value document storage for identity files, skills, config, etc.
 *
 * Documents are organized by collection (e.g. 'identity', 'skills', 'config')
 * and keyed by a unique string within each collection.
 */
export interface DocumentStore {
  /** Retrieve a document by collection and key. Returns undefined if not found. */
  get(collection: string, key: string): Promise<string | undefined>;

  /** Store or update a document. */
  put(collection: string, key: string, content: string): Promise<void>;

  /** Delete a document. Returns true if the document existed. */
  delete(collection: string, key: string): Promise<boolean>;

  /** List all keys in a collection. */
  list(collection: string): Promise<string[]>;
}

// ═══════════════════════════════════════════════════════
// Chat Session Store
// ═══════════════════════════════════════════════════════

export interface ChatSession {
  id: string;
  title: string | null;
  status: string;
  created_at: number;
  updated_at: number;
}

export interface ChatSessionStore {
  list(): Promise<ChatSession[]>;
  create(opts: { id?: string; title?: string }): Promise<ChatSession>;
  updateTitle(id: string, title: string): Promise<void>;
  ensureExists(id: string): Promise<void>;
}

// ═══════════════════════════════════════════════════════
// Storage Provider
// ═══════════════════════════════════════════════════════

/**
 * StorageProvider — unified access to all persistent storage.
 *
 * All sub-store methods are async (return Promises). The SQLite provider
 * wraps synchronous operations with Promise.resolve(); the PostgreSQL
 * provider uses native async pg queries.
 */
export interface StorageProvider {
  /** Message queue (enqueue/dequeue/complete/fail/pending). */
  readonly messages: MessageQueueStore;

  /** Conversation history store (append/load/prune/count/clear). */
  readonly conversations: ConversationStoreProvider;

  /** Session tracking store (trackSession/getLastChannelSession). */
  readonly sessions: SessionStoreProvider;

  /** Key-value document store (identity files, skills, config). */
  readonly documents: DocumentStore;

  /** Chat session metadata store (list/create/updateTitle). */
  readonly chatSessions: ChatSessionStore;

  /** Close all underlying database connections. */
  close(): void;
}
