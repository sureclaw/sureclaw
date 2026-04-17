// tests/host/skills/reconcile-orchestrator.test.ts
//
// Integration-style tests for `reconcileAgent`:
//   - real snapshot builder (buildSnapshotFromBareRepo) over a real bare git repo
//   - real reconciler (reconcile)
//   - real state-store (createSkillStateStore) on in-memory sqlite
//   - stubs only at the provider boundary: ProxyDomainList, CredentialProvider,
//     McpManager, EventBus.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import { runMigrations } from '../../../src/utils/migrator.js';
import { skillsMigrations } from '../../../src/migrations/skills.js';
import { createSkillStateStore } from '../../../src/host/skills/state-store.js';
import { reconcileAgent, type OrchestratorDeps } from '../../../src/host/skills/reconcile-orchestrator.js';
import { ProxyDomainList } from '../../../src/host/proxy-domain-list.js';
import type { CredentialProvider } from '../../../src/providers/credentials/types.js';
import type { EventBus, StreamEvent } from '../../../src/host/event-bus.js';

// ─── helpers ─────────────────────────────────────────────────────────────

function runGitCommands(
  cwd: string,
  commands: Array<{ args: string[]; name: string }>,
  critical: string[],
): void {
  for (const cmd of commands) {
    try {
      execFileSync('git', cmd.args, { cwd, encoding: 'utf-8', stdio: 'pipe' });
    } catch (err) {
      if (critical.includes(cmd.name)) {
        throw new Error(
          `${cmd.name} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}

function initBareRepo(bareRepoPath: string): void {
  fs.mkdirSync(bareRepoPath, { recursive: true });
  execFileSync('git', ['init', '--bare', bareRepoPath], { stdio: 'pipe' });
  fs.writeFileSync(path.join(bareRepoPath, 'HEAD'), 'ref: refs/heads/main\n');
}

function seedRepo(bareRepoPath: string, files: Record<string, string>): void {
  const workTree = fs.mkdtempSync(path.join(os.tmpdir(), 'ax-orch-work-'));
  try {
    for (const [relPath, content] of Object.entries(files)) {
      const abs = path.join(workTree, relPath);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    }
    runGitCommands(
      workTree,
      [
        { args: ['init', '-b', 'main'], name: 'git init' },
        { args: ['config', 'user.name', 'test'], name: 'git config user.name' },
        { args: ['config', 'user.email', 'test@local'], name: 'git config user.email' },
        { args: ['remote', 'add', 'origin', bareRepoPath], name: 'git remote add' },
        { args: ['add', '-A'], name: 'git add' },
        { args: ['commit', '-m', 'seed'], name: 'git commit' },
        { args: ['push', '-u', 'origin', 'main'], name: 'git push' },
      ],
      ['git init', 'git add', 'git commit', 'git push'],
    );
  } finally {
    try {
      fs.rmSync(workTree, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

/**
 * Seed a repo by amending/updating the already-existing bare repo.
 * Clones the bare, wipes the working tree so only the supplied files remain,
 * and pushes. Used by the "multiple reconciles" test.
 */
function replaceRepoContents(bareRepoPath: string, files: Record<string, string>): void {
  const workTree = fs.mkdtempSync(path.join(os.tmpdir(), 'ax-orch-work-'));
  try {
    execFileSync('git', ['clone', bareRepoPath, workTree], { stdio: 'pipe' });
    // Wipe everything tracked except .git/
    for (const entry of fs.readdirSync(workTree)) {
      if (entry === '.git') continue;
      fs.rmSync(path.join(workTree, entry), { recursive: true, force: true });
    }
    for (const [relPath, content] of Object.entries(files)) {
      const abs = path.join(workTree, relPath);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    }
    runGitCommands(
      workTree,
      [
        { args: ['config', 'user.name', 'test'], name: 'git config user.name' },
        { args: ['config', 'user.email', 'test@local'], name: 'git config user.email' },
        { args: ['add', '-A'], name: 'git add' },
        { args: ['commit', '-m', 'update'], name: 'git commit' },
        { args: ['push', 'origin', 'main'], name: 'git push' },
      ],
      ['git add', 'git commit', 'git push'],
    );
  } finally {
    try {
      fs.rmSync(workTree, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

async function makeDb() {
  const sqliteDb = new Database(':memory:');
  const db = new Kysely<any>({ dialect: new SqliteDialect({ database: sqliteDb }) });
  const result = await runMigrations(db, skillsMigrations, 'skills_migration');
  if (result.error) throw result.error;
  return { db, close: async () => { await db.destroy(); } };
}

function stubCredentials(args: {
  byScope?: Record<string, string[]>;
  byPrefix?: Record<string, Array<{ scope: string; envName: string }>>;
}): CredentialProvider {
  const byScope = args.byScope ?? {};
  const byPrefix = args.byPrefix ?? {};
  return {
    async get() { return null; },
    async set() {},
    async delete() {},
    async list(scope?: string) { return byScope[scope ?? 'global'] ?? []; },
    async listScopePrefix(prefix: string) { return byPrefix[prefix] ?? []; },
  };
}

function recordingEventBus(): { bus: EventBus; events: StreamEvent[] } {
  const events: StreamEvent[] = [];
  const bus: EventBus = {
    emit(event) { events.push(event); },
    subscribe() { return () => {}; },
    subscribeRequest() { return () => {}; },
    listenerCount() { return 0; },
  };
  return { bus, events };
}

const LINEAR_SKILL = `---
name: linear
description: Talk to Linear.
credentials:
  - envName: LINEAR_TOKEN
    scope: user
domains:
  - api.linear.app
---

# Linear
body
`;

const SLACK_SKILL = `---
name: slack
description: Talk to Slack.
credentials:
  - envName: SLACK_TOKEN
    scope: user
domains:
  - api.slack.com
---

# Slack
body
`;

// ─── tests ────────────────────────────────────────────────────────────────

describe('reconcileAgent', () => {
  let bareRepoPath: string;
  let dbHandle: { db: Kysely<any>; close: () => Promise<void> };

  beforeEach(async () => {
    bareRepoPath = path.join(
      os.tmpdir(),
      `ax-orch-test-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
    );
    initBareRepo(bareRepoPath);
    dbHandle = await makeDb();
  });

  afterEach(async () => {
    try { fs.rmSync(bareRepoPath, { recursive: true, force: true }); } catch { /* best-effort */ }
    await dbHandle.close();
  });

  it('happy path — valid skill with missing credentials → pending + persists + emits', async () => {
    seedRepo(bareRepoPath, { '.ax/skills/linear/SKILL.md': LINEAR_SKILL });

    const stateStore = createSkillStateStore(dbHandle.db);
    // Isolate from builtin domains in ProxyDomainList.
    const proxyDomainList = {
      getAllowedDomains: () => new Set<string>(),
    } as unknown as ProxyDomainList;
    const credentials = stubCredentials({}); // no credentials stored
    const { bus, events } = recordingEventBus();

    const deps: OrchestratorDeps = {
      agentName: 'foo-agent',
      proxyDomainList,
      credentials,
      stateStore,
      eventBus: bus,
      getBareRepoPath: (id: string) => {
        expect(id).toBe('agent-1');
        return bareRepoPath;
      },
    };

    const result = await reconcileAgent('agent-1', 'refs/heads/main', deps);

    // Phase-1 reconciler emits skill.installed + skill.pending for a new pending.
    expect(result).toEqual({ skills: 1, events: 2 });

    // Persisted state
    const prior = await stateStore.getPriorStates('agent-1');
    expect(prior.size).toBe(1);
    expect(prior.get('linear')).toBe('pending');

    // Setup queue
    const queue = await stateStore.getSetupQueue('agent-1');
    expect(queue).toHaveLength(1);
    expect(queue[0].skillName).toBe('linear');

    // Events
    expect(events.map((e) => e.type)).toEqual(['skill.installed', 'skill.pending']);
    for (const ev of events) {
      expect(ev.requestId).toBe('agent-1');
      expect(typeof ev.timestamp).toBe('number');
    }
  });

  it('enabled path — credentials + domain met → skill.installed + skill.enabled', async () => {
    seedRepo(bareRepoPath, { '.ax/skills/linear/SKILL.md': LINEAR_SKILL });

    const stateStore = createSkillStateStore(dbHandle.db);
    const proxyDomainList = {
      getAllowedDomains: () => new Set<string>(['api.linear.app']),
    } as unknown as ProxyDomainList;
    const credentials = stubCredentials({
      byPrefix: {
        'user:foo-agent:': [
          { scope: 'user:foo-agent:alice', envName: 'LINEAR_TOKEN' },
        ],
      },
    });
    const { bus, events } = recordingEventBus();

    const deps: OrchestratorDeps = {
      agentName: 'foo-agent',
      proxyDomainList,
      credentials,
      stateStore,
      eventBus: bus,
      getBareRepoPath: () => bareRepoPath,
    };

    const result = await reconcileAgent('agent-1', 'refs/heads/main', deps);

    expect(result).toEqual({ skills: 1, events: 2 });

    const prior = await stateStore.getPriorStates('agent-1');
    expect(prior.get('linear')).toBe('enabled');

    // No setup work needed
    expect(await stateStore.getSetupQueue('agent-1')).toEqual([]);

    const types = events.map((e) => e.type);
    expect(types).toContain('skill.installed');
    expect(types).toContain('skill.enabled');
  });

  it('snapshot failure — no half-writes, emits skills.reconcile_failed, returns zeros', async () => {
    const stateStore = createSkillStateStore(dbHandle.db);
    const proxyDomainList = {
      getAllowedDomains: () => new Set<string>(),
    } as unknown as ProxyDomainList;
    const { bus, events } = recordingEventBus();

    // Seed some prior state so we can verify no writes occurred.
    await stateStore.putStates('agent-1', [
      { name: 'preexisting', kind: 'enabled', description: 'x' },
    ]);

    const deps: OrchestratorDeps = {
      agentName: 'foo-agent',
      proxyDomainList,
      credentials: stubCredentials({}),
      stateStore,
      eventBus: bus,
      // Bogus path — buildSnapshotFromBareRepo will throw.
      getBareRepoPath: () => '/nonexistent/path/to/bare/repo',
    };

    const result = await reconcileAgent('agent-1', 'refs/heads/main', deps);
    expect(result).toEqual({ skills: 0, events: 0 });

    // No partial writes: prior state untouched.
    const prior = await stateStore.getPriorStates('agent-1');
    expect(prior.size).toBe(1);
    expect(prior.get('preexisting')).toBe('enabled');

    // Exactly one skills.reconcile_failed event with an error message.
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('skills.reconcile_failed');
    expect(events[0].requestId).toBe('agent-1');
    expect(typeof events[0].timestamp).toBe('number');
    expect(typeof events[0].data.error).toBe('string');
    expect((events[0].data.error as string).length).toBeGreaterThan(0);
  });

  it('multiple reconciles update correctly — old skill removed, new skill present', async () => {
    // First: skill A
    seedRepo(bareRepoPath, { '.ax/skills/linear/SKILL.md': LINEAR_SKILL });

    const stateStore = createSkillStateStore(dbHandle.db);
    const proxyDomainList = {
      getAllowedDomains: () => new Set<string>(),
    } as unknown as ProxyDomainList;
    const { bus: bus1 } = recordingEventBus();

    const deps1: OrchestratorDeps = {
      agentName: 'foo-agent',
      proxyDomainList,
      credentials: stubCredentials({}),
      stateStore,
      eventBus: bus1,
      getBareRepoPath: () => bareRepoPath,
    };

    await reconcileAgent('agent-1', 'refs/heads/main', deps1);

    const priorAfterFirst = await stateStore.getPriorStates('agent-1');
    expect(priorAfterFirst.has('linear')).toBe(true);

    // Second: replace with skill B (slack). Linear should be removed, slack present.
    replaceRepoContents(bareRepoPath, { '.ax/skills/slack/SKILL.md': SLACK_SKILL });

    const { bus: bus2, events: events2 } = recordingEventBus();
    const deps2: OrchestratorDeps = { ...deps1, eventBus: bus2 };

    const result2 = await reconcileAgent('agent-1', 'refs/heads/main', deps2);
    expect(result2.skills).toBe(1);

    const priorAfterSecond = await stateStore.getPriorStates('agent-1');
    expect(priorAfterSecond.has('linear')).toBe(false);
    expect(priorAfterSecond.has('slack')).toBe(true);
    expect(priorAfterSecond.get('slack')).toBe('pending');

    // events should include skill.removed (for linear) and skill.installed/skill.pending (for slack)
    const types2 = events2.map((e) => e.type);
    expect(types2).toContain('skill.removed');
    expect(types2).toContain('skill.installed');
    expect(types2).toContain('skill.pending');
  });

  it('invokes mcpApplier + proxyApplier with desired output after DB write', async () => {
    // Seed a skill that will end up ENABLED (credential + domain are met)
    seedRepo(bareRepoPath, {
      '.ax/skills/linear/SKILL.md': `---
name: linear
description: Talk to Linear.
credentials:
  - envName: LINEAR_TOKEN
    scope: user
domains:
  - api.linear.app
mcpServers:
  - name: linear-mcp
    url: https://mcp.linear.app
    credential: LINEAR_TOKEN
---
# body
`,
    });

    const stateStore = createSkillStateStore(dbHandle.db);
    const proxyDomainList = {
      getAllowedDomains: () => new Set<string>(['api.linear.app']),
    } as unknown as ProxyDomainList;
    const credentials = stubCredentials({
      byPrefix: { 'user:foo-agent:': [{ scope: 'user:foo-agent:alice', envName: 'LINEAR_TOKEN' }] },
    });
    const { bus } = recordingEventBus();

    const mcpCalls: Array<{ id: string; entries: Array<[string, { url: string; bearerCredential?: string }]> }> = [];
    const proxyCalls: Array<{ id: string; domains: string[] }> = [];
    const deps: OrchestratorDeps = {
      agentName: 'foo-agent',
      proxyDomainList,
      credentials,
      stateStore,
      eventBus: bus,
      getBareRepoPath: () => bareRepoPath,
      mcpApplier: {
        apply: async (id, m) => {
          mcpCalls.push({ id, entries: [...m] });
          return { registered: [], unregistered: [], conflicts: [] };
        },
      },
      proxyApplier: {
        apply: async (id, s) => {
          proxyCalls.push({ id, domains: [...s] });
          return { added: [], removed: [] };
        },
      },
    };

    await reconcileAgent('agent-1', 'refs/heads/main', deps);

    expect(mcpCalls).toHaveLength(1);
    expect(mcpCalls[0].id).toBe('agent-1');
    expect(mcpCalls[0].entries).toEqual([
      ['linear-mcp', { url: 'https://mcp.linear.app', bearerCredential: 'LINEAR_TOKEN' }],
    ]);
    expect(proxyCalls).toEqual([{ id: 'agent-1', domains: ['api.linear.app'] }]);
  });

  it('emits audit/report events reflecting applier results', async () => {
    seedRepo(bareRepoPath, { '.ax/skills/linear/SKILL.md': LINEAR_SKILL });
    const stateStore = createSkillStateStore(dbHandle.db);
    const proxyDomainList = {
      getAllowedDomains: () => new Set<string>(['api.linear.app']),
    } as unknown as ProxyDomainList;
    const credentials = stubCredentials({
      byPrefix: { 'user:foo-agent:': [{ scope: 'user:foo-agent:alice', envName: 'LINEAR_TOKEN' }] },
    });
    const { bus, events } = recordingEventBus();

    const deps: OrchestratorDeps = {
      agentName: 'foo-agent',
      proxyDomainList,
      credentials,
      stateStore,
      eventBus: bus,
      getBareRepoPath: () => bareRepoPath,
      mcpApplier: {
        apply: async () => ({
          registered: [{ name: 'linear-mcp', url: 'https://mcp.linear.app' }],
          unregistered: [],
          conflicts: [],
        }),
      },
      proxyApplier: {
        apply: async () => ({ added: ['api.linear.app'], removed: [] }),
      },
    };

    await reconcileAgent('agent-1', 'refs/heads/main', deps);

    const types = events.map((e) => e.type);
    expect(types).toContain('skills.live_state_applied');
  });

  it('does not emit skills.live_state_applied when both appliers throw', async () => {
    seedRepo(bareRepoPath, { '.ax/skills/linear/SKILL.md': LINEAR_SKILL });
    const stateStore = createSkillStateStore(dbHandle.db);
    const proxyDomainList = {
      getAllowedDomains: () => new Set<string>(['api.linear.app']),
    } as unknown as ProxyDomainList;
    const credentials = stubCredentials({
      byPrefix: { 'user:foo-agent:': [{ scope: 'user:foo-agent:alice', envName: 'LINEAR_TOKEN' }] },
    });
    const { bus, events } = recordingEventBus();

    const deps: OrchestratorDeps = {
      agentName: 'foo-agent',
      proxyDomainList,
      credentials,
      stateStore,
      eventBus: bus,
      getBareRepoPath: () => bareRepoPath,
      mcpApplier: {
        apply: async () => { throw new Error('mcp boom'); },
      },
      proxyApplier: {
        apply: async () => { throw new Error('proxy boom'); },
      },
    };

    await reconcileAgent('agent-1', 'refs/heads/main', deps);

    const types = events.map((e) => e.type);
    expect(types).not.toContain('skills.live_state_applied');
  });

  it('emits skills.live_state_applied when only one applier succeeds', async () => {
    seedRepo(bareRepoPath, { '.ax/skills/linear/SKILL.md': LINEAR_SKILL });
    const stateStore = createSkillStateStore(dbHandle.db);
    const proxyDomainList = {
      getAllowedDomains: () => new Set<string>(['api.linear.app']),
    } as unknown as ProxyDomainList;
    const credentials = stubCredentials({
      byPrefix: { 'user:foo-agent:': [{ scope: 'user:foo-agent:alice', envName: 'LINEAR_TOKEN' }] },
    });
    const { bus, events } = recordingEventBus();

    const deps: OrchestratorDeps = {
      agentName: 'foo-agent',
      proxyDomainList,
      credentials,
      stateStore,
      eventBus: bus,
      getBareRepoPath: () => bareRepoPath,
      mcpApplier: {
        apply: async () => { throw new Error('mcp boom'); },
      },
      proxyApplier: {
        apply: async () => ({ added: ['api.linear.app'], removed: [] }),
      },
    };

    await reconcileAgent('agent-1', 'refs/heads/main', deps);

    const applied = events.find((e) => e.type === 'skills.live_state_applied');
    expect(applied).toBeDefined();
    expect(applied?.data).toEqual({
      mcp: undefined,
      proxy: { added: ['api.linear.app'], removed: [] },
    });
  });

  it('skips appliers if orchestrator catches an error before DB write', async () => {
    // Force snapshot failure; appliers must NOT be called.
    const stateStore = createSkillStateStore(dbHandle.db);
    const proxyDomainList = {
      getAllowedDomains: () => new Set<string>(),
    } as unknown as ProxyDomainList;
    const { bus } = recordingEventBus();
    const mcpApply = vi.fn().mockResolvedValue({ registered: [], unregistered: [], conflicts: [] });
    const proxyApply = vi.fn().mockResolvedValue({ added: [], removed: [] });

    const deps: OrchestratorDeps = {
      agentName: 'foo-agent',
      proxyDomainList,
      credentials: stubCredentials({}),
      stateStore,
      eventBus: bus,
      getBareRepoPath: () => '/nonexistent/path',
      mcpApplier: { apply: mcpApply },
      proxyApplier: { apply: proxyApply },
    };

    await reconcileAgent('agent-1', 'refs/heads/main', deps);

    expect(mcpApply).not.toHaveBeenCalled();
    expect(proxyApply).not.toHaveBeenCalled();
  });
});
