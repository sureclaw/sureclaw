// tests/host/skills/e2e-reconcile.test.ts
//
// End-to-end smoke test for the phase 2 skills reconcile wire. No stubs for
// anything shipped in phase 2 — only the provider boundaries (proxy domain
// list, credentials, MCP manager) are stubbed.
//
// Flow:
//   1. Stand up an in-process HTTP server on an ephemeral localhost port that
//      routes POST /v1/internal/skills/reconcile → createReconcileHookHandler
//      → real reconcileAgent (real snapshot builder, real state store on
//      in-memory sqlite, real event bus, real loadCurrentState).
//   2. Create a bare git repo + install the post-receive hook via
//      installPostReceiveHook. Point the hook at the test server using
//      AX_HOST_URL and set AX_HOOK_SECRET to a fixed test secret.
//   3. Clone the bare repo, commit a valid SKILL.md, push.
//   4. The push triggers the hook → HMAC → HTTP POST → handler → orchestrator.
//   5. Poll until reconcile completes (the hook is best-effort and runs AFTER
//      the push subprocess returns), then assert state + events.
//
// Hook prerequisites on the runner: `openssl`, `curl`, `od`, `git`. If any is
// missing we skip with a clear message — these are table stakes on any dev or
// CI box, but the test should fail-clean rather than fail-mysteriously.
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import { installPostReceiveHook } from '../../../src/providers/workspace/install-hook.js';
import { createReconcileHookHandler } from '../../../src/host/skills/hook-endpoint.js';
import {
  reconcileAgent,
  type OrchestratorDeps,
} from '../../../src/host/skills/reconcile-orchestrator.js';
import { createSkillStateStore } from '../../../src/host/skills/state-store.js';
import { skillsMigrations } from '../../../src/migrations/skills.js';
import { runMigrations } from '../../../src/utils/migrator.js';
import { createEventBus, type StreamEvent } from '../../../src/host/event-bus.js';

