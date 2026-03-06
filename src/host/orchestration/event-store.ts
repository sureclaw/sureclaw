/**
 * Persistent Event Store — database-backed storage for orchestration events.
 *
 * Subscribes to EventBus and auto-captures all agent.* events for
 * debugging, replay, and post-mortem analysis. Exposes query methods
 * for timeline views filtered by handle, session, time range, etc.
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import type { Kysely } from 'kysely';
import { createKyselyDb } from '../../utils/database.js';
import { runMigrations } from '../../utils/migrator.js';
import { buildOrchestrationMigrations } from '../../migrations/orchestration.js';
import { dataFile, dataDir } from '../../paths.js';
import { getLogger } from '../../logger.js';
import type { EventBus, StreamEvent } from '../event-bus.js';
import type { DatabaseProvider } from '../../providers/database/types.js';
import type {
  OrchestrationEvent,
  OrchestrationEventStore,
  EventFilter,
} from './types.js';

const logger = getLogger().child({ component: 'orchestration-event-store' });

function streamEventToOrchEvent(event: StreamEvent): OrchestrationEvent | null {
  const data = event.data;
  const handleId = (data.handleId as string) ?? '';
  const agentId = (data.agentId as string) ?? '';
  const userId = (data.userId as string) ?? '';
  const parentId = (data.parentId as string | undefined) ?? null;

  if (!handleId) return null;

  return {
    id: randomUUID(),
    eventType: event.type,
    handleId,
    agentId,
    sessionId: event.requestId,
    userId,
    parentId,
    payload: data,
    createdAt: event.timestamp,
  };
}

export async function createOrchestrationEventStore(
  database?: DatabaseProvider,
): Promise<OrchestrationEventStore> {
  const dbType = database?.type ?? 'sqlite';
  const db = database
    ? database.db
    : (mkdirSync(dataDir(), { recursive: true }),
      createKyselyDb({ type: 'sqlite', path: dataFile('orchestration.db') }));

  const migResult = await runMigrations(db, buildOrchestrationMigrations(dbType), 'orchestration_migration');
  if (migResult.error) throw migResult.error;

  async function append(event: OrchestrationEvent): Promise<void> {
    await db.insertInto('orchestration_events')
      .values({
        id: event.id,
        event_type: event.eventType,
        handle_id: event.handleId,
        agent_id: event.agentId,
        session_id: event.sessionId,
        user_id: event.userId,
        parent_id: event.parentId,
        payload_json: JSON.stringify(event.payload),
        created_at: event.createdAt,
      })
      .execute();
  }

  async function query(filter?: EventFilter): Promise<OrchestrationEvent[]> {
    let q = db.selectFrom('orchestration_events')
      .select(['id', 'event_type', 'handle_id', 'agent_id', 'session_id', 'user_id', 'parent_id', 'payload_json', 'created_at']);

    if (filter?.eventType) q = q.where('event_type', '=', filter.eventType);
    if (filter?.handleId) q = q.where('handle_id', '=', filter.handleId);
    if (filter?.agentId) q = q.where('agent_id', '=', filter.agentId);
    if (filter?.sessionId) q = q.where('session_id', '=', filter.sessionId);
    if (filter?.userId) q = q.where('user_id', '=', filter.userId);
    if (filter?.since) q = q.where('created_at', '>=', filter.since);
    if (filter?.until) q = q.where('created_at', '<=', filter.until);

    q = q.orderBy('created_at', 'asc');
    if (filter?.limit) q = q.limit(filter.limit);

    const rows = await q.execute();
    return rows.map(r => ({
      id: r.id as string,
      eventType: r.event_type as string,
      handleId: r.handle_id as string,
      agentId: r.agent_id as string,
      sessionId: r.session_id as string,
      userId: r.user_id as string,
      parentId: r.parent_id as string | null,
      payload: JSON.parse(r.payload_json as string),
      createdAt: r.created_at as number,
    }));
  }

  async function byAgent(handleId: string, limit?: number): Promise<OrchestrationEvent[]> {
    return query({ handleId, limit });
  }

  async function bySession(sessionId: string, limit?: number): Promise<OrchestrationEvent[]> {
    return query({ sessionId, limit });
  }

  function startCapture(eventBus: EventBus): () => void {
    return eventBus.subscribe((event: StreamEvent) => {
      if (!event.type.startsWith('agent.')) return;

      const orchEvent = streamEventToOrchEvent(event);
      if (!orchEvent) {
        logger.debug('skipping_event_no_handle', { type: event.type });
        return;
      }

      append(orchEvent).catch(err => {
        logger.error('event_store_append_failed', { type: event.type, err });
      });
    });
  }

  async function close(): Promise<void> {
    // No-op when using shared database — the DatabaseProvider owns the connection.
    // When standalone, the Kysely instance will be destroyed by the caller.
  }

  return { append, query, byAgent, bySession, startCapture, close };
}
