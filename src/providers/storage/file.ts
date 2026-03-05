// src/providers/storage/file.ts — Flat-file StorageProvider for local dev
//
// No database dependency. Each sub-store maps to filesystem operations:
//   - SessionStore → ~/.ax/data/sessions/<agentId>.json
//   - DocumentStore → ~/.ax/data/documents/<collection>/<key>
//   - ConversationStore → ~/.ax/data/conversations/<sessionId>.jsonl
//   - MessageQueue → ~/.ax/data/messages/{pending,processing}/<uuid>.json

import {
  readFileSync, writeFileSync, appendFileSync, unlinkSync, mkdirSync,
  readdirSync, renameSync, existsSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dataFile } from '../../paths.js';
import { serializeContent } from '../../conversation-store.js';
import { safePath } from '../../utils/safe-path.js';
import type { Config, ContentBlock } from '../../types.js';
import type { SessionAddress, SessionScope } from '../channel/types.js';
import type {
  StorageProvider,
  MessageQueueStore,
  ConversationStoreProvider,
  SessionStoreProvider,
  DocumentStore,
  QueuedMessage,
  StoredTurn,
} from './types.js';

/** Atomic write via rename — prevents partial reads on crash. */
function atomicWrite(filePath: string, data: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = join(tmpdir(), `.ax-write-${randomUUID()}`);
  writeFileSync(tmp, data);
  renameSync(tmp, filePath);
}

// ═══════════════════════════════════════════════════════
// Message Queue — directory-based, rename for atomicity
// ═══════════════════════════════════════════════════════

function createMessageQueue(): MessageQueueStore {
  const pendingDir = dataFile('messages', 'pending');
  const processingDir = dataFile('messages', 'processing');
  mkdirSync(pendingDir, { recursive: true });
  mkdirSync(processingDir, { recursive: true });

  return {
    async enqueue(msg) {
      const id = randomUUID();
      const entry: QueuedMessage = {
        id,
        session_id: msg.sessionId,
        channel: msg.channel,
        sender: msg.sender,
        content: msg.content,
        status: 'pending',
        created_at: new Date().toISOString(),
        processed_at: null,
      };
      atomicWrite(join(pendingDir, `${id}.json`), JSON.stringify(entry));
      return id;
    },

    async dequeue() {
      const files = readdirSync(pendingDir).filter(f => f.endsWith('.json')).sort();
      if (files.length === 0) return null;
      const file = files[0];
      const id = file.replace('.json', '');
      const src = join(pendingDir, file);
      const dst = join(processingDir, file);
      try {
        renameSync(src, dst);
      } catch {
        return null; // Another process grabbed it
      }
      const data = JSON.parse(readFileSync(dst, 'utf-8')) as QueuedMessage;
      data.status = 'processing';
      data.processed_at = new Date().toISOString();
      writeFileSync(dst, JSON.stringify(data));
      return data;
    },

    async dequeueById(id) {
      const src = join(pendingDir, `${id}.json`);
      const dst = join(processingDir, `${id}.json`);
      try {
        renameSync(src, dst);
      } catch {
        return null;
      }
      const data = JSON.parse(readFileSync(dst, 'utf-8')) as QueuedMessage;
      data.status = 'processing';
      data.processed_at = new Date().toISOString();
      writeFileSync(dst, JSON.stringify(data));
      return data;
    },

    async complete(id) {
      const path = join(processingDir, `${id}.json`);
      try { unlinkSync(path); } catch {}
    },

    async fail(id) {
      const path = join(processingDir, `${id}.json`);
      try { unlinkSync(path); } catch {}
    },

    async pending() {
      try {
        return readdirSync(pendingDir).filter(f => f.endsWith('.json')).length;
      } catch {
        return 0;
      }
    },
  };
}

// ═══════════════════════════════════════════════════════
// Conversation Store — JSONL append
// ═══════════════════════════════════════════════════════

