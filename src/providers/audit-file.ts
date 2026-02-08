import { appendFileSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AuditProvider, AuditEntry, AuditFilter, Config } from './types.js';

const DEFAULT_AUDIT_PATH = 'data/audit/audit.jsonl';

export async function create(_config: Config): Promise<AuditProvider> {
  const auditPath = DEFAULT_AUDIT_PATH;
  mkdirSync(dirname(auditPath), { recursive: true });

  return {
    async log(entry: Partial<AuditEntry>): Promise<void> {
      const full: Record<string, unknown> = {
        timestamp: new Date().toISOString(),
        ...entry,
      };
      appendFileSync(auditPath, JSON.stringify(full) + '\n');
    },

    async query(filter: AuditFilter): Promise<AuditEntry[]> {
      let lines: string[];
      try {
        lines = readFileSync(auditPath, 'utf-8').trim().split('\n').filter(Boolean);
      } catch {
        return [];
      }

      let entries: AuditEntry[] = lines.map(line => JSON.parse(line));

      if (filter.action) {
        entries = entries.filter(e => e.action === filter.action);
      }
      if (filter.sessionId) {
        entries = entries.filter(e => e.sessionId === filter.sessionId);
      }
      if (filter.since) {
        const since = new Date(filter.since);
        entries = entries.filter(e => new Date(e.timestamp) >= since);
      }
      if (filter.until) {
        const until = new Date(filter.until);
        entries = entries.filter(e => new Date(e.timestamp) <= until);
      }
      if (filter.limit) {
        entries = entries.slice(-filter.limit);
      }

      return entries;
    },
  };
}
