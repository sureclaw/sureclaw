import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { create } from '../../../src/providers/storage/database.js';
import { create as createSqliteDb } from '../../../src/providers/database/sqlite.js';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { StorageProvider } from '../../../src/providers/storage/types.js';
import type { DatabaseProvider } from '../../../src/providers/database/types.js';
import type { Config } from '../../../src/types.js';

const config = {} as Config;

describe('storage/database', () => {
  let storage: StorageProvider;
  let database: DatabaseProvider;
  let testHome: string;

  beforeEach(async () => {
    testHome = join(tmpdir(), `ax-storage-db-test-${randomUUID()}`);
    mkdirSync(testHome, { recursive: true });
    process.env.AX_HOME = testHome;
    database = await createSqliteDb(config);
    storage = await create(config, 'database', { database });
  });

  afterEach(async () => {
    try { storage.close(); } catch {}
    try { await database.close(); } catch {}
    try { rmSync(testHome, { recursive: true, force: true }); } catch {}
    delete process.env.AX_HOME;
  });

  // ── Provider structure ──

  test('exposes messages, conversations, sessions, documents sub-stores', () => {
    expect(storage.messages).toBeDefined();
    expect(storage.conversations).toBeDefined();
    expect(storage.sessions).toBeDefined();
    expect(storage.documents).toBeDefined();
  });

  // ── MessageQueue ──

  test('messages: enqueue and dequeue', async () => {
    const id = await storage.messages.enqueue({
      sessionId: 's1', channel: 'cli', sender: 'user', content: 'hello',
    });
    expect(id).toMatch(/^[a-f0-9-]{36}$/);

    const msg = await storage.messages.dequeue();
    expect(msg).not.toBeNull();
    expect(msg!.content).toBe('hello');
    expect(msg!.status).toBe('processing');
  });

  test('messages: pending count', async () => {
    expect(await storage.messages.pending()).toBe(0);
    await storage.messages.enqueue({
      sessionId: 's1', channel: 'cli', sender: 'user', content: 'a',
    });
    expect(await storage.messages.pending()).toBe(1);
  });

  test('messages: dequeueById', async () => {
    const id = await storage.messages.enqueue({
      sessionId: 's1', channel: 'cli', sender: 'user', content: 'target',
    });
    const msg = await storage.messages.dequeueById(id);
    expect(msg).not.toBeNull();
    expect(msg!.id).toBe(id);
    expect(msg!.content).toBe('target');
  });

  test('messages: complete and fail', async () => {
    const id = await storage.messages.enqueue({
      sessionId: 's1', channel: 'cli', sender: 'user', content: 'x',
    });
    await storage.messages.dequeue();
    await storage.messages.complete(id);
    expect(await storage.messages.pending()).toBe(0);
  });

  // ── ConversationStore ──

  test('conversations: append and load', async () => {
    await storage.conversations.append('s1', 'user', 'hello');
    await storage.conversations.append('s1', 'assistant', 'hi there');
    const turns = await storage.conversations.load('s1');
    expect(turns.length).toBe(2);
    expect(turns[0].content).toBe('hello');
    expect(turns[1].content).toBe('hi there');
  });

  test('conversations: count', async () => {
    expect(await storage.conversations.count('s1')).toBe(0);
    await storage.conversations.append('s1', 'user', 'a');
    expect(await storage.conversations.count('s1')).toBe(1);
  });

  test('conversations: clear', async () => {
    await storage.conversations.append('s1', 'user', 'a');
    await storage.conversations.clear('s1');
    expect(await storage.conversations.count('s1')).toBe(0);
  });

  test('conversations: load with maxTurns', async () => {
    await storage.conversations.append('s1', 'user', 'a');
    await storage.conversations.append('s1', 'assistant', 'b');
    await storage.conversations.append('s1', 'user', 'c');
    const turns = await storage.conversations.load('s1', 2);
    expect(turns.length).toBe(2);
    expect(turns[0].content).toBe('b');
    expect(turns[1].content).toBe('c');
  });

  test('conversations: prune', async () => {
    await storage.conversations.append('s1', 'user', 'a');
    await storage.conversations.append('s1', 'assistant', 'b');
    await storage.conversations.append('s1', 'user', 'c');
    await storage.conversations.prune('s1', 1);
    const turns = await storage.conversations.load('s1');
    expect(turns.length).toBe(1);
    expect(turns[0].content).toBe('c');
  });

  test('conversations: replaceTurnsWithSummary', async () => {
    await storage.conversations.append('s1', 'user', 'old1');
    await storage.conversations.append('s1', 'assistant', 'old2');
    await storage.conversations.append('s1', 'user', 'new1');

    const turns = await storage.conversations.load('s1');
    const maxIdToReplace = turns[1].id;

    await storage.conversations.replaceTurnsWithSummary('s1', maxIdToReplace, 'Summary of old stuff');

    const updated = await storage.conversations.load('s1');
    expect(updated.length).toBe(3); // 2 summary + 1 remaining
    expect(updated[0].is_summary).toBe(1);
    expect(updated[0].content).toBe('Summary of old stuff');
    expect(updated[2].content).toBe('new1');
  });

  // ── SessionStore ──

  test('sessions: trackSession and getLastChannelSession', async () => {
    await storage.sessions.trackSession('agent-1', {
      provider: 'slack',
      scope: 'dm',
      identifiers: { peer: 'U123' },
    });

    const session = await storage.sessions.getLastChannelSession('agent-1');
    expect(session).toBeDefined();
    expect(session!.provider).toBe('slack');
    expect(session!.scope).toBe('dm');
    expect(session!.identifiers.peer).toBe('U123');
  });

  test('sessions: returns undefined for unknown agent', async () => {
    const session = await storage.sessions.getLastChannelSession('nonexistent');
    expect(session).toBeUndefined();
  });

  // ── DocumentStore ──

  test('documents: put and get', async () => {
    await storage.documents.put('config', 'key1', 'value1');
    const val = await storage.documents.get('config', 'key1');
    expect(val).toBe('value1');
  });

  test('documents: get returns undefined for missing', async () => {
    const val = await storage.documents.get('config', 'missing');
    expect(val).toBeUndefined();
  });

  test('documents: delete', async () => {
    await storage.documents.put('config', 'key1', 'value1');
    const deleted = await storage.documents.delete('config', 'key1');
    expect(deleted).toBe(true);
    const val = await storage.documents.get('config', 'key1');
    expect(val).toBeUndefined();
  });

  test('documents: list', async () => {
    await storage.documents.put('skills', 'a', 'x');
    await storage.documents.put('skills', 'b', 'y');
    const keys = await storage.documents.list('skills');
    expect(keys).toEqual(['a', 'b']);
  });

  // ── Error case ──

  test('throws when no database provider given', async () => {
    await expect(create(config, 'database'))
      .rejects.toThrow('storage/database requires a database provider');
  });
});
