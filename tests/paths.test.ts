import { describe, test, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { isValidSessionId, workspaceDir, agentDir, agentStateDir, agentUserDir, axHome, composeSessionId, parseSessionId } from '../src/paths.js';

describe('paths', () => {
  const originalEnv = process.env.AX_HOME;

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.AX_HOME = originalEnv;
    } else {
      delete process.env.AX_HOME;
    }
  });

  test('defaults to ~/.ax', async () => {
    delete process.env.AX_HOME;
    const { axHome, configPath, envPath, dataDir } = await import('../src/paths.js');
    expect(axHome()).toBe(join(homedir(), '.ax'));
    expect(configPath()).toBe(join(homedir(), '.ax', 'ax.yaml'));
    expect(envPath()).toBe(join(homedir(), '.ax', '.env'));
    expect(dataDir()).toBe(join(homedir(), '.ax', 'data'));
  });

  test('respects AX_HOME env override', async () => {
    process.env.AX_HOME = '/tmp/sc-test';
    const { axHome, configPath, dataDir } = await import('../src/paths.js');
    expect(axHome()).toBe('/tmp/sc-test');
    expect(configPath()).toBe('/tmp/sc-test/ax.yaml');
    expect(dataDir()).toBe('/tmp/sc-test/data');
  });

  test('dataFile resolves under data dir', async () => {
    delete process.env.AX_HOME;
    const { dataFile } = await import('../src/paths.js');
    expect(dataFile('memory.db')).toBe(join(homedir(), '.ax', 'data', 'memory.db'));
    expect(dataFile('audit', 'audit.jsonl')).toBe(
      join(homedir(), '.ax', 'data', 'audit', 'audit.jsonl'),
    );
  });

  test('workspaceDir returns flat path for UUIDs', () => {
    process.env.AX_HOME = '/tmp/sc-test';
    expect(workspaceDir('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')).toBe(
      '/tmp/sc-test/data/workspaces/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    );
  });

  test('workspaceDir returns nested path for colon-separated IDs', () => {
    process.env.AX_HOME = '/tmp/sc-test';
    expect(workspaceDir('main:cli:default')).toBe(
      '/tmp/sc-test/data/workspaces/main/cli/default',
    );
    expect(workspaceDir('main:slack:dm:U1234')).toBe(
      '/tmp/sc-test/data/workspaces/main/slack/dm/U1234',
    );
    expect(workspaceDir('main:slack:thread:1234.5')).toBe(
      '/tmp/sc-test/data/workspaces/main/slack/thread/1234.5',
    );
  });

  test('composeSessionId joins parts with colon and validates', () => {
    expect(composeSessionId('main', 'cli', 'default')).toBe('main:cli:default');
    expect(composeSessionId('main', 'slack', 'dm', 'U1234')).toBe('main:slack:dm:U1234');
  });

  test('composeSessionId rejects invalid segments', () => {
    expect(() => composeSessionId('main', 'cli')).toThrow('at least 3 segments');
    expect(() => composeSessionId('main', '', 'default')).toThrow('Invalid session ID segment');
    expect(() => composeSessionId('main', 'cli', '../etc')).toThrow('Invalid session ID segment');
    expect(() => composeSessionId('main', 'cli', 'foo/bar')).toThrow('Invalid session ID segment');
  });

  test('parseSessionId returns array for colon-format, null for UUIDs', () => {
    expect(parseSessionId('main:cli:default')).toEqual(['main', 'cli', 'default']);
    expect(parseSessionId('main:slack:dm:U1234')).toEqual(['main', 'slack', 'dm', 'U1234']);
    expect(parseSessionId('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')).toBeNull();
    expect(parseSessionId('not-valid')).toBeNull();
    expect(parseSessionId('main:cli')).toBeNull(); // too few segments
  });

  test('composeSessionId and parseSessionId round-trip', () => {
    const id = composeSessionId('main', 'cli', 'project-x');
    const parts = parseSessionId(id);
    expect(parts).toEqual(['main', 'cli', 'project-x']);
    expect(composeSessionId(...parts!)).toBe(id);
  });

  test('isValidSessionId accepts valid UUIDs', () => {
    expect(isValidSessionId('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
    expect(isValidSessionId('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')).toBe(true);
    expect(isValidSessionId('12345678-1234-1234-1234-123456789abc')).toBe(true);
  });

  test('isValidSessionId rejects path traversal and invalid strings', () => {
    expect(isValidSessionId('../../../etc/passwd')).toBe(false);
    expect(isValidSessionId('hello')).toBe(false);
    expect(isValidSessionId('')).toBe(false);
    expect(isValidSessionId('AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE')).toBe(false); // uppercase
    expect(isValidSessionId('550e8400-e29b-41d4-a716-44665544000')).toBe(false); // too short
    expect(isValidSessionId('550e8400-e29b-41d4-a716-4466554400000')).toBe(false); // too long
    expect(isValidSessionId('not-a-uuid-at-all')).toBe(false);
  });

  test('isValidSessionId accepts colon-separated session IDs', () => {
    expect(isValidSessionId('main:cli:default')).toBe(true);
    expect(isValidSessionId('main:slack:dm:U1234')).toBe(true);
    expect(isValidSessionId('main:slack:thread:1234567.343')).toBe(true);
    expect(isValidSessionId('main:slack:channel:C12345')).toBe(true);
    expect(isValidSessionId('main:slack:group:G12345')).toBe(true);
    expect(isValidSessionId('main:cli:project-x')).toBe(true);
    expect(isValidSessionId('agent_2:cli:my.project')).toBe(true);
  });

  test('isValidSessionId rejects invalid colon-separated IDs', () => {
    expect(isValidSessionId('../bad:cli:x')).toBe(false);  // path traversal
    expect(isValidSessionId('main::x')).toBe(false);       // empty segment
    expect(isValidSessionId('main:cli:')).toBe(false);     // trailing empty segment
    expect(isValidSessionId(':cli:x')).toBe(false);        // leading empty segment
    expect(isValidSessionId('main:cli')).toBe(false);      // too few segments (only 2)
    expect(isValidSessionId('main:cli:foo/bar')).toBe(false); // slash in segment
    expect(isValidSessionId('main:cli:foo bar')).toBe(false); // space in segment
  });

  test('agentDir returns ~/.ax/agents/<name>', () => {
    expect(agentDir('assistant')).toBe(join(axHome(), 'agents', 'assistant'));
  });

  test('agentStateDir is a deprecated alias for agentDir', () => {
    expect(agentStateDir('assistant')).toBe(agentDir('assistant'));
  });

  test('agentUserDir returns ~/.ax/agents/<name>/users/<userId>', () => {
    expect(agentUserDir('assistant', 'U12345')).toBe(
      join(axHome(), 'agents', 'assistant', 'users', 'U12345'),
    );
  });

  test('agentUserDir rejects path traversal in userId', () => {
    expect(() => agentUserDir('assistant', '../etc')).toThrow();
    expect(() => agentUserDir('assistant', 'foo/bar')).toThrow();
    expect(() => agentUserDir('assistant', '')).toThrow();
  });

  test('agentDir rejects path traversal in agent name', () => {
    expect(() => agentDir('../etc')).toThrow();
  });
});
