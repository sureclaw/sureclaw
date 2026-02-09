import { describe, test, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { homedir } from 'node:os';

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
});
