// src/providers/memory/cortex/provider.ts — Cortex provider wiring
import { join } from 'node:path';
import type { Config } from '../../../types.js';
import type {
  MemoryProvider, MemoryEntry, MemoryQuery, ConversationTurn,
} from '../types.js';
import type { LLMProvider } from '../../llm/types.js';
import type { DatabaseProvider } from '../../database/types.js';
import type { EventBusProvider } from '../../eventbus/types.js';
import type { ProactiveHint } from '../types.js';
import { dataFile } from '../../../paths.js';
import { createKyselyDb } from '../../../utils/database.js';
import { runMigrations } from '../../../utils/migrator.js';
import { memoryMigrations } from './migrations.js';
import { ItemsStore } from './items-store.js';
import { EmbeddingStore } from './embedding-store.js';
import { FileSummaryStore, DbSummaryStore, SUMMARY_ID_PREFIX, type SummaryStore } from './summary-store.js';
import { extractByLLM } from './extractor.js';
import { computeContentHash } from './content-hash.js';
import { salienceScore } from './salience.js';
import { buildSummaryPrompt, stripCodeFences } from './prompts.js';
import { llmComplete } from './llm-helpers.js';
import { createEmbeddingClient, type EmbeddingClient } from '../../../utils/embedding-client.js';
import { getLogger } from '../../../logger.js';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { sql } from 'kysely';

const logger = getLogger().child({ component: 'cortex' });

const SEMANTIC_DEDUP_THRESHOLD = 0.8;
// PostgreSQL advisory lock key for backfill coordination across processes
const BACKFILL_ADVISORY_LOCK_KEY = 0x41585F4246; // "AX_BF" as int

