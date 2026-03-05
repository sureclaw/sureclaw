import { mkdirSync } from 'node:fs';
import { openDatabase } from '../../utils/sqlite.js';
import type { SQLiteDatabase } from '../../utils/sqlite.js';
import { dataDir, dataFile } from '../../paths.js';
import type { AuditProvider, AuditEntry, AuditFilter } from './types.js';
import type { Config } from '../../types.js';
import { createKyselyDb } from '../../utils/database.js';
import { runMigrations } from '../../utils/migrator.js';
import { auditMigrations } from '../../migrations/audit.js';

export async function create(_config: Config, _name?: string, _opts?: Record<string, unknown>): Promise<AuditProvider> {
  mkdirSync(dataDir(), { recursive: true });
  const dbPath = dataFile('audit.db');

  const kyselyDb = createKyselyDb({ type: 'sqlite', path: dbPath });
  try {
    const result = await runMigrations(kyselyDb, auditMigrations);
    if (result.error) throw result.error;
  } finally {
    await kyselyDb.destroy();
  }

  const db: SQLiteDatabase = openDatabase(dbPath);

  function rowToEntry(row: Record<string, unknown>): AuditEntry {
    return {
      timestamp: new Date(row.timestamp as string),
      sessionId: row.session_id as string,
      action: row.action as string,
      args: row.args ? JSON.parse(row.args as string) : {},
      result: row.result as 'success' | 'blocked' | 'error',
      taint: row.taint ? JSON.parse(row.taint as string) : undefined,
      durationMs: (row.duration_ms as number) ?? 0,
      tokenUsage: row.token_input != null
        ? { input: row.token_input as number, output: row.token_output as number }
        : undefined,
    };
  }

  return {
    async log(entry: Partial<AuditEntry>): Promise<void> {
      db.prepare(`
        INSERT INTO audit_log (timestamp, session_id, action, args, result, taint, duration_ms, token_input, token_output)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        entry.timestamp ? entry.timestamp.toISOString() : new Date().toISOString(),
        entry.sessionId ?? null,
        entry.action ?? 'unknown',
        entry.args ? JSON.stringify(entry.args) : null,
        entry.result ?? 'success',
        entry.taint ? JSON.stringify(entry.taint) : null,
        entry.durationMs ?? 0,
        entry.tokenUsage?.input ?? null,
        entry.tokenUsage?.output ?? null,
      );
    },

    async query(filter: AuditFilter): Promise<AuditEntry[]> {
      const conditions: string[] = [];
      const params: unknown[] = [];

      if (filter.action) {
        conditions.push('action = ?');
        params.push(filter.action);
      }
      if (filter.sessionId) {
        conditions.push('session_id = ?');
        params.push(filter.sessionId);
      }
      if (filter.since) {
        conditions.push('timestamp >= ?');
        params.push(new Date(filter.since).toISOString());
      }
      if (filter.until) {
        conditions.push('timestamp <= ?');
        params.push(new Date(filter.until).toISOString());
      }

      let sql = 'SELECT * FROM audit_log';
      if (conditions.length > 0) {
        sql += ' WHERE ' + conditions.join(' AND ');
      }
      sql += ' ORDER BY timestamp ASC';

      if (filter.limit) {
        // Return last N entries (most recent)
        sql = `SELECT * FROM (${sql}) sub ORDER BY timestamp DESC LIMIT ?`;
        params.push(filter.limit);
        // Re-sort to ascending
        sql = `SELECT * FROM (${sql}) sub2 ORDER BY timestamp ASC`;
      }

      const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
      return rows.map(rowToEntry);
    },
  };
}
