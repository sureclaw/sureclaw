import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { resetAgent } from '../../src/cli/bootstrap.js';
import type { DocumentStore } from '../../src/providers/storage/types.js';

/** In-memory DocumentStore for testing. */
function createMemoryDocumentStore(): DocumentStore {
  const store = new Map<string, string>();
  return {
    async get(collection: string, key: string) {
      return store.get(`${collection}:${key}`);
    },
    async put(collection: string, key: string, content: string) {
      store.set(`${collection}:${key}`, content);
    },
    async delete(collection: string, key: string) {
      return store.delete(`${collection}:${key}`);
    },
    async list(collection: string) {
      return [...store.keys()]
        .filter(k => k.startsWith(`${collection}:`))
        .map(k => k.slice(collection.length + 1));
    },
  };
}

describe('bootstrap command', () => {
  let templatesDir: string;
  let documents: DocumentStore;

  beforeEach(() => {
    const id = randomUUID();
    templatesDir = join(tmpdir(), `ax-test-templates-${id}`);
    mkdirSync(templatesDir, { recursive: true });
    documents = createMemoryDocumentStore();
  });

  afterEach(() => {
    rmSync(templatesDir, { recursive: true, force: true });
  });

  test('resetAgent deletes SOUL.md and IDENTITY.md from DocumentStore', async () => {
    await documents.put('identity', 'main/SOUL.md', '# Old soul');
    await documents.put('identity', 'main/IDENTITY.md', '# Old identity');
    await documents.put('identity', 'main/AGENTS.md', '# Rules');

    await resetAgent('main', templatesDir, documents);

    expect(await documents.get('identity', 'main/SOUL.md')).toBeUndefined();
    expect(await documents.get('identity', 'main/IDENTITY.md')).toBeUndefined();
    // AGENTS.md should NOT be deleted
    expect(await documents.get('identity', 'main/AGENTS.md')).toBe('# Rules');
  });

  test('resetAgent seeds BOOTSTRAP.md to DocumentStore', async () => {
    writeFileSync(join(templatesDir, 'BOOTSTRAP.md'), '# Bootstrap\nDiscover yourself.');

    await resetAgent('main', templatesDir, documents);

    const content = await documents.get('identity', 'main/BOOTSTRAP.md');
    expect(content).toContain('Bootstrap');
  });

  test('resetAgent seeds USER_BOOTSTRAP.md to DocumentStore', async () => {
    writeFileSync(join(templatesDir, 'USER_BOOTSTRAP.md'), '# Welcome\nTell me about yourself.');

    await resetAgent('main', templatesDir, documents);

    const content = await documents.get('identity', 'main/USER_BOOTSTRAP.md');
    expect(content).toContain('Welcome');
  });

  test('resetAgent is idempotent (no error if files missing)', async () => {
    // No files exist — should not throw
    await expect(resetAgent('main', templatesDir, documents)).resolves.not.toThrow();
  });
});
