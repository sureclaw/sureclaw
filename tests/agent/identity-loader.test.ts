import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { loadIdentityFiles } from '../../src/agent/identity-loader.js';

describe('loadIdentityFiles', () => {
  let agentDir: string;

  beforeEach(() => {
    agentDir = join(tmpdir(), `ax-agent-${randomUUID()}`);
    mkdirSync(agentDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(agentDir, { recursive: true, force: true });
  });

  test('reads AGENTS.md and BOOTSTRAP.md from agentDir', () => {
    writeFileSync(join(agentDir, 'AGENTS.md'), '# Operator rules');
    writeFileSync(join(agentDir, 'BOOTSTRAP.md'), '# Bootstrap');

    const files = loadIdentityFiles({ agentDir });
    expect(files.agents).toBe('# Operator rules');
    expect(files.bootstrap).toBe('# Bootstrap');
  });

  test('reads SOUL.md and IDENTITY.md from agentDir', () => {
    writeFileSync(join(agentDir, 'SOUL.md'), '# Soul');
    writeFileSync(join(agentDir, 'IDENTITY.md'), '# Identity');

    const files = loadIdentityFiles({ agentDir });
    expect(files.soul).toBe('# Soul');
    expect(files.identity).toBe('# Identity');
  });

  test('reads USER.md from agentDir/users/<userId>/', () => {
    const userDir = join(agentDir, 'users', 'U12345');
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, 'USER.md'), '# User prefs');

    const files = loadIdentityFiles({ agentDir, userId: 'U12345' });
    expect(files.user).toBe('# User prefs');
  });

  test('returns empty string for missing files', () => {
    const files = loadIdentityFiles({ agentDir });
    expect(files.agents).toBe('');
    expect(files.soul).toBe('');
    expect(files.identity).toBe('');
    expect(files.user).toBe('');
    expect(files.bootstrap).toBe('');
    expect(files.userBootstrap).toBe('');
    expect(files.heartbeat).toBe('');
  });

  test('returns empty user when no userId provided', () => {
    writeFileSync(join(agentDir, 'USER.md'), '# Should not be read');

    const files = loadIdentityFiles({ agentDir });
    expect(files.user).toBe('');
  });

  test('returns empty strings when agentDir is undefined', () => {
    const files = loadIdentityFiles({});
    expect(files.agents).toBe('');
    expect(files.soul).toBe('');
  });

  test('loads USER_BOOTSTRAP.md when USER.md is absent', () => {
    writeFileSync(join(agentDir, 'USER_BOOTSTRAP.md'), '# New User\nLearn about this user.');

    const files = loadIdentityFiles({ agentDir, userId: 'newuser' });
    expect(files.user).toBe('');
    expect(files.userBootstrap).toBe('# New User\nLearn about this user.');
  });

  test('skips USER_BOOTSTRAP.md when USER.md exists', () => {
    writeFileSync(join(agentDir, 'USER_BOOTSTRAP.md'), '# New User');
    const userDir = join(agentDir, 'users', 'existing');
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, 'USER.md'), '# Known user prefs');

    const files = loadIdentityFiles({ agentDir, userId: 'existing' });
    expect(files.user).toBe('# Known user prefs');
    expect(files.userBootstrap).toBe('');
  });

  test('reads HEARTBEAT.md from agentDir', () => {
    writeFileSync(join(agentDir, 'HEARTBEAT.md'), '# Heartbeat\nSchedule check-ins.');

    const files = loadIdentityFiles({ agentDir });
    expect(files.heartbeat).toBe('# Heartbeat\nSchedule check-ins.');
  });

  test('returns empty string for heartbeat when HEARTBEAT.md is absent', () => {
    const files = loadIdentityFiles({ agentDir });
    expect(files.heartbeat).toBe('');
  });

  test('truncates identity files exceeding 65536 characters', () => {
    const oversized = 'x'.repeat(70000);
    writeFileSync(join(agentDir, 'SOUL.md'), oversized);

    const files = loadIdentityFiles({ agentDir });
    expect(files.soul.length).toBe(65536);
    expect(files.soul).toBe('x'.repeat(65536));
  });

  test('does not truncate files within the character cap', () => {
    const content = 'y'.repeat(65536);
    writeFileSync(join(agentDir, 'AGENTS.md'), content);

    const files = loadIdentityFiles({ agentDir });
    expect(files.agents.length).toBe(65536);
  });

  test('returns preloaded identity data directly (no filesystem reads)', () => {
    // Even though agentDir has files on disk, preloaded data takes precedence
    writeFileSync(join(agentDir, 'SOUL.md'), '# Disk Soul');

    const preloaded = {
      agents: '# DB Agents',
      soul: '# DB Soul',
      identity: '# DB Identity',
      user: '# DB User',
      bootstrap: '# DB Bootstrap',
      userBootstrap: '',
      heartbeat: '# DB Heartbeat',
    };

    const files = loadIdentityFiles({ agentDir, preloaded });
    expect(files.soul).toBe('# DB Soul');
    expect(files.agents).toBe('# DB Agents');
    expect(files.identity).toBe('# DB Identity');
    expect(files.user).toBe('# DB User');
    expect(files.heartbeat).toBe('# DB Heartbeat');
  });

  test('reads all identity files from single directory', () => {
    writeFileSync(join(agentDir, 'AGENTS.md'), '# Agents');
    writeFileSync(join(agentDir, 'BOOTSTRAP.md'), '# Bootstrap');
    writeFileSync(join(agentDir, 'SOUL.md'), '# Soul');
    writeFileSync(join(agentDir, 'IDENTITY.md'), '# Identity');
    writeFileSync(join(agentDir, 'HEARTBEAT.md'), '# Heartbeat');
    const userDir = join(agentDir, 'users', 'alice');
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, 'USER.md'), '# Alice');

    const files = loadIdentityFiles({ agentDir, userId: 'alice' });
    expect(files.agents).toBe('# Agents');
    expect(files.bootstrap).toBe('# Bootstrap');
    expect(files.soul).toBe('# Soul');
    expect(files.identity).toBe('# Identity');
    expect(files.user).toBe('# Alice');
    expect(files.heartbeat).toBe('# Heartbeat');
  });
});
