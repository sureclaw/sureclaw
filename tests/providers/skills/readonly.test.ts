import { describe, test, expect, beforeEach } from 'vitest';
import { create } from '../../../src/providers/skills/readonly.js';
import type { SkillStoreProvider } from '../../../src/providers/skills/types.js';
import type { Config } from '../../../src/types.js';
import type { DocumentStore, StorageProvider } from '../../../src/providers/storage/types.js';

/** In-memory DocumentStore for testing. */
function createMockDocumentStore(): DocumentStore {
  const store = new Map<string, Map<string, string>>();

  function getCollection(collection: string): Map<string, string> {
    let col = store.get(collection);
    if (!col) {
      col = new Map();
      store.set(collection, col);
    }
    return col;
  }

  return {
    async get(collection: string, key: string) { return getCollection(collection).get(key); },
    async put(collection: string, key: string, content: string) { getCollection(collection).set(key, content); },
    async delete(collection: string, key: string) { return getCollection(collection).delete(key); },
    async list(collection: string) { return [...getCollection(collection).keys()]; },
  };
}

function mockStorage(documents: DocumentStore): StorageProvider {
  return {
    documents,
    messages: {} as any,
    conversations: {} as any,
    sessions: {} as any,
    close() {},
  };
}

const config = { agent_name: 'main' } as Config;

describe('skills-readonly', () => {
  let skills: SkillStoreProvider;
  let documents: DocumentStore;

  beforeEach(async () => {
    documents = createMockDocumentStore();
    // Seed a test skill
    await documents.put('skills', 'main/default.md', '# Default Skill\n\nA test default skill.');
    const storage = mockStorage(documents);
    skills = await create(config, undefined, { storage });
  });

  test('lists skills from DocumentStore', async () => {
    const list = await skills.list();
    expect(Array.isArray(list)).toBe(true);
    expect(list.some(s => s.name === 'default')).toBe(true);
  });

  test('reads a skill document', async () => {
    const content = await skills.read('default');
    expect(typeof content).toBe('string');
    expect(content.length).toBeGreaterThan(0);
    expect(content).toContain('Default Skill');
  });

  test('throws on missing skill', async () => {
    await expect(skills.read('nonexistent')).rejects.toThrow('Skill not found');
  });

  test('propose writes to DocumentStore (auto-approve)', async () => {
    const result = await skills.propose({ skill: 'new-skill', content: '# New\nContent.' });
    expect(result.verdict).toBe('AUTO_APPROVE');

    // Verify it was stored
    const stored = await documents.get('skills', 'main/new-skill.md');
    expect(stored).toBe('# New\nContent.');
  });

  test('approve is a no-op', async () => {
    await expect(skills.approve('id')).resolves.toBeUndefined();
  });

  test('reject is a no-op', async () => {
    await expect(skills.reject('id')).resolves.toBeUndefined();
  });

  test('revert throws', async () => {
    await expect(skills.revert('id')).rejects.toThrow('not supported');
  });

  test('log returns empty array', async () => {
    const log = await skills.log();
    expect(log).toEqual([]);
  });

  test('list only returns skills for the configured agent', async () => {
    await documents.put('skills', 'other-agent/extra.md', '# Extra');
    const list = await skills.list();
    expect(list.every(s => !s.name.includes('extra'))).toBe(true);
  });

  test('list excludes user-scoped skills', async () => {
    await documents.put('skills', 'main/users/alice/custom.md', '# Custom');
    const list = await skills.list();
    expect(list.every(s => !s.name.includes('custom'))).toBe(true);
  });
});
