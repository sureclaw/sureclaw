import { randomUUID } from 'node:crypto';
import type {
  MemoryProvider, MemoryEntry, MemoryQuery, ProactiveHint,
  ConversationTurn,
} from './types.js';
import type { Config } from '../../types.js';

/**
 * memU knowledge-graph memory provider.
 *
 * Uses conversation-level memorization to extract knowledge:
 * - memorize() processes full conversation transcript → extracts facts
 * - write() / delete() are no-ops (knowledge comes from memorize())
 * - query() / read() / list() read from the internal knowledge store
 * - onProactiveHint() emits hints for pending tasks, temporal patterns, etc.
 *
 * The knowledge store is backed by an in-memory Map. In production, this
 * would connect to a PostgreSQL-backed knowledge graph via localhost.
 */

const DEFAULT_SCOPE = 'memu';
const MAX_FACTS_PER_CONVERSATION = 20;

interface KnowledgeFact {
  entry: MemoryEntry;
  confidence: number;
  extractedFrom: string; // conversation snippet
}

/**
 * Extract key facts from conversation turns using heuristic patterns.
 *
 * Looks for: explicit memory requests, decisions, preferences, action items,
 * and factual statements the user makes about themselves or their work.
 */
function extractFacts(conversation: ConversationTurn[]): KnowledgeFact[] {
  const facts: KnowledgeFact[] = [];

  for (const turn of conversation) {
    if (turn.role !== 'user') continue;
    const text = turn.content;

    // Explicit memory requests: "remember that...", "note that...", "keep in mind..."
    const rememberMatch = text.match(
      /(?:remember|note|keep in mind|don't forget)\s+(?:that\s+)?(.{10,200})/i,
    );
    if (rememberMatch) {
      facts.push({
        entry: {
          scope: DEFAULT_SCOPE,
          content: rememberMatch[1].trim(),
          tags: ['explicit', 'user-requested'],
          createdAt: new Date(),
        },
        confidence: 0.95,
        extractedFrom: text.slice(0, 200),
      });
    }

    // Preferences: "I prefer...", "I like...", "I always..."
    const prefMatch = text.match(
      /(?:I\s+(?:prefer|like|always|usually|want|need))\s+(.{5,200})/i,
    );
    if (prefMatch && !rememberMatch) {
      facts.push({
        entry: {
          scope: DEFAULT_SCOPE,
          content: `User preference: ${prefMatch[0].trim()}`,
          tags: ['preference', 'implicit'],
          createdAt: new Date(),
        },
        confidence: 0.7,
        extractedFrom: text.slice(0, 200),
      });
    }

    // Action items: "TODO:", "I need to...", "I should..."
    const todoMatch = text.match(
      /(?:TODO:?\s+|I\s+(?:need|should|have)\s+to\s+)(.{5,200})/i,
    );
    if (todoMatch) {
      facts.push({
        entry: {
          scope: DEFAULT_SCOPE,
          content: `Action item: ${todoMatch[1].trim()}`,
          tags: ['action-item', 'task'],
          createdAt: new Date(),
        },
        confidence: 0.8,
        extractedFrom: text.slice(0, 200),
      });
    }
  }

  return facts.slice(0, MAX_FACTS_PER_CONVERSATION);
}

export async function create(_config: Config): Promise<MemoryProvider> {
  // Knowledge store: id → entry
  const store = new Map<string, MemoryEntry>();

  // Proactive hint handler
  let hintHandler: ((hint: ProactiveHint) => void) | null = null;

  // Track action items for proactive hints
  const pendingActions = new Map<string, MemoryEntry>();

  return {
    async write(_entry: MemoryEntry): Promise<string> {
      // No-op for memU — knowledge comes from memorize()
      // Return a valid ID so callers don't break
      return randomUUID();
    },

    async query(q: MemoryQuery): Promise<MemoryEntry[]> {
      const results: MemoryEntry[] = [];
      const queryLower = q.query?.toLowerCase();

      for (const entry of store.values()) {
        // Scope filter
        if (entry.scope !== q.scope && q.scope !== '*') continue;

        // Enterprise: agent filter
        if (q.agentId !== undefined && entry.agentId !== q.agentId) continue;

        // Text match
        if (queryLower && !entry.content.toLowerCase().includes(queryLower)) {
          continue;
        }

        // Tag filter
        if (q.tags && !q.tags.every(t => entry.tags?.includes(t))) {
          continue;
        }

        results.push(entry);
      }

      const limit = q.limit ?? 50;
      return results.slice(0, limit);
    },

    async read(id: string): Promise<MemoryEntry | null> {
      return store.get(id) ?? null;
    },

    async delete(_id: string): Promise<void> {
      // No-op — knowledge lifecycle managed by memorize()
    },

    async list(scope: string, limit?: number): Promise<MemoryEntry[]> {
      const results: MemoryEntry[] = [];
      for (const entry of store.values()) {
        if (entry.scope === scope || scope === '*') {
          results.push(entry);
        }
      }
      return results.slice(0, limit ?? 50);
    },

    async memorize(conversation: ConversationTurn[]): Promise<void> {
      if (conversation.length === 0) return;

      const facts = extractFacts(conversation);

      for (const fact of facts) {
        const id = randomUUID();
        const entry = { ...fact.entry, id };
        store.set(id, entry);

        // Track action items for proactive hints
        if (entry.tags?.includes('action-item')) {
          pendingActions.set(id, entry);

          // Emit proactive hint for action items
          if (hintHandler) {
            hintHandler({
              source: 'memory',
              kind: 'pending_task',
              reason: `Action item extracted from conversation: ${entry.content}`,
              suggestedPrompt: `Follow up on: ${entry.content}`,
              confidence: fact.confidence,
              scope: DEFAULT_SCOPE,
              memoryId: id,
              cooldownMinutes: 60,
            });
          }
        }
      }
    },

    onProactiveHint(handler: (hint: ProactiveHint) => void): void {
      hintHandler = handler;
    },
  };
}
