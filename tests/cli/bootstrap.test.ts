import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { resetAgent } from '../../src/cli/bootstrap.js';

describe('bootstrap command', () => {
  let agentDir: string;
  let templatesDir: string;

  beforeEach(() => {
    const id = randomUUID();
    agentDir = join(tmpdir(), `ax-test-agent-${id}`);
    templatesDir = join(tmpdir(), `ax-test-templates-${id}`);
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(templatesDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(templatesDir, { recursive: true, force: true });
  });

  test('resetAgent deletes SOUL.md and IDENTITY.md from agentDir', async () => {
    writeFileSync(join(agentDir, 'SOUL.md'), '# Old soul');
    writeFileSync(join(agentDir, 'IDENTITY.md'), '# Old identity');
    writeFileSync(join(agentDir, 'AGENTS.md'), '# Rules');

    await resetAgent(agentDir, templatesDir);

    expect(existsSync(join(agentDir, 'SOUL.md'))).toBe(false);
    expect(existsSync(join(agentDir, 'IDENTITY.md'))).toBe(false);
    // AGENTS.md should NOT be deleted
    expect(existsSync(join(agentDir, 'AGENTS.md'))).toBe(true);
  });

  test('resetAgent does not delete per-user USER.md files', async () => {
    const userDir = join(agentDir, 'users', 'U12345');
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, 'USER.md'), '# User prefs');

    await resetAgent(agentDir, templatesDir);

    expect(existsSync(join(userDir, 'USER.md'))).toBe(true);
  });

  test('resetAgent copies BOOTSTRAP.md from templatesDir to agentDir', async () => {
    writeFileSync(join(templatesDir, 'BOOTSTRAP.md'), '# Bootstrap\nDiscover yourself.');

    await resetAgent(agentDir, templatesDir);

    expect(existsSync(join(agentDir, 'BOOTSTRAP.md'))).toBe(true);
    const content = readFileSync(join(agentDir, 'BOOTSTRAP.md'), 'utf-8');
    expect(content).toContain('Bootstrap');
  });

  test('resetAgent deletes .bootstrap-admin-claimed file', async () => {
    writeFileSync(join(agentDir, '.bootstrap-admin-claimed'), 'U12345');

    await resetAgent(agentDir, templatesDir);

    expect(existsSync(join(agentDir, '.bootstrap-admin-claimed'))).toBe(false);
  });

  test('resetAgent is idempotent (no error if files missing)', async () => {
    // No files exist — should not throw
    await expect(resetAgent(agentDir, templatesDir)).resolves.not.toThrow();
  });
});
