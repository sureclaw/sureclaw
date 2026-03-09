// src/providers/audit/database.ts — Database-backed AuditProvider
//
// Uses the shared DatabaseProvider (SQLite or PostgreSQL).
// Runs its own migrations against the shared Kysely instance.

import { runMigrations } from '../../utils/migrator.js';
import { auditDbMigrations } from './migrations.js';
import type { AuditProvider, AuditEntry, AuditFilter } from './types.js';
import type { Config } from '../../types.js';
import type { DatabaseProvider } from '../database/types.js';
import type { Kysely } from 'kysely';

function rowToEntry(row: Record<string, unknown>): AuditEntry {
  return {
    timestamp: new Date(row.timestamp as string),
    sessionId: row.session_id as string,
    action: row.action as string,
    args: row.args ? JSON.parse(row.args as string) : {},
    result: row.result as AuditEntry['result'],
    taint: row.taint ? JSON.parse(row.taint as string) : undefined,
    durationMs: (row.duration_ms as number) ?? 0,
    tokenUsage: row.token_input != null
      ? { input: row.token_input as number, output: row.token_output as number }
      : undefined,
  };
}

export interface CreateOptions {
  database?: DatabaseProvider;
}

export async function create(
  _config: Config,
  _name?: string,
  opts?: CreateOptions,
): Promise<AuditProvider> {
  const database = opts?.database;
  if (!database) {
    throw new Error(
      'audit/database requires a database provider. Set providers.database in ax.yaml.',
    );
  }

  const result = await runMigrations(database.db, auditDbMigrations(database.type), 'audit_migration');
  if (result.error) throw result.error;

  const db: Kysely<any> = database.db;

  return {
    async log(entry: Partial<AuditEntry>): Promise<void> {
      await db.insertInto('audit_log')
        .values({
          timestamp: entry.timestamp ? entry.timestamp.toISOString() : new Date().toISOString(),
          session_id: entry.sessionId ?? null,
          action: entry.action ?? 'unknown',
          args: entry.args ? JSON.stringify(entry.args) : null,
          result: entry.result ?? 'success',
          taint: entry.taint ? JSON.stringify(entry.taint) : null,
          duration_ms: entry.durationMs ?? 0,
          token_input: entry.tokenUsage?.input ?? null,
          token_output: entry.tokenUsage?.output ?? null,
        })
        .execute();
    },

    async query(filter: AuditFilter): Promise<AuditEntry[]> {
      let query = db.selectFrom('audit_log').selectAll();

      if (filter.action) {
        query = query.where('action', '=', filter.action);
      }
      if (filter.sessionId) {
        query = query.where('session_id', '=', filter.sessionId);
      }
      if (filter.since) {
        query = query.where('timestamp', '>=', new Date(filter.since).toISOString());
      }
      if (filter.until) {
        query = query.where('timestamp', '<=', new Date(filter.until).toISOString());
      }

      query = query.orderBy('timestamp', 'asc');

      const rows = await query.execute();

      let entries = rows.map(r => rowToEntry(r as Record<string, unknown>));

      if (filter.limit) {
        entries = entries.slice(-filter.limit);
      }

      return entries;
    },
  };
}
