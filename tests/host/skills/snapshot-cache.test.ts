import { describe, it, expect } from 'vitest';
import { createSnapshotCache } from '../../../src/host/skills/snapshot-cache.js';
import type { SkillSnapshotEntry } from '../../../src/host/skills/types.js';

function entry(name: string): SkillSnapshotEntry {
  return {
    name,
    ok: true,
    body: '',
    frontmatter: {
      name,
      description: `skill ${name}`,
      credentials: [],
      mcpServers: [],
      domains: [],
    },
  };
}

describe('createSnapshotCache', () => {
  it('returns undefined on miss and the stored value on hit', () => {
    const cache = createSnapshotCache<SkillSnapshotEntry[]>({ maxEntries: 8 });
    expect(cache.get('a@sha1')).toBeUndefined();
    const value = [entry('foo')];
    cache.put('a@sha1', value);
    expect(cache.get('a@sha1')).toBe(value);
  });

  it('returns distinct values for distinct keys', () => {
    const cache = createSnapshotCache<SkillSnapshotEntry[]>({ maxEntries: 8 });
    const v1 = [entry('foo')];
    const v2 = [entry('bar')];
    cache.put('a@sha1', v1);
    cache.put('a@sha2', v2);
    expect(cache.get('a@sha1')).toBe(v1);
    expect(cache.get('a@sha2')).toBe(v2);
  });

  it('evicts the least-recently-used entry when over bound', () => {
    const cache = createSnapshotCache<SkillSnapshotEntry[]>({ maxEntries: 3 });
    cache.put('k1', [entry('s1')]);
    cache.put('k2', [entry('s2')]);
    cache.put('k3', [entry('s3')]);
    cache.put('k4', [entry('s4')]);

    expect(cache.size()).toBe(3);
    expect(cache.get('k1')).toBeUndefined();
    expect(cache.get('k2')).toBeDefined();
    expect(cache.get('k3')).toBeDefined();
    expect(cache.get('k4')).toBeDefined();
  });

  it('moves an entry to most-recent on get (LRU semantics)', () => {
    const cache = createSnapshotCache<SkillSnapshotEntry[]>({ maxEntries: 3 });
    cache.put('k1', [entry('s1')]);
    cache.put('k2', [entry('s2')]);
    cache.put('k3', [entry('s3')]);

    // Touch k1 — makes k2 the oldest.
    expect(cache.get('k1')).toBeDefined();

    cache.put('k4', [entry('s4')]);

    expect(cache.get('k1')).toBeDefined();
    expect(cache.get('k2')).toBeUndefined();
    expect(cache.get('k3')).toBeDefined();
    expect(cache.get('k4')).toBeDefined();
  });

  it('refreshes LRU order on re-put of an existing key', () => {
    const cache = createSnapshotCache<SkillSnapshotEntry[]>({ maxEntries: 3 });
    cache.put('k1', [entry('s1')]);
    cache.put('k2', [entry('s2')]);
    cache.put('k3', [entry('s3')]);

    // Re-putting k1 moves it to most-recent; k2 becomes oldest.
    const v1b = [entry('s1b')];
    cache.put('k1', v1b);
    cache.put('k4', [entry('s4')]);

    expect(cache.get('k1')).toBe(v1b);
    expect(cache.get('k2')).toBeUndefined();
    expect(cache.get('k3')).toBeDefined();
    expect(cache.get('k4')).toBeDefined();
  });

  it('invalidateAgent() drops every key starting with `${agentId}@`', () => {
    const cache = createSnapshotCache<SkillSnapshotEntry[]>({ maxEntries: 8 });
    cache.put('a1@sha1', [entry('s1')]);
    cache.put('a1@sha2', [entry('s2')]);
    cache.put('a2@sha1', [entry('s3')]);
    cache.put('a10@sha1', [entry('s4')]); // prefix guard: not a1
    expect(cache.size()).toBe(4);

    const removed = cache.invalidateAgent('a1');
    expect(removed).toBe(2);
    expect(cache.get('a1@sha1')).toBeUndefined();
    expect(cache.get('a1@sha2')).toBeUndefined();
    expect(cache.get('a2@sha1')).toBeDefined();
    expect(cache.get('a10@sha1')).toBeDefined();
  });

  it('invalidateAgent() returns 0 when the agent has no cached entries', () => {
    const cache = createSnapshotCache<SkillSnapshotEntry[]>({ maxEntries: 8 });
    cache.put('a2@sha1', [entry('s1')]);
    expect(cache.invalidateAgent('a1')).toBe(0);
    expect(cache.size()).toBe(1);
  });

  it('clear() empties the cache', () => {
    const cache = createSnapshotCache<SkillSnapshotEntry[]>({ maxEntries: 3 });
    cache.put('k1', [entry('s1')]);
    cache.put('k2', [entry('s2')]);
    expect(cache.size()).toBe(2);
    cache.clear();
    expect(cache.size()).toBe(0);
    expect(cache.get('k1')).toBeUndefined();
  });
});
