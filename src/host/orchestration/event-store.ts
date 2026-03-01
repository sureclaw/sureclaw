/**
 * Persistent Event Store — SQLite-backed storage for orchestration events.
 *
 * Subscribes to EventBus and auto-captures all agent.* events for
 * debugging, replay, and post-mortem analysis. Exposes query methods
 * for timeline views filtered by handle, session, time range, etc.
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { openDatabase } from '../../utils/sqlite.js';
import type { SQLiteDatabase } from '../../utils/sqlite.js';
import { createKyselyDb } from '../../utils/database.js';
import { runMigrations } from '../../utils/migrator.js';
import { orchestrationMigrations } from '../../migrations/orchestration.js';
import { dataFile } from '../../paths.js';
import { getLogger } from '../../logger.js';
import type { EventBus, StreamEvent } from '../event-bus.js';
import type {
  OrchestrationEvent,
  OrchestrationEventStore,
  EventFilter,
} from './types.js';

const logger = getLogger().child({ component: 'orchestration-event-store' });

interface EventRow {
  id: string;
  event_type: string;
  handle_id: string;
  agent_id: string;
  session_id: string;
  user_id: string;
  parent_id: string | null;
  payload_json: string;
  created_at: number;
}

function rowToEvent(row: EventRow): OrchestrationEvent {
  return {
    id: row.id,
    eventType: row.event_type,
    handleId: row.handle_id,
    agentId: row.agent_id,
    sessionId: row.session_id,
    userId: row.user_id,
    parentId: row.parent_id,
    payload: JSON.parse(row.payload_json),
    createdAt: row.created_at,
  };
}

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
  dbPath: string = dataFile('orchestration.db'),
): Promise<OrchestrationEventStore> {
  mkdirSync(dirname(dbPath), { recursive: true });

  const kyselyDb = createKyselyDb({ type: 'sqlite', path: dbPath });
  try {
    const result = await runMigrations(kyselyDb, orchestrationMigrations);
    if (result.error) throw result.error;
  } finally {
    await kyselyDb.destroy();
  }

  const db: SQLiteDatabase = openDatabase(dbPath);

  function append(event: OrchestrationEvent): void {
    db.prepare(
      `INSERT INTO orchestration_events
       (id, event_type, handle_id, agent_id, session_id, user_id, parent_id, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      event.id,
      event.eventType,
      event.handleId,
      event.agentId,
      event.sessionId,
      event.userId,
      event.parentId,
      JSON.stringify(event.payload),
      event.createdAt,
    );
  }

  function query(filter?: EventFilter): OrchestrationEvent[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter?.eventType) {
      conditions.push('event_type = ?');
      params.push(filter.eventType);
    }
    if (filter?.handleId) {
      conditions.push('handle_id = ?');
      params.push(filter.handleId);
    }
    if (filter?.agentId) {
      conditions.push('agent_id = ?');
      params.push(filter.agentId);
    }
    if (filter?.sessionId) {
      conditions.push('session_id = ?');
      params.push(filter.sessionId);
    }
    if (filter?.userId) {
      conditions.push('user_id = ?');
      params.push(filter.userId);
    }
    if (filter?.since) {
      conditions.push('created_at >= ?');
      params.push(filter.since);
    }
    if (filter?.until) {
      conditions.push('created_at <= ?');
      params.push(filter.until);
    }

    let sql = 'SELECT * FROM orchestration_events';
    if (conditions.length > 0) sql += ' WHERE ' + conditions.join(' AND ');
    sql += ' ORDER BY created_at ASC';
    if (filter?.limit) {
      sql += ' LIMIT ?';
      params.push(filter.limit);
    }

    const rows = db.prepare(sql).all(...params) as EventRow[];
    return rows.map(rowToEvent);
  }

  function byAgent(handleId: string, limit?: number): OrchestrationEvent[] {
    return query({ handleId, limit });
  }

  function bySession(sessionId: string, limit?: number): OrchestrationEvent[] {
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

      try {
        append(orchEvent);
      } catch (err) {
        logger.error('event_store_append_failed', { type: event.type, err });
      }
    });
  }

  function close(): void {
    db.close();
  }

  return { append, query, byAgent, bySession, startCapture, close };
}
