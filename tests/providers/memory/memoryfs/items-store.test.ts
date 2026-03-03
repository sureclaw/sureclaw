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
});
