// src/providers/memory/memoryfs/provider.ts — MemoryFS provider wiring
import { join } from 'node:path';
import type { Config } from '../../../types.js';
import type {
  MemoryProvider, MemoryEntry, MemoryQuery, ConversationTurn,
} from '../types.js';
import { dataFile } from '../../../paths.js';
import { ItemsStore } from './items-store.js';
import { EmbeddingStore } from './embedding-store.js';
import { writeSummary, readSummary, initDefaultCategories } from './summary-io.js';
import { extractByRegex } from './extractor.js';
import { computeContentHash } from './content-hash.js';
import { salienceScore } from './salience.js';
import { createEmbeddingClient, type EmbeddingClient } from '../../../utils/embedding-client.js';
import { getLogger } from '../../../logger.js';

const logger = getLogger().child({ component: 'memoryfs' });

/**
 * Generate and store an embedding for an item (fire-and-forget safe).
 * Does nothing if the embedding client is unavailable.
 */
async function embedItem(
  itemId: string,
  content: string,
  scope: string,
  embeddingStore: EmbeddingStore,
  embeddingClient: EmbeddingClient,
): Promise<void> {
  if (!embeddingClient.available) return;
  try {
    const [vector] = await embeddingClient.embed([content]);
    await embeddingStore.upsert(itemId, scope, vector);
  } catch (err) {
    logger.warn('embed_item_failed', { itemId, error: (err as Error).message });
  }
}

/**
 * Backfill embeddings for items that don't have them yet.
 * Iterates all scopes so no items are missed.
 * Runs in the background — non-blocking, non-critical.
 */
async function backfillEmbeddings(
  store: ItemsStore,
  embeddingStore: EmbeddingStore,
  client: EmbeddingClient,
  batchSize = 50,
): Promise<void> {
  if (!client.available) return;

  try {
    const scopes = store.listAllScopes();
    if (scopes.length === 0) return;

    for (const scope of scopes) {
      const allIds = store.listIdsByScope(scope);
      const unembedded = await embeddingStore.listUnembedded(allIds);

      if (unembedded.length === 0) continue;
      logger.info('backfill_start', { count: unembedded.length, scope });

      // Process in batches
      for (let i = 0; i < unembedded.length; i += batchSize) {
        const batchIds = unembedded.slice(i, i + batchSize);
        const items = store.getByIds(batchIds);
        if (items.length === 0) continue;

        const vectors = await client.embed(items.map(it => it.content));
        for (let j = 0; j < items.length; j++) {
          await embeddingStore.upsert(items[j].id, items[j].scope, vectors[j]);
        }
        logger.debug('backfill_batch', { scope, done: Math.min(i + batchSize, unembedded.length), total: unembedded.length });
      }

      logger.info('backfill_done', { count: unembedded.length, scope });
    }
  } catch (err) {
    logger.warn('backfill_failed', { error: (err as Error).message });
  }
}

