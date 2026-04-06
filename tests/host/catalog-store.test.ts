/**
 * Tests for CatalogStore — shared company skill/connector catalog.
 */
import { describe, test, expect, beforeEach } from 'vitest';
import { CatalogStore } from '../../src/host/catalog-store.js';
import type { DocumentStore } from '../../src/providers/storage/types.js';

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

describe('CatalogStore', () => {
  let docs: DocumentStore;
  let store: CatalogStore;

  beforeEach(() => {
    docs = createMockDocStore();
    store = new CatalogStore(docs);
  });

  test('publish and get entry', async () => {
    const entry = await store.publish({
      slug: 'github-deploy',
      type: 'skill',
      name: 'GitHub Deploy',
      description: 'Deploy via GitHub Actions',
      author: 'alice',
      tags: ['github', 'ci'],
      version: '1.0.0',
      content: '# Deploy Skill\n...',
    });
    expect(entry.slug).toBe('github-deploy');

    const retrieved = await store.get('github-deploy');
    expect(retrieved?.name).toBe('GitHub Deploy');
  });

  test('list filters by type', async () => {
    await store.publish({ slug: 's1', type: 'skill', name: 'S1', description: '', author: 'a', tags: ['ci'], version: '1', content: '' });
    await store.publish({ slug: 'c1', type: 'connector', name: 'C1', description: '', author: 'a', tags: ['slack'], version: '1', content: '' });

    const skills = await store.list({ type: 'skill' });
    expect(skills).toHaveLength(1);
    expect(skills[0].slug).toBe('s1');
  });

  test('list filters by tags', async () => {
    await store.publish({ slug: 's1', type: 'skill', name: 'S1', description: '', author: 'a', tags: ['ci', 'deploy'], version: '1', content: '' });
    await store.publish({ slug: 's2', type: 'skill', name: 'S2', description: '', author: 'a', tags: ['slack'], version: '1', content: '' });

    const ciSkills = await store.list({ tags: ['ci'] });
    expect(ciSkills).toHaveLength(1);
    expect(ciSkills[0].slug).toBe('s1');
  });

  test('list filters by query', async () => {
    await store.publish({ slug: 's1', type: 'skill', name: 'Deploy Tool', description: 'Deploys things', author: 'a', tags: [], version: '1', content: '' });
    await store.publish({ slug: 's2', type: 'skill', name: 'Search Tool', description: 'Searches things', author: 'a', tags: [], version: '1', content: '' });

    const results = await store.list({ query: 'deploy' });
    expect(results).toHaveLength(1);
    expect(results[0].slug).toBe('s1');
  });

  test('list returns all entries when no filter', async () => {
    await store.publish({ slug: 's1', type: 'skill', name: 'S1', description: '', author: 'a', tags: [], version: '1', content: '' });
    await store.publish({ slug: 's2', type: 'skill', name: 'S2', description: '', author: 'a', tags: [], version: '1', content: '' });

    const all = await store.list();
    expect(all).toHaveLength(2);
  });

  test('setRequired marks entry and listRequired returns it', async () => {
    await store.publish({ slug: 'required-skill', type: 'skill', name: 'R', description: '', author: 'admin', tags: [], version: '1', content: '# Required' });
    await store.setRequired('required-skill', true);

    const required = await store.listRequired();
    expect(required).toHaveLength(1);
    expect(required[0].slug).toBe('required-skill');
  });

  test('setRequired false removes required flag', async () => {
    await store.publish({ slug: 'req', type: 'skill', name: 'R', description: '', author: 'admin', tags: [], version: '1', content: '' });
    await store.setRequired('req', true);
    await store.setRequired('req', false);

    const required = await store.listRequired();
    expect(required).toHaveLength(0);
  });

  test('unpublish removes entry', async () => {
    await store.publish({ slug: 'temp', type: 'skill', name: 'T', description: '', author: 'alice', tags: [], version: '1', content: '' });
    await store.unpublish('temp', 'alice');
    expect(await store.get('temp')).toBeNull();
  });

  test('unpublish rejects non-author', async () => {
    await store.publish({ slug: 'owned', type: 'skill', name: 'O', description: '', author: 'alice', tags: [], version: '1', content: '' });
    await expect(store.unpublish('owned', 'bob')).rejects.toThrow(/author/);
  });

  test('unpublish rejects required entry', async () => {
    await store.publish({ slug: 'req', type: 'skill', name: 'R', description: '', author: 'alice', tags: [], version: '1', content: '' });
    await store.setRequired('req', true);
    await expect(store.unpublish('req', 'alice')).rejects.toThrow(/required/);
  });

  test('get returns null for nonexistent slug', async () => {
    expect(await store.get('nonexistent')).toBeNull();
  });

  test('publish updates existing entry', async () => {
    await store.publish({ slug: 's1', type: 'skill', name: 'V1', description: 'old', author: 'a', tags: [], version: '1', content: 'v1' });
    await store.publish({ slug: 's1', type: 'skill', name: 'V2', description: 'new', author: 'a', tags: [], version: '2', content: 'v2' });

    const entry = await store.get('s1');
    expect(entry?.name).toBe('V2');
    expect(entry?.version).toBe('2');
  });
});
