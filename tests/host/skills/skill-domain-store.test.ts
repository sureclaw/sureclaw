import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import { runMigrations } from '../../../src/utils/migrator.js';
import { skillsMigrations } from '../../../src/migrations/skills.js';
import { createSkillDomainStore } from '../../../src/host/skills/skill-domain-store.js';

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

describe('SkillDomainStore', () => {
  let handles: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    for (const h of handles) await h.close();
    handles = [];
  });

  async function freshStore() {
    const h = await makeDb();
    handles.push(h);
    return { store: createSkillDomainStore(h.db), db: h.db };
  }

  it('approve inserts a row', async () => {
    const { store, db } = await freshStore();
    await store.approve({
      agentId: 'agent-1', skillName: 'weather', domain: 'api.weather.com',
    });
    const row = await db
      .selectFrom('skill_domain_approvals')
      .selectAll()
      .where('agent_id', '=', 'agent-1')
      .where('skill_name', '=', 'weather')
      .where('domain', '=', 'api.weather.com')
      .executeTakeFirstOrThrow();
    expect(row.domain).toBe('api.weather.com');
    expect(row.approved_at).toBeDefined();
  });

  it('repeat approve is idempotent — no error, no duplicate row', async () => {
    const { store, db } = await freshStore();
    await store.approve({ agentId: 'a', skillName: 's', domain: 'example.com' });
    await store.approve({ agentId: 'a', skillName: 's', domain: 'example.com' });
    await store.approve({ agentId: 'a', skillName: 's', domain: 'example.com' });

    const rows = await db
      .selectFrom('skill_domain_approvals')
      .selectAll()
      .where('agent_id', '=', 'a')
      .where('skill_name', '=', 's')
      .where('domain', '=', 'example.com')
      .execute();
    expect(rows.length).toBe(1);
  });

  it('distinct tuples make distinct rows', async () => {
    const { store, db } = await freshStore();
    await store.approve({ agentId: 'a', skillName: 's1', domain: 'x.com' });
    await store.approve({ agentId: 'a', skillName: 's2', domain: 'x.com' });
    await store.approve({ agentId: 'b', skillName: 's1', domain: 'x.com' });
    await store.approve({ agentId: 'a', skillName: 's1', domain: 'y.com' });

    const count = await db
      .selectFrom('skill_domain_approvals')
      .select(db.fn.countAll().as('c'))
      .executeTakeFirstOrThrow();
    expect(Number(count.c)).toBe(4);
  });

  it('deleteForSkill drops every row for (agentId, skillName) and leaves others untouched', async () => {
    const { store, db } = await freshStore();
    await store.approve({ agentId: 'a', skillName: 's1', domain: 'x.com' });
    await store.approve({ agentId: 'a', skillName: 's1', domain: 'y.com' });
    await store.approve({ agentId: 'a', skillName: 's2', domain: 'x.com' });
    await store.approve({ agentId: 'other', skillName: 's1', domain: 'x.com' });

    await store.deleteForSkill('a', 's1');

    const remaining = await db
      .selectFrom('skill_domain_approvals')
      .select(['agent_id', 'skill_name', 'domain'])
      .orderBy('agent_id', 'asc')
      .orderBy('skill_name', 'asc')
      .execute();
    expect(remaining).toEqual([
      { agent_id: 'a', skill_name: 's2', domain: 'x.com' },
      { agent_id: 'other', skill_name: 's1', domain: 'x.com' },
    ]);
  });

  it('deleteForSkill is idempotent when no rows match', async () => {
    const { store } = await freshStore();
    await expect(store.deleteForSkill('nobody', 'none')).resolves.toBeUndefined();
  });

  it('listForAgent returns every (skill_name, domain) pair for the agent and only that agent', async () => {
    const { store } = await freshStore();
    await store.approve({ agentId: 'a', skillName: 's1', domain: 'x.com' });
    await store.approve({ agentId: 'a', skillName: 's2', domain: 'x.com' });
    await store.approve({ agentId: 'a', skillName: 's1', domain: 'y.com' });
    await store.approve({ agentId: 'b', skillName: 's1', domain: 'z.com' });

    const aRows = (await store.listForAgent('a')).sort((x, y) =>
      x.skillName === y.skillName
        ? x.domain.localeCompare(y.domain)
        : x.skillName.localeCompare(y.skillName),
    );
    expect(aRows).toEqual([
      { skillName: 's1', domain: 'x.com' },
      { skillName: 's1', domain: 'y.com' },
      { skillName: 's2', domain: 'x.com' },
    ]);

    const bRows = await store.listForAgent('b');
    expect(bRows).toEqual([{ skillName: 's1', domain: 'z.com' }]);

    const cRows = await store.listForAgent('c');
    expect(cRows).toEqual([]);
  });
});
