import { readFileSync, writeFileSync, readdirSync, unlinkSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { safePath } from '../utils/safe-path.js';
import type { MemoryProvider, MemoryEntry, MemoryQuery, Config } from './types.js';

const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const DEFAULT_BASE = 'data/memory';

export async function create(_config: Config): Promise<MemoryProvider> {
  const baseDir = DEFAULT_BASE;
  mkdirSync(baseDir, { recursive: true });

  function scopeDir(scope: string): string {
    const dir = safePath(baseDir, scope);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  function validateId(id: string): void {
    if (!UUID_RE.test(id)) {
      throw new Error(`Invalid memory ID format: "${id}"`);
    }
  }

  return {
    async write(entry: MemoryEntry): Promise<string> {
      const id = entry.id ?? randomUUID();
      validateId(id);
      const dir = scopeDir(entry.scope);
      const filePath = safePath(dir, `${id}.json`);
      const stored = { ...entry, id, createdAt: entry.createdAt ?? new Date() };
      writeFileSync(filePath, JSON.stringify(stored, null, 2));
      return id;
    },

    async query(q: MemoryQuery): Promise<MemoryEntry[]> {
      const dir = scopeDir(q.scope);
      let files: string[];
      try {
        files = readdirSync(dir).filter(f => f.endsWith('.json'));
      } catch {
        return [];
      }

      const results: MemoryEntry[] = [];
      for (const file of files) {
        const filePath = safePath(dir, file);
        try {
          const entry: MemoryEntry = JSON.parse(readFileSync(filePath, 'utf-8'));
          if (!q.query || entry.content.toLowerCase().includes(q.query.toLowerCase())) {
            if (!q.tags || q.tags.every(t => entry.tags?.includes(t))) {
              results.push(entry);
            }
          }
        } catch { continue; }
      }

      const limit = q.limit ?? 50;
      return results.slice(0, limit);
    },

    async read(id: string): Promise<MemoryEntry | null> {
      validateId(id);
      let scopes: string[];
      try {
        scopes = readdirSync(baseDir);
      } catch {
        return null;
      }

      for (const scope of scopes) {
        try {
          const filePath = safePath(baseDir, scope, `${id}.json`);
          return JSON.parse(readFileSync(filePath, 'utf-8'));
        } catch { continue; }
      }
      return null;
    },

    async delete(id: string): Promise<void> {
      validateId(id);
      let scopes: string[];
      try {
        scopes = readdirSync(baseDir);
      } catch {
        return;
      }

      for (const scope of scopes) {
        try {
          const filePath = safePath(baseDir, scope, `${id}.json`);
          unlinkSync(filePath);
        } catch { /* not in this scope */ }
      }
    },

    async list(scope: string, limit?: number): Promise<MemoryEntry[]> {
      const dir = scopeDir(scope);
      let files: string[];
      try {
        files = readdirSync(dir).filter(f => f.endsWith('.json'));
      } catch {
        return [];
      }

      const results: MemoryEntry[] = [];
      for (const file of files.slice(0, limit ?? 50)) {
        try {
          const filePath = safePath(dir, file);
          results.push(JSON.parse(readFileSync(filePath, 'utf-8')));
        } catch { continue; }
      }

      return results;
    },
  };
}