export async function create(config: Config): Promise<MemoryProvider> {
  const memoryDir = dataFile('memory');
  const dbPath = join(memoryDir, '_store.db');
  const vecDbPath = join(memoryDir, '_vec.db');

  await initDefaultCategories(memoryDir);
  const store = new ItemsStore(dbPath);

  // Initialize embedding infrastructure (safe defaults for tests/minimal configs)
  const embeddingModel = config.history?.embedding_model ?? 'text-embedding-3-small';
  const embeddingDimensions = config.history?.embedding_dimensions ?? 1536;
  const embeddingClient = createEmbeddingClient({
    model: embeddingModel,
    dimensions: embeddingDimensions,
  });
  const embeddingStore = new EmbeddingStore(vecDbPath, embeddingDimensions);
  await embeddingStore.ready();

  // Kick off background backfill (non-blocking)
  backfillEmbeddings(store, embeddingStore, embeddingClient).catch(err => {
    logger.warn('backfill_error', { error: (err as Error).message });
  });

  return {
    async write(entry: MemoryEntry): Promise<string> {
      const now = new Date().toISOString();
      const contentHash = computeContentHash(entry.content, 'knowledge');
      const scope = entry.scope || 'default';

      // Dedup: reinforce if same content exists
      const existing = store.findByHash(contentHash, scope, entry.agentId);
      if (existing) {
        store.reinforce(existing.id);
        return existing.id;
      }

      const id = store.insert({
        content: entry.content,
        memoryType: 'knowledge',
        category: 'knowledge',
        contentHash,
        confidence: 1.0,
        reinforcementCount: 1,
        lastReinforcedAt: now,
        createdAt: now,
        updatedAt: now,
        scope,
        agentId: entry.agentId,
        taint: entry.taint ? JSON.stringify(entry.taint) : undefined,
      });

      // Generate embedding (non-blocking — don't delay the write response)
      embedItem(id, entry.content, scope, embeddingStore, embeddingClient).catch(() => {});

      return id;
    },

    async query(q: MemoryQuery): Promise<MemoryEntry[]> {
      const scope = q.scope || 'default';
      const limit = q.limit ?? 50;

      // Path 1: Embedding-based semantic search
      if (q.embedding) {
        try {
          const similar = await embeddingStore.findSimilar(q.embedding, limit, scope);
          if (similar.length === 0) {
            // No similar items found — return empty rather than falling through
            // to unfiltered keyword/listing search which would return irrelevant results
            return [];
          }

          const itemIds = similar.map(s => s.itemId);
          const items = store.getByIds(itemIds);
          const distanceMap = new Map(similar.map(s => [s.itemId, s.distance]));

          // Rank by salience × similarity
          const ranked = items.map(item => {
            const distance = distanceMap.get(item.id) ?? 1;
            const similarity = 1 / (1 + distance);
            return {
              item,
              score: salienceScore({
                similarity,
                reinforcementCount: item.reinforcementCount,
                lastReinforcedAt: item.lastReinforcedAt,
                recencyDecayDays: 30,
              }),
            };
          });
          ranked.sort((a, b) => b.score - a.score);

          return ranked.slice(0, limit).map(({ item }) => ({
            id: item.id,
            scope: item.scope,
            content: item.content,
            taint: item.taint ? JSON.parse(item.taint) : undefined,
            createdAt: new Date(item.createdAt),
            agentId: item.agentId,
          }));
        } catch (err) {
          logger.warn('embedding_query_failed', { error: (err as Error).message });
          // Fall through to keyword search only on error (graceful degradation)
        }
      }

      // Path 2: Keyword search (fallback or when no embedding provided)
      let items = q.query
        ? store.searchContent(q.query, scope, limit)
        : store.listByScope(scope, limit, q.agentId);

      if (q.agentId && q.query) {
        items = items.filter(i => i.agentId === q.agentId);
      }

      // Rank by salience
      const ranked = items.map(item => ({
        item,
        score: salienceScore({
          similarity: 1.0,
          reinforcementCount: item.reinforcementCount,
          lastReinforcedAt: item.lastReinforcedAt,
          recencyDecayDays: 30,
        }),
      }));
      ranked.sort((a, b) => b.score - a.score);

      return ranked.slice(0, limit).map(({ item }) => ({
        id: item.id,
        scope: item.scope,
        content: item.content,
        taint: item.taint ? JSON.parse(item.taint) : undefined,
        createdAt: new Date(item.createdAt),
        agentId: item.agentId,
      }));
    },

    async read(id: string): Promise<MemoryEntry | null> {
      const item = store.getById(id);
      if (!item) return null;
      return {
        id: item.id,
        scope: item.scope,
        content: item.content,
        taint: item.taint ? JSON.parse(item.taint) : undefined,
        createdAt: new Date(item.createdAt),
        agentId: item.agentId,
      };
    },

    async delete(id: string): Promise<void> {
      store.deleteById(id);
      await embeddingStore.delete(id).catch(() => {});
    },

    async list(scope: string, limit?: number): Promise<MemoryEntry[]> {
      const items = store.listByScope(scope, limit ?? 50);
      return items.map(item => ({
        id: item.id,
        scope: item.scope,
        content: item.content,
        taint: item.taint ? JSON.parse(item.taint) : undefined,
        createdAt: new Date(item.createdAt),
        agentId: item.agentId,
      }));
    },

    async memorize(conversation: ConversationTurn[]): Promise<void> {
      if (conversation.length === 0) return;
      const scope = 'default';

      // Step 1: Extract items via regex
      const candidates = extractByRegex(conversation, scope);

      // Step 2: Dedup/reinforce or insert, collecting new items for embedding
      const newItemsByCategory = new Map<string, string[]>();
      const newItems: Array<{ id: string; content: string; scope: string }> = [];

      for (const candidate of candidates) {
        const existing = store.findByHash(candidate.contentHash, scope);
        if (existing) {
          store.reinforce(existing.id);
        } else {
          const id = store.insert(candidate);
          newItems.push({ id, content: candidate.content, scope });
          const items = newItemsByCategory.get(candidate.category) || [];
          items.push(candidate.content);
          newItemsByCategory.set(candidate.category, items);
        }
      }

      // Step 3: Update category summaries (Phase 1: append bullets; later: LLM)
      for (const [category, newContents] of newItemsByCategory) {
        const existingSummary = await readSummary(memoryDir, category) || `# ${category}\n`;
        const newBullets = newContents.map(c => `- ${c}`).join('\n');
        const updated = `${existingSummary.trimEnd()}\n${newBullets}\n`;
        await writeSummary(memoryDir, category, updated);
      }

      // Step 4: Generate embeddings for new items (non-blocking batch)
      if (newItems.length > 0 && embeddingClient.available) {
        (async () => {
          try {
            const vectors = await embeddingClient.embed(newItems.map(i => i.content));
            for (let i = 0; i < newItems.length; i++) {
              await embeddingStore.upsert(newItems[i].id, newItems[i].scope, vectors[i]);
            }
          } catch (err) {
            logger.warn('memorize_embed_failed', { error: (err as Error).message });
          }
        })().catch(() => {});
      }
    },
  };
}