function createConversationStore(): ConversationStoreProvider {
  const convDir = dataFile('conversations');
  mkdirSync(convDir, { recursive: true });

  // Auto-increment ID counter per session (in-memory, reset on restart)
  const idCounters = new Map<string, number>();

  function sessionFile(sessionId: string): string {
    // Encode sessionId for filesystem safety (colons -> underscores)
    const safe = sessionId.replace(/:/g, '_');
    return safePath(convDir, `${safe}.jsonl`);
  }

  function nextId(sessionId: string): number {
    const current = idCounters.get(sessionId) ?? 0;
    const next = current + 1;
    idCounters.set(sessionId, next);
    return next;
  }

  function loadTurns(sessionId: string): StoredTurn[] {
    const path = sessionFile(sessionId);
    try {
      const raw = readFileSync(path, 'utf-8').trim();
      if (!raw) return [];
      const turns = raw.split('\n').filter(Boolean).map(line => JSON.parse(line) as StoredTurn);
      // Sync ID counter
      if (turns.length > 0) {
        const maxId = Math.max(...turns.map(t => t.id));
        idCounters.set(sessionId, maxId);
      }
      return turns;
    } catch {
      return [];
    }
  }

  function writeTurns(sessionId: string, turns: StoredTurn[]): void {
    const path = sessionFile(sessionId);
    const data = turns.map(t => JSON.stringify(t)).join('\n') + (turns.length > 0 ? '\n' : '');
    atomicWrite(path, data);
    if (turns.length > 0) {
      idCounters.set(sessionId, Math.max(...turns.map(t => t.id)));
    }
  }

  return {
    async append(sessionId, role, content, sender?) {
      const serialized = serializeContent(content);
      const turn: StoredTurn = {
        id: nextId(sessionId),
        session_id: sessionId,
        role,
        sender: sender ?? null,
        content: serialized,
        created_at: Math.floor(Date.now() / 1000),
        is_summary: 0,
        summarized_up_to: null,
      };
      // Need to load first to sync ID counter on cold start
      const existing = loadTurns(sessionId);
      if (existing.length > 0 && turn.id <= existing[existing.length - 1].id) {
        turn.id = existing[existing.length - 1].id + 1;
        idCounters.set(sessionId, turn.id);
      }
      const path = sessionFile(sessionId);
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, JSON.stringify(turn) + '\n');
    },

    async load(sessionId, maxTurns?) {
      const turns = loadTurns(sessionId);
      if (maxTurns !== undefined) {
        if (maxTurns <= 0) return [];
        return turns.slice(-maxTurns);
      }
      return turns;
    },

    async prune(sessionId, keep) {
      const turns = loadTurns(sessionId);
      writeTurns(sessionId, turns.slice(-keep));
    },

    async count(sessionId) {
      return loadTurns(sessionId).length;
    },

    async clear(sessionId) {
      writeTurns(sessionId, []);
    },

    async loadOlderTurns(sessionId, keepRecent) {
      const turns = loadTurns(sessionId);
      return turns.slice(0, turns.length - keepRecent);
    },

    async replaceTurnsWithSummary(sessionId, maxIdToReplace, summaryContent) {
      const turns = loadTurns(sessionId);
      const remaining = turns.filter(t => t.id > maxIdToReplace);

      const summaryUser: StoredTurn = {
        id: nextId(sessionId),
        session_id: sessionId,
        role: 'user',
        sender: null,
        content: summaryContent,
        created_at: Math.floor(Date.now() / 1000),
        is_summary: 1,
        summarized_up_to: maxIdToReplace,
      };

      const summaryAssistant: StoredTurn = {
        id: nextId(sessionId),
        session_id: sessionId,
        role: 'assistant',
        sender: null,
        content: 'Understood. I have the conversation context from the summary above.',
        created_at: Math.floor(Date.now() / 1000),
        is_summary: 1,
        summarized_up_to: maxIdToReplace,
      };

      // Re-assign IDs to remaining turns to maintain ordering
      const result = [summaryUser, summaryAssistant];
      for (const t of remaining) {
        result.push({ ...t, id: nextId(sessionId) });
      }

      writeTurns(sessionId, result);
    },
  };
}

// ═══════════════════════════════════════════════════════
// Session Store — one JSON file per agent
// ═══════════════════════════════════════════════════════

function createSessionStore(): SessionStoreProvider {
  const sessDir = dataFile('sessions');
  mkdirSync(sessDir, { recursive: true });

  return {
    async trackSession(agentId, session) {
      const path = safePath(sessDir, `${agentId}.json`);
      atomicWrite(path, JSON.stringify({
        provider: session.provider,
        scope: session.scope,
        identifiers: session.identifiers,
        updated_at: Date.now(),
      }));
    },

    async getLastChannelSession(agentId) {
      const path = safePath(sessDir, `${agentId}.json`);
      try {
        const data = JSON.parse(readFileSync(path, 'utf-8'));
        return {
          provider: data.provider as string,
          scope: data.scope as SessionScope,
          identifiers: data.identifiers,
        };
      } catch {
        return undefined;
      }
    },
  };
}

// ═══════════════════════════════════════════════════════
// Document Store — nested directories by collection
// ═══════════════════════════════════════════════════════

function createDocumentStore(): DocumentStore {
  const docsDir = dataFile('documents');
  mkdirSync(docsDir, { recursive: true });

  return {
    async get(collection, key) {
      const path = safePath(docsDir, collection, key);
      try {
        return readFileSync(path, 'utf-8');
      } catch {
        return undefined;
      }
    },

    async put(collection, key, content) {
      const path = safePath(docsDir, collection, key);
      atomicWrite(path, content);
    },

    async delete(collection, key) {
      const path = safePath(docsDir, collection, key);
      try {
        unlinkSync(path);
        return true;
      } catch {
        return false;
      }
    },

    async list(collection) {
      const dir = safePath(docsDir, collection);
      try {
        return readdirSync(dir).sort();
      } catch {
        return [];
      }
    },
  };
}

export async function create(
  _config: Config,
  _name?: string,
  _opts?: Record<string, unknown>,
): Promise<StorageProvider> {
  return {
    get messages() { return createMessageQueue(); },
    get conversations() { return createConversationStore(); },
    get sessions() { return createSessionStore(); },
    get documents() { return createDocumentStore(); },
    close(): void { /* no-op: file-based, no connections to close */ },
  };
}
