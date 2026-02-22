import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ConversationStore } from '../src/conversation-store.js';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

describe('ConversationStore', () => {
  let dbPath: string;
  let store: ConversationStore;

  beforeEach(async () => {
    dbPath = join(tmpdir(), `ax-conv-test-${randomUUID()}.db`);
    store = await ConversationStore.create(dbPath);
  });

  afterEach(() => {
    store.close();
    rmSync(dbPath, { force: true });
    rmSync(dbPath + '-wal', { force: true });
    rmSync(dbPath + '-shm', { force: true });
  });

  it('stores and retrieves turns for a session', () => {
    store.append('sess1', 'user', 'hello', 'U123');
    store.append('sess1', 'assistant', 'hi there');
    const turns = store.load('sess1');
    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({ role: 'user', content: 'hello', sender: 'U123' });
    expect(turns[1]).toMatchObject({ role: 'assistant', content: 'hi there', sender: null });
  });

  it('isolates sessions', () => {
    store.append('sess1', 'user', 'msg1');
    store.append('sess2', 'user', 'msg2');
    expect(store.load('sess1')).toHaveLength(1);
    expect(store.load('sess2')).toHaveLength(1);
  });

  it('returns empty array for unknown session', () => {
    expect(store.load('nonexistent')).toEqual([]);
  });

  it('respects maxTurns limit', () => {
    for (let i = 0; i < 10; i++) {
      store.append('sess1', 'user', `msg${i}`);
    }
    const turns = store.load('sess1', 5);
    expect(turns).toHaveLength(5);
    // Should return the LAST 5 turns
    expect(turns[0].content).toBe('msg5');
    expect(turns[4].content).toBe('msg9');
  });

  it('prunes old turns beyond maxTurns on append', () => {
    for (let i = 0; i < 100; i++) {
      store.append('sess1', 'user', `msg${i}`);
    }
    store.prune('sess1', 50);
    // After pruning to 50, should only have the last 50
    const all = store.load('sess1');
    expect(all).toHaveLength(50);
    expect(all[0].content).toBe('msg50');
  });

  it('clears a session', () => {
    store.append('sess1', 'user', 'hello');
    store.clear('sess1');
    expect(store.load('sess1')).toEqual([]);
  });

  it('returns empty array when maxTurns is 0', () => {
    store.append('sess1', 'user', 'hello');
    store.append('sess1', 'assistant', 'world');
    expect(store.load('sess1', 0)).toEqual([]);
  });

  it('prune on nonexistent session does not throw', () => {
    expect(() => store.prune('nonexistent', 10)).not.toThrow();
  });

  it('prune does not affect other sessions', () => {
    for (let i = 0; i < 10; i++) {
      store.append('sess1', 'user', `msg${i}`);
      store.append('sess2', 'user', `other${i}`);
    }
    store.prune('sess1', 3);
    expect(store.load('sess1')).toHaveLength(3);
    expect(store.load('sess2')).toHaveLength(10);
  });

  it('count returns number of turns for a session', () => {
    expect(store.count('sess1')).toBe(0);
    store.append('sess1', 'user', 'hello');
    store.append('sess1', 'assistant', 'world');
    expect(store.count('sess1')).toBe(2);
    // Other session unaffected
    expect(store.count('sess2')).toBe(0);
  });

  it('clear does not affect other sessions', () => {
    store.append('sess1', 'user', 'hello');
    store.append('sess2', 'user', 'world');
    store.clear('sess1');
    expect(store.load('sess1')).toEqual([]);
    expect(store.load('sess2')).toHaveLength(1);
  });
});
