import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect, sql } from 'kysely';
import { runMigrations } from '../../src/utils/migrator.js';
import { skillsMigrations } from '../../src/migrations/skills.js';

function createTestDb(): Kysely<any> {
  return new Kysely({
    dialect: new SqliteDialect({ database: new Database(':memory:') }),
  });
}

describe('skills migrations', () => {
  let db: Kysely<any>;
  afterEach(async () => {
    await db?.destroy();
  });

  it('applies cleanly from scratch', async () => {
    db = createTestDb();
    const result = await runMigrations(db, skillsMigrations, 'skills_migration');
    expect(result.error).toBeUndefined();
    expect(result.applied).toBeGreaterThanOrEqual(3);
    expect(result.names).toContain('skills_001_initial');
    expect(result.names).toContain('skills_002_tuple_tables');
    expect(result.names).toContain('skills_003_drop_retired_tables');
  });

  it('is idempotent (re-running applies nothing new)', async () => {
    db = createTestDb();
    await runMigrations(db, skillsMigrations, 'skills_migration');
    const second = await runMigrations(db, skillsMigrations, 'skills_migration');
    expect(second.error).toBeUndefined();
    expect(second.applied).toBe(0);
  });

  describe('skills_003_drop_retired_tables', () => {
    it('drops skill_states and skill_setup_queue tables', async () => {
      db = createTestDb();
      await runMigrations(db, skillsMigrations, 'skills_migration');

      const tables = await sql<{ name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table'
      `.execute(db);
      const names = tables.rows.map(r => r.name);
      expect(names).not.toContain('skill_states');
      expect(names).not.toContain('skill_setup_queue');
    });

    it('is idempotent — running on a schema without the retired tables is a no-op', async () => {
      db = createTestDb();
      // First run applies all migrations.
      const first = await runMigrations(db, skillsMigrations, 'skills_migration');
      expect(first.error).toBeUndefined();

      // Second run must not re-apply the drop migration. The
      // `ifExists()` guard on the drop statements + the migrator's
      // applied-migration tracking both contribute.
      const second = await runMigrations(db, skillsMigrations, 'skills_migration');
      expect(second.error).toBeUndefined();
      expect(second.applied).toBe(0);
    });

    it('leaves skill_credentials + skill_domain_approvals intact', async () => {
      db = createTestDb();
      await runMigrations(db, skillsMigrations, 'skills_migration');

      const tables = await sql<{ name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table'
      `.execute(db);
      const names = tables.rows.map(r => r.name);
      expect(names).toContain('skill_credentials');
      expect(names).toContain('skill_domain_approvals');
    });
  });

  describe('skill_credentials', () => {
    it('inserts a row with all columns populated and reads it back', async () => {
      db = createTestDb();
      await runMigrations(db, skillsMigrations, 'skills_migration');

      await db
        .insertInto('skill_credentials')
        .values({
          agent_id: 'agent-1',
          skill_name: 'weather',
          env_name: 'W_KEY',
          user_id: 'alice',
          value: 'secret-alice',
        })
        .execute();

      const row = await db
        .selectFrom('skill_credentials')
        .selectAll()
        .where('agent_id', '=', 'agent-1')
        .where('skill_name', '=', 'weather')
        .where('env_name', '=', 'W_KEY')
        .where('user_id', '=', 'alice')
        .executeTakeFirstOrThrow();

      expect(row.value).toBe('secret-alice');
      expect(row.created_at).toBeDefined();
      expect(row.updated_at).toBeDefined();
    });

    it('treats empty-string user_id as the agent-scope sentinel, distinct from a real userId', async () => {
      db = createTestDb();
      await runMigrations(db, skillsMigrations, 'skills_migration');

      await db
        .insertInto('skill_credentials')
        .values([
          {
            agent_id: 'agent-1',
            skill_name: 'weather',
            env_name: 'W_KEY',
            user_id: '',
            value: 'agent-scoped',
          },
          {
            agent_id: 'agent-1',
            skill_name: 'weather',
            env_name: 'W_KEY',
            user_id: 'alice',
            value: 'alice-scoped',
          },
        ])
        .execute();

      const rows = await db
        .selectFrom('skill_credentials')
        .select(['user_id', 'value'])
        .where('agent_id', '=', 'agent-1')
        .where('skill_name', '=', 'weather')
        .where('env_name', '=', 'W_KEY')
        .orderBy('user_id', 'asc')
        .execute();

      expect(rows.length).toBe(2);
      expect(rows[0].user_id).toBe('');
      expect(rows[0].value).toBe('agent-scoped');
      expect(rows[1].user_id).toBe('alice');
      expect(rows[1].value).toBe('alice-scoped');
    });

    it('rejects duplicate inserts on the full PK tuple', async () => {
      db = createTestDb();
      await runMigrations(db, skillsMigrations, 'skills_migration');

      await db
        .insertInto('skill_credentials')
        .values({
          agent_id: 'agent-1',
          skill_name: 'weather',
          env_name: 'W_KEY',
          user_id: 'alice',
          value: 'v1',
        })
        .execute();

      await expect(
        db
          .insertInto('skill_credentials')
          .values({
            agent_id: 'agent-1',
            skill_name: 'weather',
            env_name: 'W_KEY',
            user_id: 'alice',
            value: 'v2',
          })
          .execute(),
      ).rejects.toThrow();
    });

    it('allows rows with the same envName but different user_id / skill_name / agent_id', async () => {
      db = createTestDb();
      await runMigrations(db, skillsMigrations, 'skills_migration');

      await db
        .insertInto('skill_credentials')
        .values([
          { agent_id: 'agent-1', skill_name: 'weather', env_name: 'K', user_id: 'alice', value: '1' },
          { agent_id: 'agent-1', skill_name: 'weather', env_name: 'K', user_id: 'bob', value: '2' },
          { agent_id: 'agent-1', skill_name: 'other', env_name: 'K', user_id: 'alice', value: '3' },
          { agent_id: 'agent-2', skill_name: 'weather', env_name: 'K', user_id: 'alice', value: '4' },
        ])
        .execute();

      const count = await db
        .selectFrom('skill_credentials')
        .select(db.fn.countAll().as('c'))
        .executeTakeFirstOrThrow();
      expect(Number(count.c)).toBe(4);
    });
  });

  describe('skill_domain_approvals', () => {
    it('inserts a row and reads it back', async () => {
      db = createTestDb();
      await runMigrations(db, skillsMigrations, 'skills_migration');

      await db
        .insertInto('skill_domain_approvals')
        .values({
          agent_id: 'agent-1',
          skill_name: 'weather',
          domain: 'api.weather.com',
        })
        .execute();

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

    it('rejects duplicate inserts on the full PK tuple', async () => {
      db = createTestDb();
      await runMigrations(db, skillsMigrations, 'skills_migration');

      await db
        .insertInto('skill_domain_approvals')
        .values({ agent_id: 'agent-1', skill_name: 'weather', domain: 'api.weather.com' })
        .execute();

      await expect(
        db
          .insertInto('skill_domain_approvals')
          .values({ agent_id: 'agent-1', skill_name: 'weather', domain: 'api.weather.com' })
          .execute(),
      ).rejects.toThrow();
    });

    it('allows the same domain for different skills on the same agent', async () => {
      db = createTestDb();
      await runMigrations(db, skillsMigrations, 'skills_migration');

      await db
        .insertInto('skill_domain_approvals')
        .values([
          { agent_id: 'agent-1', skill_name: 'weather', domain: 'api.example.com' },
          { agent_id: 'agent-1', skill_name: 'other', domain: 'api.example.com' },
        ])
        .execute();

      const count = await db
        .selectFrom('skill_domain_approvals')
        .select(db.fn.countAll().as('c'))
        .executeTakeFirstOrThrow();
      expect(Number(count.c)).toBe(2);
    });
  });

  describe('indexes', () => {
    it('creates (agent_id, skill_name) indexes on both new tables', async () => {
      db = createTestDb();
      await runMigrations(db, skillsMigrations, 'skills_migration');

      const idx = await sql<{ name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'index'
      `.execute(db);

      const names = idx.rows.map(r => r.name);
      expect(names).toContain('idx_skill_credentials_agent_skill');
      expect(names).toContain('idx_skill_domain_approvals_agent_skill');
    });
  });
});
