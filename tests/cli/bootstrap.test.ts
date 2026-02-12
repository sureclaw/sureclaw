import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { resetAgent } from '../../src/cli/bootstrap.js';

describe('bootstrap command', () => {
  let agentDir: string;

  beforeEach(() => {
    agentDir = join(tmpdir(), `ax-test-bootstrap-${randomUUID()}`);
    mkdirSync(agentDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(agentDir, { recursive: true, force: true });
  });

  test('resetAgent deletes SOUL.md, IDENTITY.md, USER.md', async () => {
    writeFileSync(join(agentDir, 'SOUL.md'), '# Old soul');
    writeFileSync(join(agentDir, 'IDENTITY.md'), '# Old identity');
    writeFileSync(join(agentDir, 'USER.md'), '# Old user');
    writeFileSync(join(agentDir, 'AGENT.md'), '# Rules');

    await resetAgent(agentDir);

    expect(existsSync(join(agentDir, 'SOUL.md'))).toBe(false);
    expect(existsSync(join(agentDir, 'IDENTITY.md'))).toBe(false);
    expect(existsSync(join(agentDir, 'USER.md'))).toBe(false);
    // AGENT.md should NOT be deleted
    expect(existsSync(join(agentDir, 'AGENT.md'))).toBe(true);
  });

  test('resetAgent copies default BOOTSTRAP.md', async () => {
    await resetAgent(agentDir);

    expect(existsSync(join(agentDir, 'BOOTSTRAP.md'))).toBe(true);
    const content = readFileSync(join(agentDir, 'BOOTSTRAP.md'), 'utf-8');
    expect(content).toContain('Bootstrap');
  });

  test('resetAgent is idempotent (no error if files missing)', async () => {
    // No files exist — should not throw
    await expect(resetAgent(agentDir)).resolves.not.toThrow();
  });
});
