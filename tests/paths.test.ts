import { describe, test, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { isValidSessionId, workspaceDir } from '../src/paths.js';

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

  test('workspaceDir returns correct path', () => {
    process.env.AX_HOME = '/tmp/sc-test';
    expect(workspaceDir('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')).toBe(
      '/tmp/sc-test/data/workspaces/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    );
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
});
