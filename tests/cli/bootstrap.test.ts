import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { resetAgent } from '../../src/cli/bootstrap.js';

describe('bootstrap command', () => {
  let defDir: string;
  let stateDir: string;

  beforeEach(() => {
    const id = randomUUID();
    defDir = join(tmpdir(), `ax-test-def-${id}`);
    stateDir = join(tmpdir(), `ax-test-state-${id}`);
    mkdirSync(defDir, { recursive: true });
    mkdirSync(stateDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(defDir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });

  test('resetAgent deletes SOUL.md and IDENTITY.md from stateDir', async () => {
    writeFileSync(join(stateDir, 'SOUL.md'), '# Old soul');
    writeFileSync(join(stateDir, 'IDENTITY.md'), '# Old identity');
    writeFileSync(join(defDir, 'AGENTS.md'), '# Rules');

    await resetAgent(defDir, stateDir);

    expect(existsSync(join(stateDir, 'SOUL.md'))).toBe(false);
    expect(existsSync(join(stateDir, 'IDENTITY.md'))).toBe(false);
    // AGENTS.md in defDir should NOT be deleted
    expect(existsSync(join(defDir, 'AGENTS.md'))).toBe(true);
  });

  test('resetAgent does not delete per-user USER.md files', async () => {
    const userDir = join(stateDir, 'users', 'U12345');
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, 'USER.md'), '# User prefs');

    await resetAgent(defDir, stateDir);

    expect(existsSync(join(userDir, 'USER.md'))).toBe(true);
  });

  test('resetAgent copies BOOTSTRAP.md from defDir to stateDir', async () => {
    writeFileSync(join(defDir, 'BOOTSTRAP.md'), '# Bootstrap\nDiscover yourself.');

    await resetAgent(defDir, stateDir);

    expect(existsSync(join(stateDir, 'BOOTSTRAP.md'))).toBe(true);
    const content = readFileSync(join(stateDir, 'BOOTSTRAP.md'), 'utf-8');
    expect(content).toContain('Bootstrap');
  });

  test('resetAgent is idempotent (no error if files missing)', async () => {
    // No files exist — should not throw
    await expect(resetAgent(defDir, stateDir)).resolves.not.toThrow();
  });
});
