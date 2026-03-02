import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ConversationStore } from '../src/conversation-store.js';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

describe('ConversationStore — summary support', () => {
  let dbPath: string;
  let store: ConversationStore;

  beforeEach(async () => {
    dbPath = join(tmpdir(), `ax-conv-summary-test-${randomUUID()}.db`);
    store = await ConversationStore.create(dbPath);
  });

  afterEach(() => {
    store.close();
    rmSync(dbPath, { force: true });
    rmSync(dbPath + '-wal', { force: true });
    rmSync(dbPath + '-shm', { force: true });
  });

  describe('loadOlderTurns', () => {
    it('returns empty when fewer turns than keepRecent', () => {
      store.append('sess1', 'user', 'hello');
      store.append('sess1', 'assistant', 'hi');
      const older = store.loadOlderTurns('sess1', 10);
      expect(older).toEqual([]);
    });

    it('returns turns older than the last keepRecent', () => {
      for (let i = 0; i < 10; i++) {
        store.append('sess1', 'user', `msg${i}`);
      }
      const older = store.loadOlderTurns('sess1', 4);
      expect(older).toHaveLength(6);
      expect(older[0].content).toBe('msg0');
      expect(older[5].content).toBe('msg5');
    });

    it('does not affect other sessions', () => {
      for (let i = 0; i < 10; i++) {
        store.append('sess1', 'user', `s1-msg${i}`);
        store.append('sess2', 'user', `s2-msg${i}`);
      }
      const older = store.loadOlderTurns('sess1', 4);
      expect(older).toHaveLength(6);
      expect(older.every(t => t.session_id === 'sess1')).toBe(true);
    });
  });

  describe('replaceTurnsWithSummary', () => {
    it('replaces old turns with a summary pair', () => {
      for (let i = 0; i < 10; i++) {
        store.append('sess1', 'user', `msg${i}`);
      }
      const allBefore = store.load('sess1');
      const fifthId = allBefore[4].id; // id of msg4

      store.replaceTurnsWithSummary('sess1', fifthId, '[Summary of 5 messages]');

      const allAfter = store.load('sess1');
      // 5 old turns deleted, 2 summary turns inserted, 5 recent turns kept = 7 total
      expect(allAfter).toHaveLength(7);

      // First two turns should be summary turns
      expect(allAfter[0].is_summary).toBe(1);
      expect(allAfter[0].role).toBe('user');
      expect(allAfter[0].content).toContain('[Summary of 5 messages]');
      expect(allAfter[0].summarized_up_to).toBe(fifthId);

      expect(allAfter[1].is_summary).toBe(1);
      expect(allAfter[1].role).toBe('assistant');
      expect(allAfter[1].content).toContain('conversation context');
      expect(allAfter[1].summarized_up_to).toBe(fifthId);

      // Remaining turns are the original recent ones
      expect(allAfter[2].content).toBe('msg5');
      expect(allAfter[6].content).toBe('msg9');
    });

    it('is atomic — all-or-nothing', () => {
      for (let i = 0; i < 5; i++) {
        store.append('sess1', 'user', `msg${i}`);
      }
      const all = store.load('sess1');
      const thirdId = all[2].id;

      store.replaceTurnsWithSummary('sess1', thirdId, 'Summary');

      // 3 deleted + 2 inserted + 2 remaining = 4
      expect(store.count('sess1')).toBe(4);
    });

    it('does not affect other sessions', () => {
      for (let i = 0; i < 5; i++) {
        store.append('sess1', 'user', `s1-msg${i}`);
        store.append('sess2', 'user', `s2-msg${i}`);
      }
      const sess1Turns = store.load('sess1');
      store.replaceTurnsWithSummary('sess1', sess1Turns[2].id, 'Summary');

      expect(store.count('sess2')).toBe(5);
      const s2turns = store.load('sess2');
      expect(s2turns.every(t => t.content.startsWith('s2-'))).toBe(true);
    });

    it('can summarize summaries (recursive summarization)', () => {
      // First round: create 20 turns, summarize first 14
      for (let i = 0; i < 20; i++) {
        store.append('sess1', 'user', `msg${i}`);
      }
      let all = store.load('sess1');
      store.replaceTurnsWithSummary('sess1', all[13].id, '[Round 1 summary of 14 messages]');

      // After first summarization: 2 summary + 6 recent = 8
      expect(store.count('sess1')).toBe(8);

      // Second round: add more turns, then summarize again
      for (let i = 20; i < 40; i++) {
        store.append('sess1', 'user', `msg${i}`);
      }
      // Now have 8 + 20 = 28 turns
      expect(store.count('sess1')).toBe(28);

      // Summarize older turns, keeping last 6
      const olderTurns = store.loadOlderTurns('sess1', 6);
      expect(olderTurns.length).toBeGreaterThan(0);
      const maxOldId = olderTurns[olderTurns.length - 1].id;

      store.replaceTurnsWithSummary('sess1', maxOldId, '[Round 2 summary including prior summary]');

      const final = store.load('sess1');
      // 2 new summary turns + 6 recent = 8
      expect(final).toHaveLength(8);
      expect(final[0].is_summary).toBe(1);
      expect(final[0].content).toContain('Round 2');
    });
  });

  describe('is_summary column', () => {
    it('regular turns have is_summary=0', () => {
      store.append('sess1', 'user', 'hello');
      const turns = store.load('sess1');
      expect(turns[0].is_summary).toBe(0);
      expect(turns[0].summarized_up_to).toBeNull();
    });
  });
});
