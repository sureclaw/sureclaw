import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { resetAgent } from '../../src/cli/bootstrap.js';

describe('bootstrap command', () => {
  let axHome: string;
  let originalAxHome: string | undefined;
  let topDir: string;       // ~/.ax/agents/main/
  let configDir: string;    // ~/.ax/agents/main/agent/
  let identityDir: string;  // ~/.ax/agents/main/agent/identity/
  let templatesDir: string;

  beforeEach(() => {
    const id = randomUUID();
    originalAxHome = process.env.AX_HOME;
    axHome = join(tmpdir(), `ax-test-home-${id}`);
    process.env.AX_HOME = axHome;

    topDir = join(axHome, 'agents', 'main');
    configDir = join(axHome, 'agents', 'main', 'agent');
    identityDir = join(axHome, 'agents', 'main', 'agent', 'identity');
    mkdirSync(identityDir, { recursive: true });

    templatesDir = join(tmpdir(), `ax-test-templates-${id}`);
    mkdirSync(templatesDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(axHome, { recursive: true, force: true });
    rmSync(templatesDir, { recursive: true, force: true });
    if (originalAxHome !== undefined) {
      process.env.AX_HOME = originalAxHome;
    } else {
      delete process.env.AX_HOME;
    }
  });

  test('resetAgent deletes SOUL.md and IDENTITY.md from identityFilesDir', async () => {
    writeFileSync(join(identityDir, 'SOUL.md'), '# Old soul');
    writeFileSync(join(identityDir, 'IDENTITY.md'), '# Old identity');
    writeFileSync(join(identityDir, 'AGENTS.md'), '# Rules');

    await resetAgent('main', templatesDir);

    expect(existsSync(join(identityDir, 'SOUL.md'))).toBe(false);
    expect(existsSync(join(identityDir, 'IDENTITY.md'))).toBe(false);
    // AGENTS.md should NOT be deleted
    expect(existsSync(join(identityDir, 'AGENTS.md'))).toBe(true);
  });

  test('resetAgent does not delete per-user USER.md files', async () => {
    const userDir = join(topDir, 'users', 'U12345');
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, 'USER.md'), '# User prefs');

    await resetAgent('main', templatesDir);

    expect(existsSync(join(userDir, 'USER.md'))).toBe(true);
  });

  test('resetAgent copies BOOTSTRAP.md to both configDir and identityFilesDir', async () => {
    writeFileSync(join(templatesDir, 'BOOTSTRAP.md'), '# Bootstrap\nDiscover yourself.');

    await resetAgent('main', templatesDir);

    // Authoritative copy in configDir
    expect(existsSync(join(configDir, 'BOOTSTRAP.md'))).toBe(true);
    const configContent = readFileSync(join(configDir, 'BOOTSTRAP.md'), 'utf-8');
    expect(configContent).toContain('Bootstrap');

    // Agent-readable copy in identityFilesDir
    expect(existsSync(join(identityDir, 'BOOTSTRAP.md'))).toBe(true);
    const identityContent = readFileSync(join(identityDir, 'BOOTSTRAP.md'), 'utf-8');
    expect(identityContent).toContain('Bootstrap');
  });

  test('resetAgent copies USER_BOOTSTRAP.md to configDir only (not identityFilesDir)', async () => {
    writeFileSync(join(templatesDir, 'USER_BOOTSTRAP.md'), '# Welcome\nTell me about yourself.');

    await resetAgent('main', templatesDir);

    // Should exist in configDir (host reads it and passes via stdin)
    expect(existsSync(join(configDir, 'USER_BOOTSTRAP.md'))).toBe(true);
    const content = readFileSync(join(configDir, 'USER_BOOTSTRAP.md'), 'utf-8');
    expect(content).toContain('Welcome');

    // Should NOT exist in identityFilesDir (not mounted in sandbox)
    expect(existsSync(join(identityDir, 'USER_BOOTSTRAP.md'))).toBe(false);
  });

  test('resetAgent deletes .bootstrap-admin-claimed file', async () => {
    writeFileSync(join(topDir, '.bootstrap-admin-claimed'), 'U12345');

    await resetAgent('main', templatesDir);

    expect(existsSync(join(topDir, '.bootstrap-admin-claimed'))).toBe(false);
  });

  test('resetAgent is idempotent (no error if files missing)', async () => {
    // No files exist — should not throw
    await expect(resetAgent('main', templatesDir)).resolves.not.toThrow();
  });
});
