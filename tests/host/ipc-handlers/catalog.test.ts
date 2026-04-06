/**
 * Tests for catalog IPC handlers.
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';
import { createCatalogHandlers } from '../../../src/host/ipc-handlers/catalog.js';
import { CatalogStore } from '../../../src/host/catalog-store.js';
import type { IPCContext } from '../../../src/host/ipc-server.js';
import type { DocumentStore } from '../../../src/providers/storage/types.js';
import type { AuditProvider } from '../../../src/providers/audit/types.js';

function createMockDocStore(): DocumentStore {
  const store = new Map<string, string>();
  return {
    async get(collection: string, key: string) {
      return store.get(`${collection}/${key}`);
    },
    async put(collection: string, key: string, content: string) {
      store.set(`${collection}/${key}`, content);
    },
    async delete(collection: string, key: string) {
      return store.delete(`${collection}/${key}`);
    },
    async list(collection: string) {
      const prefix = `${collection}/`;
      return [...store.keys()]
        .filter(k => k.startsWith(prefix))
        .map(k => k.slice(prefix.length));
    },
  };
}

describe('catalog IPC handlers', () => {
  let docs: DocumentStore;
  let catalog: CatalogStore;
  let audit: AuditProvider;
  let handlers: ReturnType<typeof createCatalogHandlers>;

  beforeEach(() => {
    docs = createMockDocStore();
    catalog = new CatalogStore(docs);
    audit = { log: vi.fn() } as any;
    handlers = createCatalogHandlers(catalog, docs, audit);
  });

  const ctx: IPCContext = { sessionId: 's1', agentId: 'system', userId: 'alice' };

  test('catalog_publish creates entry', async () => {
    const result = await handlers.catalog_publish({
      slug: 'my-skill',
      type: 'skill',
      name: 'My Skill',
      description: 'Does things',
      tags: ['test'],
      version: '1.0.0',
      content: '# My Skill',
    }, ctx);

    expect(result.entry.slug).toBe('my-skill');
    expect(result.entry.author).toBe('alice');
  });

  test('catalog_get retrieves published entry', async () => {
    await handlers.catalog_publish({
      slug: 'test-skill',
      type: 'skill',
      name: 'Test',
      description: '',
      tags: [],
      version: '1',
      content: '',
    }, ctx);

    const result = await handlers.catalog_get({ slug: 'test-skill' }, ctx);
    expect(result.entry?.name).toBe('Test');
  });

  test('catalog_get returns null for missing entry', async () => {
    const result = await handlers.catalog_get({ slug: 'nonexistent' }, ctx);
    expect(result.entry).toBeNull();
  });

  test('catalog_list returns all entries', async () => {
    await handlers.catalog_publish({ slug: 's1', type: 'skill', name: 'S1', description: '', tags: [], version: '1', content: '' }, ctx);
    await handlers.catalog_publish({ slug: 's2', type: 'skill', name: 'S2', description: '', tags: [], version: '1', content: '' }, ctx);

    const result = await handlers.catalog_list({}, ctx);
    expect(result.entries).toHaveLength(2);
  });

  test('catalog_list filters by type', async () => {
    await handlers.catalog_publish({ slug: 's1', type: 'skill', name: 'S1', description: '', tags: [], version: '1', content: '' }, ctx);
    await handlers.catalog_publish({ slug: 'c1', type: 'connector', name: 'C1', description: '', tags: [], version: '1', content: '' }, ctx);

    const result = await handlers.catalog_list({ type: 'skill' }, ctx);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].slug).toBe('s1');
  });

  test('catalog_unpublish removes entry', async () => {
    await handlers.catalog_publish({ slug: 'temp', type: 'skill', name: 'T', description: '', tags: [], version: '1', content: '' }, ctx);
    const result = await handlers.catalog_unpublish({ slug: 'temp' }, ctx);
    expect(result.ok).toBe(true);

    const get = await handlers.catalog_get({ slug: 'temp' }, ctx);
    expect(get.entry).toBeNull();
  });

  test('catalog_set_required requires company admin', async () => {
    await handlers.catalog_publish({ slug: 'req', type: 'skill', name: 'R', description: '', tags: [], version: '1', content: '' }, ctx);

    // alice is not a company admin
    await expect(
      handlers.catalog_set_required({ slug: 'req', required: true }, ctx)
    ).rejects.toThrow(/company admin/i);
  });

  test('catalog_set_required succeeds for company admin', async () => {
    // Set up alice as company admin
    await docs.put('config', 'company/admins', JSON.stringify(['alice']));

    await handlers.catalog_publish({ slug: 'req', type: 'skill', name: 'R', description: '', tags: [], version: '1', content: '' }, ctx);
    const result = await handlers.catalog_set_required({ slug: 'req', required: true }, ctx);
    expect(result.ok).toBe(true);

    const entry = await catalog.get('req');
    expect(entry?.required).toBe(true);
  });
});
