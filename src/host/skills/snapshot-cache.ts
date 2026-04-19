// src/host/skills/snapshot-cache.ts — Bounded LRU cache for per-agent git
// snapshots. Keyed on the caller's choice (typically `${agentId}@${headSha}`).
//
// Map iteration order preserves insertion order, so the oldest key is always
// the one iterated first. On `get` we delete+re-set to move a key to the
// most-recent end; on `put` over the bound we drop the oldest.

export interface SnapshotCache<V> {
  get(key: string): V | undefined;
  put(key: string, value: V): void;
  /** Drop every entry whose key starts with `${agentId}@`. Used by the
   *  post-receive hook to invalidate an agent's cached snapshots after a
   *  push, without touching other agents' entries. */
  invalidateAgent(agentId: string): number;
  clear(): void;
  size(): number;
}

export interface SnapshotCacheOptions {
  maxEntries: number;
}

export function createSnapshotCache<V>(opts: SnapshotCacheOptions): SnapshotCache<V> {
  if (opts.maxEntries <= 0) {
    throw new Error(`snapshot cache maxEntries must be positive, got ${opts.maxEntries}`);
  }
  const store = new Map<string, V>();

  return {
    get(key) {
      if (!store.has(key)) return undefined;
      const v = store.get(key)!;
      // Refresh LRU ordering — delete and re-insert moves to the end.
      store.delete(key);
      store.set(key, v);
      return v;
    },
    put(key, value) {
      if (store.has(key)) {
        store.delete(key);
      }
      store.set(key, value);
      while (store.size > opts.maxEntries) {
        const oldest = store.keys().next().value;
        if (oldest === undefined) break;
        store.delete(oldest);
      }
    },
    invalidateAgent(agentId) {
      const prefix = `${agentId}@`;
      let removed = 0;
      for (const key of [...store.keys()]) {
        if (key.startsWith(prefix)) {
          store.delete(key);
          removed += 1;
        }
      }
      return removed;
    },
    clear() {
      store.clear();
    },
    size() {
      return store.size;
    },
  };
}
