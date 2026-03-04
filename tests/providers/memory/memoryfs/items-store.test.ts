// tests/providers/memory/memoryfs/items-store.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ItemsStore } from '../../../../src/providers/memory/memoryfs/items-store.js';
import type { MemoryFSItem } from '../../../../src/providers/memory/memoryfs/types.js';

describe('ItemsStore', () => {
  let store: ItemsStore;
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'memfs-test-'));
    store = new ItemsStore(join(testDir, '_store.db'));
  });

  afterEach(async () => {
    store.close();
    await rm(testDir, { recursive: true, force: true });
  });

  const sampleItem: Omit<MemoryFSItem, 'id'> = {
    content: 'Prefers TypeScript over JavaScript',
    memoryType: 'profile',
    category: 'preferences',
    contentHash: 'a1b2c3d4e5f6g7h8',
    confidence: 0.95,
    reinforcementCount: 1,
    lastReinforcedAt: '2026-03-01T00:00:00Z',
    createdAt: '2026-03-01T00:00:00Z',
    updatedAt: '2026-03-01T00:00:00Z',
    scope: 'default',
  };

  it('inserts and reads an item', () => {
    const id = store.insert(sampleItem);
    const item = store.getById(id);
    expect(item).not.toBeNull();
    expect(item!.content).toBe('Prefers TypeScript over JavaScript');
    expect(item!.memoryType).toBe('profile');
    expect(item!.reinforcementCount).toBe(1);
  });

  it('finds item by content hash within scope', () => {
    store.insert(sampleItem);
    const found = store.findByHash('a1b2c3d4e5f6g7h8', 'default');
    expect(found).not.toBeNull();
    expect(found!.content).toBe(sampleItem.content);
  });

  it('returns null for hash in different scope', () => {
    store.insert(sampleItem);
    const found = store.findByHash('a1b2c3d4e5f6g7h8', 'other-scope');
    expect(found).toBeNull();
  });

  it('reinforces existing item (increments count + updates timestamp)', () => {
    const id = store.insert(sampleItem);
    store.reinforce(id);
    const item = store.getById(id);
    expect(item!.reinforcementCount).toBe(2);
    expect(item!.lastReinforcedAt).not.toBe('2026-03-01T00:00:00Z');
  });

  it('lists items by category', () => {
    store.insert(sampleItem);
    store.insert({ ...sampleItem, content: 'Uses vim', contentHash: 'bbbbbbbbbbbbbbbb' });
    store.insert({ ...sampleItem, content: 'Runs on GKE', category: 'knowledge', contentHash: 'cccccccccccccccc' });
    const prefs = store.listByCategory('preferences', 'default');
    expect(prefs).toHaveLength(2);
  });

  it('lists items by scope with limit', () => {
    for (let i = 0; i < 20; i++) {
      store.insert({ ...sampleItem, content: `Fact ${i}`, contentHash: `hash_${i.toString().padStart(12, '0')}` });
    }
    const limited = store.listByScope('default', 5);
    expect(limited).toHaveLength(5);
  });

  it('deletes an item', () => {
    const id = store.insert(sampleItem);
    store.deleteById(id);
    expect(store.getById(id)).toBeNull();
  });

  it('searches content with LIKE', () => {
    store.insert(sampleItem);
    store.insert({ ...sampleItem, content: 'Uses vim keybindings', contentHash: 'dddddddddddddddd' });
    const results = store.searchContent('TypeScript', 'default');
    expect(results).toHaveLength(1);
    expect(results[0].content).toContain('TypeScript');
  });

  it('scopes queries by agentId when provided', () => {
    store.insert({ ...sampleItem, agentId: 'agent_1' });
    store.insert({ ...sampleItem, content: 'Other agent fact', contentHash: 'eeeeeeeeeeeeeeee', agentId: 'agent_2' });
    const results = store.listByScope('default', 50, 'agent_1');
    expect(results).toHaveLength(1);
  });

  it('getAllForCategory returns all items for summary generation', () => {
    store.insert(sampleItem);
    store.insert({ ...sampleItem, content: 'Uses vim', contentHash: 'ffffffffffffffff' });
    const items = store.getAllForCategory('preferences', 'default');
    expect(items).toHaveLength(2);
  });

  it('listAllScopes returns all distinct scopes', () => {
    store.insert({ ...sampleItem, scope: 'project-a' });
    store.insert({ ...sampleItem, scope: 'project-b', contentHash: 'gggggggggggggggg' });
    store.insert({ ...sampleItem, scope: 'project-a', contentHash: 'hhhhhhhhhhhhhhhh' });
    const scopes = store.listAllScopes();
    expect(scopes.sort()).toEqual(['project-a', 'project-b']);
  });

  it('listAllScopes returns empty for empty store', () => {
    expect(store.listAllScopes()).toEqual([]);
  });

  // ── userId scoping ──

  it('findByHash isolates by userId', () => {
    store.insert({ ...sampleItem, userId: 'alice' });
    store.insert({ ...sampleItem, content: 'Same hash different user', contentHash: 'a1b2c3d4e5f6g7h8', userId: 'bob' });

    const aliceItem = store.findByHash('a1b2c3d4e5f6g7h8', 'default', undefined, 'alice');
    expect(aliceItem).not.toBeNull();
    expect(aliceItem!.userId).toBe('alice');

    const bobItem = store.findByHash('a1b2c3d4e5f6g7h8', 'default', undefined, 'bob');
    expect(bobItem).not.toBeNull();
    expect(bobItem!.userId).toBe('bob');
  });

  it('findByHash with no userId matches only NULL userId items', () => {
    store.insert({ ...sampleItem, userId: 'alice' });
    store.insert({ ...sampleItem, contentHash: 'shared_hash_12345' }); // no userId = shared

    const shared = store.findByHash('shared_hash_12345', 'default');
    expect(shared).not.toBeNull();

    const userScoped = store.findByHash('a1b2c3d4e5f6g7h8', 'default');
    expect(userScoped).toBeNull(); // userId='alice' does not match NULL
  });

  it('listByScope with userId returns own + shared items', () => {
    store.insert({ ...sampleItem, userId: 'alice' });
    store.insert({ ...sampleItem, content: 'Shared fact', contentHash: 'shared_hash_12345' }); // shared
    store.insert({ ...sampleItem, content: 'Bob fact', contentHash: 'bob_hash_12345678', userId: 'bob' });

    const aliceView = store.listByScope('default', 50, undefined, 'alice');
    expect(aliceView).toHaveLength(2); // alice's own + shared
    const contents = aliceView.map(i => i.content);
    expect(contents).toContain('Prefers TypeScript over JavaScript'); // alice's
    expect(contents).toContain('Shared fact'); // shared
  });

  it('listByScope without userId returns all items (no user filter)', () => {
    store.insert({ ...sampleItem, userId: 'alice' });
    store.insert({ ...sampleItem, content: 'Shared fact', contentHash: 'shared_hash_12345' });
    store.insert({ ...sampleItem, content: 'Bob fact', contentHash: 'bob_hash_12345678', userId: 'bob' });

    const allView = store.listByScope('default', 50);
    expect(allView).toHaveLength(3); // all items
  });

  it('searchContent with userId returns own + shared', () => {
    store.insert({ ...sampleItem, content: 'Alice likes TypeScript', userId: 'alice' });
    store.insert({ ...sampleItem, content: 'TypeScript is shared knowledge', contentHash: 'shared_ts_123456' }); // shared
    store.insert({ ...sampleItem, content: 'Bob uses TypeScript too', contentHash: 'bob_ts_12345678', userId: 'bob' });

    const aliceResults = store.searchContent('TypeScript', 'default', 50, 'alice');
    expect(aliceResults).toHaveLength(2); // alice's + shared
    const contents = aliceResults.map(i => i.content);
    expect(contents).toContain('Alice likes TypeScript');
    expect(contents).toContain('TypeScript is shared knowledge');
    expect(contents).not.toContain('Bob uses TypeScript too');
  });

  it('listByCategory with userId returns own + shared', () => {
    store.insert({ ...sampleItem, userId: 'alice' });
    store.insert({ ...sampleItem, content: 'Shared preference', contentHash: 'shared_pref_12345' }); // shared
    store.insert({ ...sampleItem, content: 'Bob preference', contentHash: 'bob_pref_12345678', userId: 'bob' });

    const alicePrefs = store.listByCategory('preferences', 'default', undefined, 'alice');
    expect(alicePrefs).toHaveLength(2); // alice's + shared
  });

  it('stores and retrieves userId field', () => {
    const id = store.insert({ ...sampleItem, userId: 'alice' });
    const item = store.getById(id);
    expect(item!.userId).toBe('alice');
  });

  it('stores undefined userId as null', () => {
    const id = store.insert({ ...sampleItem });
    const item = store.getById(id);
    expect(item!.userId).toBeUndefined();
  });
});
