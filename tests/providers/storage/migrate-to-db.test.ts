import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { create as createSqliteDb } from '../../../src/providers/database/sqlite.js';
import { create as createStorage } from '../../../src/providers/storage/database.js';
import { migrateFilesToDb } from '../../../src/providers/storage/migrate-to-db.js';
import type { DocumentStore } from '../../../src/providers/storage/types.js';
import type { DatabaseProvider } from '../../../src/providers/database/types.js';
import type { Config } from '../../../src/types.js';

const config = {} as Config;

describe('migrateFilesToDb', () => {
  let testHome: string;
  let documents: DocumentStore;
  let database: DatabaseProvider;
  let logs: string[];
  const log = (msg: string) => { logs.push(msg); };

  beforeEach(async () => {
    testHome = join(tmpdir(), `ax-migrate-test-${randomUUID()}`);
    mkdirSync(testHome, { recursive: true });
    process.env.AX_HOME = testHome;
    database = await createSqliteDb(config);
    const storage = await createStorage(config, 'database', { database });
    documents = storage.documents;
    logs = [];
  });

  afterEach(async () => {
    try { await database.close(); } catch {}
    try { rmSync(testHome, { recursive: true, force: true }); } catch {}
    delete process.env.AX_HOME;
  });

  // ── Helper to create files in the test filesystem ──

  function createFile(relativePath: string, content: string): void {
    const fullPath = join(testHome, relativePath);
    mkdirSync(join(fullPath, '..'), { recursive: true });
    writeFileSync(fullPath, content, 'utf-8');
  }

  // ── Identity files ──

  test('imports identity .md files from agent/identity/', async () => {
    createFile('agents/main/agent/identity/AGENTS.md', '# Agents');
    createFile('agents/main/agent/identity/SOUL.md', '# Soul');
    createFile('agents/main/agent/identity/IDENTITY.md', '# Identity');

    const result = await migrateFilesToDb(documents, testHome, log);

    expect(result.migrated).toBe(true);
    expect(result.filesImported).toBe(3);
    expect(await documents.get('identity', 'main/AGENTS.md')).toBe('# Agents');
    expect(await documents.get('identity', 'main/SOUL.md')).toBe('# Soul');
    expect(await documents.get('identity', 'main/IDENTITY.md')).toBe('# Identity');
  });

  test('imports BOOTSTRAP.md and USER_BOOTSTRAP.md from agent/ dir', async () => {
    createFile('agents/main/agent/BOOTSTRAP.md', '# Bootstrap');
    createFile('agents/main/agent/USER_BOOTSTRAP.md', '# User Bootstrap');

    const result = await migrateFilesToDb(documents, testHome, log);

    expect(result.migrated).toBe(true);
    expect(result.filesImported).toBe(2);
    expect(await documents.get('identity', 'main/BOOTSTRAP.md')).toBe('# Bootstrap');
    expect(await documents.get('identity', 'main/USER_BOOTSTRAP.md')).toBe('# User Bootstrap');
  });

  // ── Agent skills ──

  test('imports agent skills and strips .md extension from key', async () => {
    createFile('agents/main/agent/skills/deploy.md', '# Deploy skill');
    createFile('agents/main/agent/skills/review.md', '# Review skill');

    const result = await migrateFilesToDb(documents, testHome, log);

    expect(result.migrated).toBe(true);
    expect(result.filesImported).toBe(2);
    expect(await documents.get('skills', 'main/deploy')).toBe('# Deploy skill');
    expect(await documents.get('skills', 'main/review')).toBe('# Review skill');
  });

  test('imports skills from subdirectories', async () => {
    createFile('agents/main/agent/skills/ops/deploy-checklist.md', '# Checklist');
    createFile('agents/main/agent/skills/ops/monitoring.md', '# Monitoring');
    createFile('agents/main/agent/skills/dev/testing.md', '# Testing');

    const result = await migrateFilesToDb(documents, testHome, log);

    expect(result.migrated).toBe(true);
    expect(result.filesImported).toBe(3);
    expect(await documents.get('skills', 'main/ops/deploy-checklist')).toBe('# Checklist');
    expect(await documents.get('skills', 'main/ops/monitoring')).toBe('# Monitoring');
    expect(await documents.get('skills', 'main/dev/testing')).toBe('# Testing');
  });

  // ── User identity ──

  test('imports USER.md from users/<userId>/', async () => {
    createFile('agents/main/users/alice/USER.md', '# Alice prefs');
    createFile('agents/main/users/bob/USER.md', '# Bob prefs');

    const result = await migrateFilesToDb(documents, testHome, log);

    expect(result.migrated).toBe(true);
    expect(result.filesImported).toBe(2);
    expect(await documents.get('identity', 'main/users/alice/USER.md')).toBe('# Alice prefs');
    expect(await documents.get('identity', 'main/users/bob/USER.md')).toBe('# Bob prefs');
  });

  // ── User skills ──

  test('imports user skills with correct key format', async () => {
    createFile('agents/main/users/alice/skills/my-tool.md', '# My Tool');
    createFile('agents/main/users/alice/skills/sub/nested.md', '# Nested');

    const result = await migrateFilesToDb(documents, testHome, log);

    expect(result.migrated).toBe(true);
    expect(result.filesImported).toBe(2);
    expect(await documents.get('skills', 'main/users/alice/my-tool')).toBe('# My Tool');
    expect(await documents.get('skills', 'main/users/alice/sub/nested')).toBe('# Nested');
  });

  // ── Multiple agents ──

  test('imports files from multiple agents', async () => {
    createFile('agents/main/agent/identity/SOUL.md', '# Main soul');
    createFile('agents/helper/agent/identity/SOUL.md', '# Helper soul');
    createFile('agents/main/agent/skills/deploy.md', '# Deploy');
    createFile('agents/helper/agent/skills/assist.md', '# Assist');

    const result = await migrateFilesToDb(documents, testHome, log);

    expect(result.migrated).toBe(true);
    expect(result.filesImported).toBe(4);
    expect(await documents.get('identity', 'main/SOUL.md')).toBe('# Main soul');
    expect(await documents.get('identity', 'helper/SOUL.md')).toBe('# Helper soul');
    expect(await documents.get('skills', 'main/deploy')).toBe('# Deploy');
    expect(await documents.get('skills', 'helper/assist')).toBe('# Assist');
  });

  // ── Combined import ──

  test('imports identity, bootstrap, skills, user identity, and user skills together', async () => {
    createFile('agents/main/agent/identity/AGENTS.md', '# Agents');
    createFile('agents/main/agent/BOOTSTRAP.md', '# Bootstrap');
    createFile('agents/main/agent/skills/deploy.md', '# Deploy');
    createFile('agents/main/users/alice/USER.md', '# Alice');
    createFile('agents/main/users/alice/skills/custom.md', '# Custom');

    const result = await migrateFilesToDb(documents, testHome, log);

    expect(result.migrated).toBe(true);
    expect(result.filesImported).toBe(5);
    expect(await documents.get('identity', 'main/AGENTS.md')).toBe('# Agents');
    expect(await documents.get('identity', 'main/BOOTSTRAP.md')).toBe('# Bootstrap');
    expect(await documents.get('skills', 'main/deploy')).toBe('# Deploy');
    expect(await documents.get('identity', 'main/users/alice/USER.md')).toBe('# Alice');
    expect(await documents.get('skills', 'main/users/alice/custom')).toBe('# Custom');
  });

  // ── Idempotency ──

  test('skips migration if already completed (idempotency)', async () => {
    createFile('agents/main/agent/identity/SOUL.md', '# Soul');

    const first = await migrateFilesToDb(documents, testHome, log);
    expect(first.migrated).toBe(true);
    expect(first.filesImported).toBe(1);

    // Second call should skip
    const second = await migrateFilesToDb(documents, testHome, log);
    expect(second.migrated).toBe(false);
    expect(second.filesImported).toBe(0);
    expect(logs).toContain('Migration already completed, skipping');
  });

  // ── Migration flag ──

  test('writes migration flag after successful migration', async () => {
    createFile('agents/main/agent/identity/SOUL.md', '# Soul');

    await migrateFilesToDb(documents, testHome, log);

    const flag = await documents.get('_meta', 'migrated_storage_v1');
    expect(flag).toBeDefined();
    // Should be a valid ISO date string
    expect(new Date(flag!).toISOString()).toBe(flag);
  });

  test('writes migration flag even with no agents directory', async () => {
    // No agents/ dir at all
    const result = await migrateFilesToDb(documents, testHome, log);

    expect(result.migrated).toBe(true);
    expect(result.filesImported).toBe(0);
    const flag = await documents.get('_meta', 'migrated_storage_v1');
    expect(flag).toBeDefined();
  });

  // ── Missing directories ──

  test('handles missing agents directory gracefully', async () => {
    const result = await migrateFilesToDb(documents, testHome, log);
    expect(result.migrated).toBe(true);
    expect(result.filesImported).toBe(0);
  });

  test('handles agent with no identity or skills dirs gracefully', async () => {
    // Create agent dir but no identity/ or skills/ subdirectories
    mkdirSync(join(testHome, 'agents', 'main', 'agent'), { recursive: true });

    const result = await migrateFilesToDb(documents, testHome, log);
    expect(result.migrated).toBe(true);
    expect(result.filesImported).toBe(0);
  });

  test('handles agent with no users directory gracefully', async () => {
    createFile('agents/main/agent/identity/SOUL.md', '# Soul');
    // No users/ dir

    const result = await migrateFilesToDb(documents, testHome, log);
    expect(result.migrated).toBe(true);
    expect(result.filesImported).toBe(1);
  });

  // ── Non-.md files are ignored ──

  test('ignores non-.md files', async () => {
    createFile('agents/main/agent/identity/SOUL.md', '# Soul');
    createFile('agents/main/agent/identity/config.yaml', 'key: value');
    createFile('agents/main/agent/skills/deploy.md', '# Deploy');
    createFile('agents/main/agent/skills/script.sh', '#!/bin/bash');

    const result = await migrateFilesToDb(documents, testHome, log);

    expect(result.migrated).toBe(true);
    expect(result.filesImported).toBe(2);
    // .yaml and .sh files should not appear
    const identityKeys = await documents.list('identity');
    expect(identityKeys).not.toContain('main/config.yaml');
    const skillKeys = await documents.list('skills');
    expect(skillKeys).not.toContain('main/script');
  });

  // ── Logging ──

  test('logs imported files when logger provided', async () => {
    createFile('agents/main/agent/identity/SOUL.md', '# Soul');
    createFile('agents/main/agent/skills/deploy.md', '# Deploy');

    await migrateFilesToDb(documents, testHome, log);

    expect(logs).toContain('Imported identity: main/SOUL.md');
    expect(logs).toContain('Imported skill: main/deploy');
    expect(logs.some(l => l.includes('Migration complete: 2 files imported'))).toBe(true);
  });

  test('works without logger (no log callback)', async () => {
    createFile('agents/main/agent/identity/SOUL.md', '# Soul');

    // No log callback — should not throw
    const result = await migrateFilesToDb(documents, testHome);
    expect(result.migrated).toBe(true);
    expect(result.filesImported).toBe(1);
  });

  // ── Edge cases ──

  test('preserves file content including whitespace and special characters', async () => {
    const content = '# Soul\n\nI am **bold**.\n\n- item 1\n- item 2\n\n```js\nconsole.log("hello");\n```\n';
    createFile('agents/main/agent/identity/SOUL.md', content);

    await migrateFilesToDb(documents, testHome, log);

    expect(await documents.get('identity', 'main/SOUL.md')).toBe(content);
  });

  test('handles deeply nested skill subdirectories', async () => {
    createFile('agents/main/agent/skills/a/b/c/deep.md', '# Deep');

    const result = await migrateFilesToDb(documents, testHome, log);

    expect(result.filesImported).toBe(1);
    expect(await documents.get('skills', 'main/a/b/c/deep')).toBe('# Deep');
  });
});
