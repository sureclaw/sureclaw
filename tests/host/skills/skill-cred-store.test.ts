import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import { runMigrations } from '../../../src/utils/migrator.js';
import { skillsMigrations } from '../../../src/migrations/skills.js';
import { createSkillCredStore } from '../../../src/host/skills/skill-cred-store.js';

async function makeDb() {
  const sqliteDb = new Database(':memory:');
  const db = new Kysely<any>({ dialect: new SqliteDialect({ database: sqliteDb }) });
  const result = await runMigrations(db, skillsMigrations, 'skills_migration');
  if (result.error) throw result.error;
  return {
    db,
    close: async () => { await db.destroy(); },
  };
}

describe('SkillCredStore', () => {
  let handles: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    for (const h of handles) await h.close();
    handles = [];
  });

  async function freshStore() {
    const h = await makeDb();
    handles.push(h);
    return { store: createSkillCredStore(h.db, 'sqlite'), db: h.db };
  }

  it('put inserts a new row', async () => {
    const { store, db } = await freshStore();
    await store.put({
      agentId: 'agent-1',
      skillName: 'weather',
      envName: 'W_KEY',
      userId: 'alice',
      value: 'secret-alice',
    });
    const row = await db
      .selectFrom('skill_credentials')
      .select(['value'])
      .where('agent_id', '=', 'agent-1')
      .where('skill_name', '=', 'weather')
      .where('env_name', '=', 'W_KEY')
      .where('user_id', '=', 'alice')
      .executeTakeFirstOrThrow();
    expect(row.value).toBe('secret-alice');
  });

  it('put with same tuple updates the value (upsert, not error)', async () => {
    const { store, db } = await freshStore();
    await store.put({
      agentId: 'agent-1', skillName: 'weather', envName: 'W_KEY', userId: 'alice', value: 'v1',
    });
    await store.put({
      agentId: 'agent-1', skillName: 'weather', envName: 'W_KEY', userId: 'alice', value: 'v2',
    });

    const rows = await db
      .selectFrom('skill_credentials')
      .select(['value'])
      .where('agent_id', '=', 'agent-1')
      .where('skill_name', '=', 'weather')
      .where('env_name', '=', 'W_KEY')
      .where('user_id', '=', 'alice')
      .execute();
    expect(rows.length).toBe(1);
    expect(rows[0].value).toBe('v2');
  });

  it('different user_id values are distinct rows', async () => {
    const { store, db } = await freshStore();
    await store.put({
      agentId: 'agent-1', skillName: 'weather', envName: 'W_KEY', userId: 'alice', value: 'a',
    });
    await store.put({
      agentId: 'agent-1', skillName: 'weather', envName: 'W_KEY', userId: 'bob', value: 'b',
    });
    const rows = await db
      .selectFrom('skill_credentials')
      .select(['user_id', 'value'])
      .where('agent_id', '=', 'agent-1')
      .where('skill_name', '=', 'weather')
      .where('env_name', '=', 'W_KEY')
      .orderBy('user_id', 'asc')
      .execute();
    expect(rows.length).toBe(2);
    expect(rows[0]).toEqual({ user_id: 'alice', value: 'a' });
    expect(rows[1]).toEqual({ user_id: 'bob', value: 'b' });
  });

  it('empty-string user_id sentinel co-exists alongside a real userId', async () => {
    const { store, db } = await freshStore();
    await store.put({
      agentId: 'agent-1', skillName: 'weather', envName: 'W_KEY', userId: '', value: 'shared',
    });
    await store.put({
      agentId: 'agent-1', skillName: 'weather', envName: 'W_KEY', userId: 'alice', value: 'mine',
    });
    const rows = await db
      .selectFrom('skill_credentials')
      .select(['user_id', 'value'])
      .where('agent_id', '=', 'agent-1')
      .where('skill_name', '=', 'weather')
      .where('env_name', '=', 'W_KEY')
      .orderBy('user_id', 'asc')
      .execute();
    expect(rows.length).toBe(2);
    expect(rows[0]).toEqual({ user_id: '', value: 'shared' });
    expect(rows[1]).toEqual({ user_id: 'alice', value: 'mine' });
  });

  it('updates updated_at on conflict, preserves created_at', async () => {
    const { store, db } = await freshStore();
    await store.put({
      agentId: 'a', skillName: 's', envName: 'E', userId: '', value: 'v1',
    });
    const before = await db
      .selectFrom('skill_credentials')
      .select(['created_at', 'updated_at'])
      .where('agent_id', '=', 'a')
      .executeTakeFirstOrThrow();

    await store.put({
      agentId: 'a', skillName: 's', envName: 'E', userId: '', value: 'v2',
    });
    const after = await db
      .selectFrom('skill_credentials')
      .select(['created_at', 'updated_at', 'value'])
      .where('agent_id', '=', 'a')
      .executeTakeFirstOrThrow();

    expect(after.value).toBe('v2');
    expect(after.created_at).toBe(before.created_at);
    expect(Number(after.updated_at)).toBeGreaterThanOrEqual(Number(before.updated_at));
  });

  describe('get', () => {
    it('returns null when no row matches', async () => {
      const { store } = await freshStore();
      const v = await store.get({
        agentId: 'a', skillName: 's', envName: 'MISSING', userId: 'alice',
      });
      expect(v).toBeNull();
    });

    it('returns the user-scoped value when user_id matches exactly', async () => {
      const { store } = await freshStore();
      await store.put({
        agentId: 'a', skillName: 's', envName: 'K', userId: 'alice', value: 'alice-val',
      });
      const v = await store.get({
        agentId: 'a', skillName: 's', envName: 'K', userId: 'alice',
      });
      expect(v).toBe('alice-val');
    });

    it('falls back to the empty-string (agent-scope) row when no user-scoped row exists', async () => {
      const { store } = await freshStore();
      await store.put({
        agentId: 'a', skillName: 's', envName: 'K', userId: '', value: 'shared',
      });
      const v = await store.get({
        agentId: 'a', skillName: 's', envName: 'K', userId: 'alice',
      });
      expect(v).toBe('shared');
    });

    it('prefers the user_id match when BOTH user-scoped and agent-scoped rows exist', async () => {
      const { store } = await freshStore();
      await store.put({
        agentId: 'a', skillName: 's', envName: 'K', userId: '', value: 'shared',
      });
      await store.put({
        agentId: 'a', skillName: 's', envName: 'K', userId: 'alice', value: 'alice-val',
      });
      const v = await store.get({
        agentId: 'a', skillName: 's', envName: 'K', userId: 'alice',
      });
      expect(v).toBe('alice-val');
    });

    it('ignores other users\' rows when a user_id is provided', async () => {
      const { store } = await freshStore();
      await store.put({
        agentId: 'a', skillName: 's', envName: 'K', userId: 'bob', value: 'bob-val',
      });
      const v = await store.get({
        agentId: 'a', skillName: 's', envName: 'K', userId: 'alice',
      });
      // Bob's row must not leak to Alice; only user_id='alice' or '' are candidates.
      expect(v).toBeNull();
    });

    it('scopes by (agentId, skillName, envName) — does not leak across skills', async () => {
      const { store } = await freshStore();
      await store.put({
        agentId: 'a', skillName: 's1', envName: 'K', userId: '', value: 'skill1',
      });
      const v = await store.get({
        agentId: 'a', skillName: 's2', envName: 'K', userId: '',
      });
      expect(v).toBeNull();
    });
  });

  describe('listForAgent', () => {
    it('returns every row for the agent, across skills/users', async () => {
      const { store } = await freshStore();
      await store.put({
        agentId: 'a', skillName: 's1', envName: 'K1', userId: '', value: 'v1',
      });
      await store.put({
        agentId: 'a', skillName: 's1', envName: 'K2', userId: 'alice', value: 'v2',
      });
      await store.put({
        agentId: 'a', skillName: 's2', envName: 'K3', userId: 'bob', value: 'v3',
      });
      await store.put({
        agentId: 'other', skillName: 's1', envName: 'OTHER', userId: '', value: 'x',
      });
      const rows = await store.listForAgent('a');
      const sorted = [...rows].sort((x, y) => x.envName.localeCompare(y.envName));
      expect(sorted).toEqual([
        { skillName: 's1', envName: 'K1', userId: '', value: 'v1' },
        { skillName: 's1', envName: 'K2', userId: 'alice', value: 'v2' },
        { skillName: 's2', envName: 'K3', userId: 'bob', value: 'v3' },
      ]);
    });

    it('returns empty array when the agent has no rows', async () => {
      const { store } = await freshStore();
      const rows = await store.listForAgent('nobody');
      expect(rows).toEqual([]);
    });
  });

  describe('deleteForSkill', () => {
    it('drops every row for (agentId, skillName) but leaves other skills and other agents untouched', async () => {
      const { store, db } = await freshStore();
      await store.put({ agentId: 'a', skillName: 's1', envName: 'K1', userId: '', value: 'v1' });
      await store.put({ agentId: 'a', skillName: 's1', envName: 'K1', userId: 'alice', value: 'v1u' });
      await store.put({ agentId: 'a', skillName: 's2', envName: 'K2', userId: '', value: 'v2' });
      await store.put({ agentId: 'other', skillName: 's1', envName: 'K1', userId: '', value: 'x' });

      await store.deleteForSkill('a', 's1');

      const remaining = await db
        .selectFrom('skill_credentials')
        .select(['agent_id', 'skill_name', 'value'])
        .orderBy('agent_id', 'asc')
        .orderBy('skill_name', 'asc')
        .execute();
      expect(remaining).toEqual([
        { agent_id: 'a', skill_name: 's2', value: 'v2' },
        { agent_id: 'other', skill_name: 's1', value: 'x' },
      ]);
    });

    it('is idempotent when no matching rows exist', async () => {
      const { store } = await freshStore();
      await expect(store.deleteForSkill('nobody', 'none')).resolves.toBeUndefined();
    });
  });

  describe('listEnvNames', () => {
    it('returns every distinct envName for the agent', async () => {
      const { store } = await freshStore();
      await store.put({
        agentId: 'a', skillName: 's1', envName: 'K1', userId: '', value: 'v1',
      });
      await store.put({
        agentId: 'a', skillName: 's1', envName: 'K1', userId: 'alice', value: 'v1-alice',
      });
      await store.put({
        agentId: 'a', skillName: 's2', envName: 'K2', userId: 'bob', value: 'v2',
      });
      const names = await store.listEnvNames('a');
      expect([...names].sort()).toEqual(['K1', 'K2']);
    });

    it('returns an empty set for an agent with no rows', async () => {
      const { store } = await freshStore();
      const names = await store.listEnvNames('nobody');
      expect([...names]).toEqual([]);
    });
  });
});
