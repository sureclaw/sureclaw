import { describe, test, expect, beforeEach } from 'vitest';
import { isCompanyAdmin, claimCompanyAdmin, addCompanyAdmin } from '../../src/host/company-admin.js';
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

describe('company-admin', () => {
  let docs: DocumentStore;

  beforeEach(() => {
    docs = createMockDocStore();
  });

  test('claimCompanyAdmin succeeds when no admins exist', async () => {
    const claimed = await claimCompanyAdmin(docs, 'alice');
    expect(claimed).toBe(true);
    expect(await isCompanyAdmin(docs, 'alice')).toBe(true);
  });

  test('claimCompanyAdmin fails when admins already exist', async () => {
    await claimCompanyAdmin(docs, 'alice');
    const claimed = await claimCompanyAdmin(docs, 'bob');
    expect(claimed).toBe(false);
    expect(await isCompanyAdmin(docs, 'bob')).toBe(false);
  });

  test('addCompanyAdmin adds a new admin', async () => {
    await claimCompanyAdmin(docs, 'alice');
    await addCompanyAdmin(docs, 'bob');
    expect(await isCompanyAdmin(docs, 'bob')).toBe(true);
    expect(await isCompanyAdmin(docs, 'alice')).toBe(true);
  });

  test('addCompanyAdmin is idempotent', async () => {
    await claimCompanyAdmin(docs, 'alice');
    await addCompanyAdmin(docs, 'alice');
    const raw = await docs.get('config', 'company/admins');
    const admins = JSON.parse(raw!);
    expect(admins).toEqual(['alice']);
  });

  test('isCompanyAdmin returns false when no admins exist', async () => {
    expect(await isCompanyAdmin(docs, 'alice')).toBe(false);
  });
});
