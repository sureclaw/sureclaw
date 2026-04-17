import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import { runMigrations } from '../../../src/utils/migrator.js';
import { skillsMigrations } from '../../../src/migrations/skills.js';
import { createSkillStateStore } from '../../../src/host/skills/state-store.js';
import type { SkillState, SetupRequest } from '../../../src/host/skills/types.js';

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

describe('SkillStateStore', () => {
  let handles: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    for (const h of handles) await h.close();
    handles = [];
  });

  async function freshStore() {
    const h = await makeDb();
    handles.push(h);
    return { store: createSkillStateStore(h.db), db: h.db };
  }

  describe('getPriorStates', () => {
    it('returns empty map when agent has no rows', async () => {
      const { store } = await freshStore();
      const prior = await store.getPriorStates('agent-none');
      expect(prior).toBeInstanceOf(Map);
      expect(prior.size).toBe(0);
    });
  });

  describe('putStates + getPriorStates', () => {
    it('round-trips two skills with different kinds', async () => {
      const { store } = await freshStore();
      const states: SkillState[] = [
        {
          name: 'alpha',
          kind: 'enabled',
          description: 'Alpha skill',
        },
        {
          name: 'beta',
          kind: 'pending',
          description: 'Beta skill',
          pendingReasons: ['needs credential: SLACK_TOKEN', 'needs domain: api.slack.com'],
        },
      ];
      await store.putStates('agent-1', states);

      const prior = await store.getPriorStates('agent-1');
      expect(prior.size).toBe(2);
      expect(prior.get('alpha')).toBe('enabled');
      expect(prior.get('beta')).toBe('pending');
    });

    it('is authoritative — replaces prior rows for same agent', async () => {
      const { store } = await freshStore();
      await store.putStates('agent-1', [
        { name: 'alpha', kind: 'enabled', description: 'Alpha' },
        { name: 'beta', kind: 'pending', description: 'Beta' },
      ]);

      // Second call replaces: alpha gone, beta becomes enabled, gamma new
      await store.putStates('agent-1', [
        { name: 'beta', kind: 'enabled', description: 'Beta upgraded' },
        { name: 'gamma', kind: 'invalid', error: 'bad frontmatter' },
      ]);

      const prior = await store.getPriorStates('agent-1');
      expect(prior.size).toBe(2);
      expect(prior.has('alpha')).toBe(false);
      expect(prior.get('beta')).toBe('enabled');
      expect(prior.get('gamma')).toBe('invalid');
    });

    it('empty array clears prior rows for that agent', async () => {
      const { store } = await freshStore();
      await store.putStates('agent-1', [
        { name: 'alpha', kind: 'enabled', description: 'Alpha' },
      ]);

      await store.putStates('agent-1', []);

      const prior = await store.getPriorStates('agent-1');
      expect(prior.size).toBe(0);
    });

    it('does NOT affect rows for other agents', async () => {
      const { store } = await freshStore();
      await store.putStates('agent-1', [
        { name: 'alpha', kind: 'enabled', description: 'Alpha a1' },
      ]);
      await store.putStates('agent-2', [
        { name: 'alpha', kind: 'pending', description: 'Alpha a2' },
        { name: 'beta', kind: 'enabled', description: 'Beta a2' },
      ]);

      // Replace agent-1's states — agent-2 must remain intact
      await store.putStates('agent-1', [
        { name: 'zeta', kind: 'invalid', error: 'oops' },
      ]);

      const prior1 = await store.getPriorStates('agent-1');
      expect(prior1.size).toBe(1);
      expect(prior1.get('zeta')).toBe('invalid');

      const prior2 = await store.getPriorStates('agent-2');
      expect(prior2.size).toBe(2);
      expect(prior2.get('alpha')).toBe('pending');
      expect(prior2.get('beta')).toBe('enabled');
    });

    it('handles skill with pendingReasons (JSON persisted)', async () => {
      const { store, db } = await freshStore();
      await store.putStates('agent-1', [
        {
          name: 'beta',
          kind: 'pending',
          pendingReasons: ['reason-a', 'reason-b'],
          description: 'Beta',
        },
      ]);

      // Verify via raw row that JSON is stored correctly
      const row = await db.selectFrom('skill_states')
        .select(['pending_reasons'])
        .where('agent_id', '=', 'agent-1')
        .where('skill_name', '=', 'beta')
        .executeTakeFirst();
      expect(row).toBeDefined();
      expect(JSON.parse((row as any).pending_reasons)).toEqual(['reason-a', 'reason-b']);

      const prior = await store.getPriorStates('agent-1');
      expect(prior.get('beta')).toBe('pending');
    });
  });

  describe('putSetupQueue + getSetupQueue', () => {
    it('returns empty array when no queue exists', async () => {
      const { store } = await freshStore();
      const q = await store.getSetupQueue('agent-none');
      expect(q).toEqual([]);
    });

    it('round-trips full SetupRequest with nested arrays', async () => {
      const { store } = await freshStore();
      const queue: SetupRequest[] = [
        {
          skillName: 'slack-poster',
          description: 'Post to Slack',
          missingCredentials: [
            {
              envName: 'SLACK_TOKEN',
              authType: 'oauth',
              scope: 'user',
              oauth: {
                provider: 'slack',
                clientId: 'xxx',
                authorizationUrl: 'https://slack.com/oauth/authorize',
                tokenUrl: 'https://slack.com/api/oauth.v2.access',
                scopes: ['chat:write', 'channels:read'],
              },
            },
            {
              envName: 'OTHER_KEY',
              authType: 'api_key',
              scope: 'agent',
            },
          ],
          unapprovedDomains: ['api.slack.com', 'files.slack.com'],
          mcpServers: [{ name: 'slack-mcp', url: 'https://mcp.example/slack' }],
        },
        {
          skillName: 'github-reader',
          description: 'Read GH issues',
          missingCredentials: [],
          unapprovedDomains: [],
          mcpServers: [],
        },
      ];

      await store.putSetupQueue('agent-1', queue);

      const got = await store.getSetupQueue('agent-1');
      // Order by skill_name ascending — deterministic
      const bySkill = new Map(got.map(q => [q.skillName, q]));
      expect(got.length).toBe(2);
      expect(bySkill.get('slack-poster')).toEqual(queue[0]);
      expect(bySkill.get('github-reader')).toEqual(queue[1]);
    });

    it('empty array clears prior queue for that agent only', async () => {
      const { store } = await freshStore();
      await store.putSetupQueue('agent-1', [
        {
          skillName: 'alpha',
          description: 'A',
          missingCredentials: [],
          unapprovedDomains: [],
          mcpServers: [],
        },
      ]);
      await store.putSetupQueue('agent-2', [
        {
          skillName: 'alpha',
          description: 'Other agent',
          missingCredentials: [],
          unapprovedDomains: [],
          mcpServers: [],
        },
      ]);

      await store.putSetupQueue('agent-1', []);

      expect(await store.getSetupQueue('agent-1')).toEqual([]);
      const q2 = await store.getSetupQueue('agent-2');
      expect(q2.length).toBe(1);
      expect(q2[0].skillName).toBe('alpha');
      expect(q2[0].description).toBe('Other agent');
    });

    it('replaces prior queue rows for same agent', async () => {
      const { store } = await freshStore();
      await store.putSetupQueue('agent-1', [
        {
          skillName: 'alpha',
          description: 'old',
          missingCredentials: [],
          unapprovedDomains: [],
          mcpServers: [],
        },
        {
          skillName: 'beta',
          description: 'old-beta',
          missingCredentials: [],
          unapprovedDomains: [],
          mcpServers: [],
        },
      ]);

      await store.putSetupQueue('agent-1', [
        {
          skillName: 'alpha',
          description: 'new',
          missingCredentials: [],
          unapprovedDomains: [],
          mcpServers: [],
        },
      ]);

      const got = await store.getSetupQueue('agent-1');
      expect(got.length).toBe(1);
      expect(got[0].skillName).toBe('alpha');
      expect(got[0].description).toBe('new');
    });
  });

  describe('putStatesAndQueue — atomic', () => {
    it('replaces both tables in a single round-trip', async () => {
      const { store } = await freshStore();

      const states: SkillState[] = [
        { name: 'alpha', kind: 'enabled', description: 'Alpha' },
        {
          name: 'beta',
          kind: 'pending',
          description: 'Beta',
          pendingReasons: ['reason-a'],
        },
      ];
      const queue: SetupRequest[] = [
        {
          skillName: 'beta',
          description: 'Beta',
          missingCredentials: [],
          unapprovedDomains: ['api.example.com'],
          mcpServers: [],
        },
      ];

      await store.putStatesAndQueue('agent-1', states, queue);

      const prior = await store.getPriorStates('agent-1');
      expect(prior.size).toBe(2);
      expect(prior.get('alpha')).toBe('enabled');
      expect(prior.get('beta')).toBe('pending');

      const q = await store.getSetupQueue('agent-1');
      expect(q.length).toBe(1);
      expect(q[0].skillName).toBe('beta');
      expect(q[0].unapprovedDomains).toEqual(['api.example.com']);
    });

    it('rolls back both tables when queue insert fails (atomicity)', async () => {
      // Simulate a mid-transaction failure by passing a queue row whose
      // payload serialization still succeeds but whose insert violates the
      // primary key by duplicating skill_name within the same batch.
      // Kysely surfaces SQLite's UNIQUE violation as a thrown error.
      const { store } = await freshStore();

      // Seed a prior state so we can verify rollback doesn't wipe it.
      await store.putStatesAndQueue(
        'agent-1',
        [{ name: 'alpha', kind: 'enabled', description: 'Alpha' }],
        [],
      );

      const newStates: SkillState[] = [
        { name: 'beta', kind: 'enabled', description: 'New Beta' },
      ];
      const badQueue: SetupRequest[] = [
        {
          skillName: 'dup',
          description: 'first',
          missingCredentials: [],
          unapprovedDomains: [],
          mcpServers: [],
        },
        {
          // Duplicate skillName — pk_skill_setup_queue is (agent_id, skill_name)
          skillName: 'dup',
          description: 'second',
          missingCredentials: [],
          unapprovedDomains: [],
          mcpServers: [],
        },
      ];

      await expect(
        store.putStatesAndQueue('agent-1', newStates, badQueue),
      ).rejects.toThrow();

      // Prior state must still be the original — the failed queue insert
      // should have rolled back the states delete+insert.
      const prior = await store.getPriorStates('agent-1');
      expect(prior.size).toBe(1);
      expect(prior.get('alpha')).toBe('enabled');
      expect(prior.has('beta')).toBe(false);

      // Queue must remain empty — the partial batch was rolled back.
      const q = await store.getSetupQueue('agent-1');
      expect(q).toEqual([]);
    });

    it('empty inputs clear both tables for the agent', async () => {
      const { store } = await freshStore();
      await store.putStatesAndQueue(
        'agent-1',
        [{ name: 'alpha', kind: 'enabled', description: 'Alpha' }],
        [
          {
            skillName: 'alpha',
            description: 'A',
            missingCredentials: [],
            unapprovedDomains: [],
            mcpServers: [],
          },
        ],
      );

      await store.putStatesAndQueue('agent-1', [], []);

      const prior = await store.getPriorStates('agent-1');
      expect(prior.size).toBe(0);
      const q = await store.getSetupQueue('agent-1');
      expect(q).toEqual([]);
    });
  });
});