export interface CreateOptions {
  llm?: LLMProvider;
  database?: DatabaseProvider;
  eventbus?: EventBusProvider;
}

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
  database?: DatabaseProvider,
  batchSize = 50,
): Promise<void> {
  if (!client.available) return;

  // In PostgreSQL mode, use an advisory lock so only one process runs the
  // backfill at a time (host and agent-runtime share the same DB).
  if (database && database.type === 'postgresql') {
    const lockResult = await sql<{ acquired: boolean }>`
      SELECT pg_try_advisory_lock(${BACKFILL_ADVISORY_LOCK_KEY}) as acquired
    `.execute(database.db);
    if (!lockResult.rows[0]?.acquired) {
      logger.info('backfill_skipped', { reason: 'another process holds the advisory lock' });
      return;
    }
  }

  try {
    const scopes = await store.listAllScopes();
    if (scopes.length === 0) return;

    for (const scope of scopes) {
      const allIds = await store.listIdsByScope(scope);
      const unembedded = await embeddingStore.listUnembedded(allIds);

      if (unembedded.length === 0) continue;
      logger.info('backfill_start', { count: unembedded.length, scope });

      // Process in batches
      for (let i = 0; i < unembedded.length; i += batchSize) {
        const batchIds = unembedded.slice(i, i + batchSize);
        const items = await store.getByIds(batchIds);
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
  } finally {
    // Release the advisory lock if we acquired one
    if (database && database.type === 'postgresql') {
      await sql`SELECT pg_advisory_unlock(${BACKFILL_ADVISORY_LOCK_KEY})`.execute(database.db).catch(() => {});
    }
  }
}

/**
 * Update a category summary file using LLM-generated content.
 * Reads existing summary, merges new items via LLM prompt, writes result.
 */
async function updateCategorySummary(
  llm: LLMProvider,
  summaryStore: SummaryStore,
  category: string,
  newItems: string[],
  userId?: string,
): Promise<void> {
  const existing = await summaryStore.read(category, userId) || `# ${category}\n`;
  const prompt = buildSummaryPrompt({
    category,
    originalContent: existing,
    newItems,
    targetLength: 400,
  });
  const raw = await llmComplete(llm, prompt);
  const updated = stripCodeFences(raw);
  await summaryStore.write(category, updated, userId);
}

export async function create(config: Config, _name?: string, opts?: CreateOptions): Promise<MemoryProvider> {
  const llm = opts?.llm;
  const database = opts?.database;
  const eventbus = opts?.eventbus;
  const memoryDir = dataFile('memory');
  const vecDbPath = join(memoryDir, '_vec.db');

  // Use shared database if available, otherwise create a standalone Kysely instance
  let itemsDb;
  if (database) {
    itemsDb = database.db;
  } else {
    const dbPath = join(memoryDir, '_store.db');
    mkdirSync(memoryDir, { recursive: true });
    itemsDb = createKyselyDb({ type: 'sqlite', path: dbPath });
  }

  // Run migrations BEFORE initializing summary store — DbSummaryStore needs cortex_summaries table
  const migResult = await runMigrations(itemsDb, memoryMigrations(database?.type ?? 'sqlite'), 'cortex_migration');
  if (migResult.error) throw migResult.error;

  const summaryStore: SummaryStore = database && database.type !== 'sqlite'
    ? new DbSummaryStore(database.db)
    : new FileSummaryStore(memoryDir);
  await summaryStore.initDefaults();

  const store = new ItemsStore(itemsDb);

  // Initialize embedding infrastructure (safe defaults for tests/minimal configs)
  const embeddingModel = config.history?.embedding_model ?? 'text-embedding-3-small';
  const embeddingDimensions = config.history?.embedding_dimensions ?? 1536;
  const embeddingClient = createEmbeddingClient({
    model: embeddingModel,
    dimensions: embeddingDimensions,
  });

  // EmbeddingStore needs a DatabaseProvider with vector extension support
  let embeddingDb: DatabaseProvider;
  if (database) {
    embeddingDb = database;
  } else {
    // Create a standalone SQLite connection with sqlite-vec for the embedding store
    mkdirSync(memoryDir, { recursive: true });
    const req = createRequire(import.meta.url);
    const Database = req('better-sqlite3');
    const rawDb = new Database(vecDbPath);
    rawDb.pragma('journal_mode = WAL');
    let vectorsAvailable = false;
    try {
      const sqliteVec = req('sqlite-vec');
      sqliteVec.load(rawDb);
      vectorsAvailable = true;
    } catch {
      // sqlite-vec not available — vector search will be disabled
    }
    const { Kysely: KyselyClass, SqliteDialect: SqliteDialectClass } = await import('kysely');
    const standaloneDb = new KyselyClass({ dialect: new SqliteDialectClass({ database: rawDb }) });
    embeddingDb = {
      db: standaloneDb,
      type: 'sqlite',
      vectorsAvailable,
      async close() { await standaloneDb.destroy(); },
    };
  }

  const embeddingStore = new EmbeddingStore(embeddingDb, embeddingDimensions);
  await embeddingStore.ready();

  // Kick off background backfill (non-blocking)
  backfillEmbeddings(store, embeddingStore, embeddingClient, database).catch(err => {
    logger.warn('backfill_error', { error: (err as Error).message });
  });

  /** Convert internal CortexItem to public MemoryEntry. */
  function toEntry(item: import('./types.js').CortexItem): MemoryEntry {
    return {
      id: item.id,
      scope: item.scope,
      content: item.content,
      taint: item.taint ? JSON.parse(item.taint) : undefined,
      createdAt: new Date(item.createdAt),
      agentId: item.agentId,
      userId: item.userId,
    };
  }

  return {
    async write(entry: MemoryEntry): Promise<string> {
      const now = new Date().toISOString();
      const contentHash = computeContentHash(entry.content);
      const scope = entry.scope || 'default';

      // Fast path: hash-based dedup (exact match after normalization)
      const existing = await store.findByHash(contentHash, scope, entry.agentId, entry.userId);
      if (existing) {
        await store.reinforce(existing.id);
        return existing.id;
      }

      // Semantic dedup: catch paraphrases via embedding similarity
      let precomputedVector: Float32Array | undefined;
      if (embeddingClient.available) {
        try {
          const [vector] = await embeddingClient.embed([entry.content]);
          precomputedVector = vector;
          const similar = await embeddingStore.findSimilar(vector, 1, scope, entry.userId);
          if (similar.length > 0) {
            const similarity = 1 / (1 + similar[0].distance);
            if (similarity >= SEMANTIC_DEDUP_THRESHOLD) {
              await store.reinforce(similar[0].itemId);
              logger.info('semantic_dedup_hit', {
                existingId: similar[0].itemId,
                similarity,
                scope,
              });
              return similar[0].itemId;
            }
          }
        } catch (err) {
          logger.warn('semantic_dedup_failed', { error: (err as Error).message });
          // Fall through to insert — don't block writes on embedding failures
        }
      }

      const id = await store.insert({
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
        userId: entry.userId,
        taint: entry.taint ? JSON.stringify(entry.taint) : undefined,
      });

      // Store embedding — reuse precomputed vector if available
      try {
        if (precomputedVector) {
          await embeddingStore.upsert(id, scope, precomputedVector, entry.userId);
        } else {
          await embedItem(id, entry.content, scope, embeddingStore, embeddingClient);
        }
      } catch (err) {
        logger.warn('write_embedding_failed', { id, error: (err as Error).message });
      }

      // Update summary via LLM (fire-and-forget).
      // User-scoped writes go to data/memory/users/<userId>/, shared writes to data/memory/.
      if (llm) {
        updateCategorySummary(llm, summaryStore, 'knowledge', [entry.content], entry.userId).catch(err =>
          logger.warn('write_summary_update_failed', { error: (err as Error).message }),
        );
      }

      return id;
    },

    async query(q: MemoryQuery): Promise<MemoryEntry[]> {
      const scope = q.scope || 'default';
      const limit = q.limit ?? 50;

      // Path 1: Embedding-based semantic search
      if (q.embedding) {
        try {
          const similar = await embeddingStore.findSimilar(q.embedding, limit, scope, q.userId);
          if (similar.length === 0) {
            // No similar items found — return empty rather than falling through
            // to unfiltered keyword/listing search which would return irrelevant results
            return [];
          }

          const itemIds = similar.map(s => s.itemId);
          const items = await store.getByIds(itemIds);
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

          const results = ranked.slice(0, limit);
          // Reinforce accessed items (fire-and-forget)
          for (const { item } of results) {
            store.reinforce(item.id).catch(() => {});
          }
          return results.map(({ item }) => toEntry(item));
        } catch (err) {
          logger.warn('embedding_query_failed', { error: (err as Error).message });
          // Fall through to keyword search only on error (graceful degradation)
        }
      }

      // Path 2: Keyword / parallel search (when no pre-computed embedding provided)
      let scored: Array<{ item: Parameters<typeof toEntry>[0]; score: number }>;

      if (q.query) {
        // Run LIKE search and (optionally) embedding search in parallel
        const likePromise = store.searchContent(q.query, scope, limit, q.userId);

        const noEmbResults = {
          items: [] as Awaited<ReturnType<typeof store.getByIds>>,
          distances: new Map<string, number>(),
        };
        const embPromise = (embeddingClient.available && embeddingStore.available)
          ? embeddingClient.embed([q.query]).then(async ([vector]) => {
              const similar = await embeddingStore.findSimilar(vector, limit, scope, q.userId);
              if (similar.length === 0) return noEmbResults;
              const items = await store.getByIds(similar.map(s => s.itemId));
              return { items, distances: new Map(similar.map(s => [s.itemId, s.distance])) };
            }).catch((err: unknown) => {
              logger.warn('parallel_embedding_failed', { error: (err as Error).message });
              return noEmbResults;
            })
          : Promise.resolve(noEmbResults);

        const [likeItems, { items: embItems, distances }] = await Promise.all([likePromise, embPromise]);

        // Merge: embedding results first (have distance scores), then LIKE-only
        const seen = new Set<string>();
        scored = [];
        for (const item of embItems) {
          seen.add(item.id);
          const distance = distances.get(item.id) ?? 1;
          scored.push({
            item,
            score: salienceScore({
              similarity: 1 / (1 + distance),
              reinforcementCount: item.reinforcementCount,
              lastReinforcedAt: item.lastReinforcedAt,
              recencyDecayDays: 30,
            }),
          });
        }
        for (const item of likeItems) {
          if (seen.has(item.id)) continue;
          scored.push({
            item,
            score: salienceScore({
              similarity: 1.0,
              reinforcementCount: item.reinforcementCount,
              lastReinforcedAt: item.lastReinforcedAt,
              recencyDecayDays: 30,
            }),
          });
        }

        if (q.agentId) {
          scored = scored.filter(s => s.item.agentId === q.agentId);
        }

        logger.debug('query_parallel_search', {
          likeCount: likeItems.length,
          embeddingCount: embItems.length,
          mergedCount: scored.length,
        });
      } else {
        // No query string — list by scope
        const items = await store.listByScope(scope, limit, q.agentId, q.userId);
        scored = items.map(item => ({
          item,
          score: salienceScore({
            similarity: 1.0,
            reinforcementCount: item.reinforcementCount,
            lastReinforcedAt: item.lastReinforcedAt,
            recencyDecayDays: 30,
          }),
        }));
      }

      scored.sort((a, b) => b.score - a.score);

      // ── Build item results ──
      const sliced = scored.slice(0, limit);
      // Reinforce accessed items (fire-and-forget)
      for (const { item } of sliced) {
        store.reinforce(item.id).catch(() => {});
      }
      const itemResults = sliced.map(({ item }) => toEntry(item));

      // ── Append summaries to fill remaining limit slots ──
      const remaining = limit - itemResults.length;
      if (remaining <= 0) return itemResults;

      const summaryEntries: MemoryEntry[] = [];
      const seen = new Set<string>();

      // Collect matching summaries: user-scoped first (if userId), then shared
      const scopes: Array<string | undefined> = q.userId ? [q.userId, undefined] : [undefined];

      for (const scopeUserId of scopes) {
        if (summaryEntries.length >= remaining) break;
        const allSummaries = await summaryStore.readAll(scopeUserId);

        for (const [cat, content] of allSummaries) {
          if (summaryEntries.length >= remaining) break;
          const key = `${cat}:${scopeUserId ?? ''}`;
          if (seen.has(key)) continue;
          seen.add(key);

          if (content.trim() === `# ${cat}`) continue; // skip empty defaults

          // For keyword queries, only include summaries where at least one term matches
          if (q.query) {
            const lc = content.toLowerCase();
            const queryTerms = q.query.includes(' OR ')
              ? q.query.split(' OR ').map(t => t.trim().toLowerCase()).filter(Boolean)
              : q.query.split(/\s+/).map(t => t.toLowerCase()).filter(Boolean);
            if (!queryTerms.some(term => lc.includes(term))) continue;
          }

          summaryEntries.push({
            id: `${SUMMARY_ID_PREFIX}${cat}`,
            scope: q.scope || 'default',
            content,
            createdAt: new Date(),
            userId: scopeUserId,
          });
        }
      }

      return [...itemResults, ...summaryEntries];
    },

    async read(id: string): Promise<MemoryEntry | null> {
      if (id.startsWith(SUMMARY_ID_PREFIX)) return null;
      const item = await store.getById(id);
      if (!item) return null;
      // Reinforce accessed items (boosts salience for frequently read items)
      store.reinforce(item.id).catch(() => {});
      return toEntry(item);
    },

    async delete(id: string): Promise<void> {
      if (id.startsWith(SUMMARY_ID_PREFIX)) return;
      await store.deleteById(id);
      await embeddingStore.delete(id).catch(() => {});
    },

    async list(scope: string, limit?: number, userId?: string): Promise<MemoryEntry[]> {
      const items = await store.listByScope(scope, limit ?? 50, undefined, userId);
      return items.map(item => toEntry(item));
    },

    async memorize(conversation: ConversationTurn[], userId?: string): Promise<void> {
      if (conversation.length === 0) return;
      if (!llm) {
        throw new Error('memorize requires an LLM provider');
      }
      const scope = 'default';

      // Step 1: Extract items via LLM (errors propagate)
      const candidates = await extractByLLM(conversation, scope, llm);

      // Step 2: Dedup/reinforce or insert, collecting new items for embedding
      const newItemsByCategory = new Map<string, string[]>();
      const newItems: Array<{ id: string; content: string; scope: string }> = [];

      for (const candidate of candidates) {
        const existing = await store.findByHash(candidate.contentHash, scope, undefined, userId);
        if (existing) {
          await store.reinforce(existing.id);
        } else {
          const id = await store.insert({ ...candidate, userId });
          newItems.push({ id, content: candidate.content, scope });
          const items = newItemsByCategory.get(candidate.category) || [];
          items.push(candidate.content);
          newItemsByCategory.set(candidate.category, items);
        }
      }

      // Step 2b: Emit proactive hints for actionable items
      if (eventbus) {
        for (const candidate of candidates) {
          if ('actionable' in candidate && candidate.actionable) {
            eventbus.emit({
              type: 'memory.proactive_hint',
              requestId: config.agent_name ?? 'system',
              timestamp: Date.now(),
              data: {
                source: 'memory',
                kind: (('hintKind' in candidate ? candidate.hintKind : undefined) ?? 'pending_task') as ProactiveHint['kind'],
                reason: candidate.content,
                suggestedPrompt: candidate.content,
                confidence: candidate.confidence,
                scope,
              } satisfies ProactiveHint as Record<string, unknown>,
            });
          }
        }
      }

      // Step 3: Update category summaries via LLM.
      // User-scoped items go to data/memory/users/<userId>/, shared to data/memory/.
      for (const [category, newContents] of newItemsByCategory) {
        await updateCategorySummary(llm, summaryStore, category, newContents, userId);
      }

      // Step 4: Generate and store embeddings for new items
      if (newItems.length > 0 && embeddingClient.available) {
        try {
          const vectors = await embeddingClient.embed(newItems.map(i => i.content));
          await Promise.all(
            newItems.map((item, i) =>
              embeddingStore.upsert(item.id, item.scope, vectors[i], userId)),
          );
        } catch (err) {
          logger.warn('memorize_embedding_failed', { error: (err as Error).message });
        }
      }
    },
  };
}