function hasCommand(cmd: string): boolean {
  try {
    execFileSync(cmd, ['--version'], { stdio: 'pipe' });
    return true;
  } catch {
    try {
      // openssl uses `version`, not `--version`.
      execFileSync(cmd, ['version'], { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }
}

const hooksRunnable =
  hasCommand('git') && hasCommand('openssl') && hasCommand('curl');

describe.skipIf(!hooksRunnable)('E2E: git push → reconcile', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
    dirs.length = 0;
  });

  it('a valid skill lands as pending after push', async () => {
    const bareRepoPath = mkdtempSync(join(tmpdir(), 'ax-e2e-bare-'));
    dirs.push(bareRepoPath);
    const workDir = mkdtempSync(join(tmpdir(), 'ax-e2e-work-'));
    dirs.push(workDir);

    // 1. Bare repo on main.
    execFileSync('git', ['init', '--bare', bareRepoPath], { stdio: 'pipe' });
    try {
      execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], {
        cwd: bareRepoPath,
        stdio: 'pipe',
      });
    } catch {
      /* some older gits default to main already — best-effort */
    }

    // 2. Real deps.
    const sqliteDb = new Database(':memory:');
    const db = new Kysely<any>({ dialect: new SqliteDialect({ database: sqliteDb }) });
    const migration = await runMigrations(db, skillsMigrations, 'skills_migration');
    if (migration.error) throw migration.error;
    const stateStore = createSkillStateStore(db);

    const eventBus = createEventBus();
    const eventsSeen: StreamEvent[] = [];
    eventBus.subscribe((ev) => eventsSeen.push(ev));

    // Provider-boundary stubs.
    const proxyDomainList = {
      getAllowedDomains: () => new Set<string>(),
    } as any;
    const credentials = {
      list: async () => [],
      listScopePrefix: async () => [],
      get: async () => null,
      set: async () => {},
      delete: async () => {},
    } as any;

    const orchestratorDeps: OrchestratorDeps = {
      agentName: 'agent-e2e',
      proxyDomainList,
      credentials,
      stateStore,
      eventBus,
      getBareRepoPath: () => bareRepoPath,
    };

    const SECRET = 'test-secret-e2e';
    const hookHandler = createReconcileHookHandler({
      secret: SECRET,
      reconcileAgent: (agentId, ref) => reconcileAgent(agentId, ref, orchestratorDeps),
    });

    const server = http.createServer(async (req, res) => {
      if (req.url === '/v1/internal/skills/reconcile' && req.method === 'POST') {
        await hookHandler(req, res);
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', () => resolve()),
    );
    const port = (server.address() as { port: number }).port;

    try {
      // 3. Install hook (template is written with the agent ID baked in).
      installPostReceiveHook(bareRepoPath, 'agent-e2e');

      // 4. Clone + commit + push. Hook env is passed via the push subprocess.
      const childEnv = {
        ...process.env,
        AX_HOST_URL: `http://127.0.0.1:${port}`,
        AX_HOOK_SECRET: SECRET,
        GIT_AUTHOR_NAME: 'Test',
        GIT_AUTHOR_EMAIL: 'test@example.com',
        GIT_COMMITTER_NAME: 'Test',
        GIT_COMMITTER_EMAIL: 'test@example.com',
      };

      execFileSync('git', ['clone', bareRepoPath, workDir], {
        stdio: 'pipe',
        env: childEnv,
      });
      // user.name/email are required for commit; global config may not exist on CI.
      execFileSync('git', ['config', 'user.name', 'Test'], {
        cwd: workDir,
        stdio: 'pipe',
      });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], {
        cwd: workDir,
        stdio: 'pipe',
      });

      mkdirSync(join(workDir, '.ax', 'skills', 'demo'), { recursive: true });
      writeFileSync(
        join(workDir, '.ax', 'skills', 'demo', 'SKILL.md'),
        [
          '---',
          'name: demo',
          'description: Demo skill.',
          'credentials:',
          '  - envName: DEMO_TOKEN',
          '    scope: user',
          '---',
          '# Demo body',
          '',
        ].join('\n'),
      );

      execFileSync('git', ['add', '-A'], {
        cwd: workDir,
        stdio: 'pipe',
        env: childEnv,
      });
      execFileSync('git', ['commit', '-m', 'add demo'], {
        cwd: workDir,
        stdio: 'pipe',
        env: childEnv,
      });
      try {
        execFileSync('git', ['branch', '-M', 'main'], {
          cwd: workDir,
          stdio: 'pipe',
          env: childEnv,
        });
      } catch {
        /* already on main */
      }

      // Push. Capture stderr for debugging if the later assertions fail.
      let pushStderr = '';
      try {
        const out = execFileSync('git', ['push', 'origin', 'main'], {
          cwd: workDir,
          env: childEnv,
          encoding: 'utf-8',
          stdio: 'pipe',
        });
        pushStderr = String(out);
      } catch (err) {
        const e = err as { stderr?: Buffer | string; message: string };
        pushStderr = (e.stderr ? e.stderr.toString() : '') + '\n' + e.message;
        throw new Error(`git push failed: ${pushStderr}`);
      }

      // 5. Wait for the reconcile to land. The hook is asynchronous w.r.t. the
      //    push subprocess, so we poll the state store for up to 5s.
      const deadline = Date.now() + 5000;
      let states = await stateStore.getPriorStates('agent-e2e');
      while (states.size === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
        states = await stateStore.getPriorStates('agent-e2e');
      }

      if (states.size === 0) {
        throw new Error(
          `reconcile did not land within 5s. push stderr: ${pushStderr}`,
        );
      }

      // Assertions.
      expect(states.get('demo')).toBe('pending');

      const installedEvent = eventsSeen.find((e) => e.type === 'skill.installed');
      expect(installedEvent).toBeDefined();
      expect(installedEvent!.data).toMatchObject({ name: 'demo' });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await db.destroy();
    }
  }, 15_000);
});
