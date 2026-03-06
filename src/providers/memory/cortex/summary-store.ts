import { readFile, writeFile, rename, readdir, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { safePath } from '../../../utils/safe-path.js';
import { DEFAULT_CATEGORIES } from './types.js';
import type { Kysely } from 'kysely';

/** Prefix for synthetic summary IDs returned from query(). */
export const SUMMARY_ID_PREFIX = 'summary:';

/**
 * Abstract interface for reading/writing category summary content.
 * Two implementations: FileSummaryStore (local dev) and DbSummaryStore (k8s/PostgreSQL).
 */
export interface SummaryStore {
  read(category: string, userId?: string): Promise<string | null>;
  write(category: string, content: string, userId?: string): Promise<void>;
  list(userId?: string): Promise<string[]>;
  readAll(userId?: string): Promise<Map<string, string>>;
  initDefaults(): Promise<void>;
}

// ── FileSummaryStore ─────────────────────────────────────────────

function summaryDir(memoryDir: string, userId?: string): string {
  if (!userId) return memoryDir;
  return safePath(safePath(memoryDir, 'users'), userId);
}

export class FileSummaryStore implements SummaryStore {
  constructor(private memoryDir: string) {}

  async read(category: string, userId?: string): Promise<string | null> {
    const filePath = safePath(summaryDir(this.memoryDir, userId), `${category}.md`);
    try {
      return await readFile(filePath, 'utf-8');
    } catch {
      return null;
    }
  }

  async write(category: string, content: string, userId?: string): Promise<void> {
    const dir = summaryDir(this.memoryDir, userId);
    const filePath = safePath(dir, `${category}.md`);
    await mkdir(dir, { recursive: true });
    const tmpPath = `${filePath}.${randomUUID()}.tmp`;
    await writeFile(tmpPath, content, 'utf-8');
    await rename(tmpPath, filePath);
  }

  async list(userId?: string): Promise<string[]> {
    const dir = summaryDir(this.memoryDir, userId);
    try {
      const files = await readdir(dir);
      return files
        .filter(f => f.endsWith('.md') && !f.startsWith('_'))
        .map(f => f.replace(/\.md$/, ''));
    } catch {
      return [];
    }
  }

  async readAll(userId?: string): Promise<Map<string, string>> {
    const categories = await this.list(userId);
    const result = new Map<string, string>();
    for (const cat of categories) {
      const content = await this.read(cat, userId);
      if (content) result.set(cat, content);
    }
    return result;
  }

  async initDefaults(): Promise<void> {
    await mkdir(this.memoryDir, { recursive: true });
    for (const cat of DEFAULT_CATEGORIES) {
      try {
        await writeFile(
          safePath(this.memoryDir, `${cat}.md`),
          `# ${cat}\n`,
          { flag: 'wx' },
        );
      } catch (err: any) {
        if (err?.code !== 'EEXIST') throw err;
      }
    }
  }
}
