import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { loadDotEnv } from '../src/dotenv.js';

describe('loadDotEnv', () => {
  let tmpDir: string;
  const savedEnv: Record<string, string | undefined> = {};
  const testKeys = ['SC_TEST_KEY', 'SC_TEST_QUOTED', 'SC_TEST_EXISTING', 'ANTHROPIC_API_KEY'];

  beforeEach(() => {
    tmpDir = join(tmpdir(), `dotenv-${randomUUID()}`);
    mkdirSync(tmpDir, { recursive: true });
    process.env.AX_HOME = tmpDir;
    // Save and clear test keys
    for (const key of testKeys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    // Restore original env
    for (const key of testKeys) {
      if (savedEnv[key] !== undefined) {
        process.env[key] = savedEnv[key];
      } else {
        delete process.env[key];
      }
    }
    delete process.env.AX_HOME;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('loads key=value pairs into process.env', () => {
    writeFileSync(join(tmpDir, '.env'), 'SC_TEST_KEY=hello-world\n');
    loadDotEnv();
    expect(process.env.SC_TEST_KEY).toBe('hello-world');
  });

  test('strips surrounding quotes from values', () => {
    writeFileSync(join(tmpDir, '.env'), 'SC_TEST_QUOTED="my-quoted-value"\n');
    loadDotEnv();
    expect(process.env.SC_TEST_QUOTED).toBe('my-quoted-value');
  });

  test('does not override existing env vars', () => {
    process.env.SC_TEST_EXISTING = 'original';
    writeFileSync(join(tmpDir, '.env'), 'SC_TEST_EXISTING=overwritten\n');
    loadDotEnv();
    expect(process.env.SC_TEST_EXISTING).toBe('original');
  });

  test('skips comments and blank lines', () => {
    writeFileSync(join(tmpDir, '.env'), '# comment\n\nSC_TEST_KEY=value\n');
    loadDotEnv();
    expect(process.env.SC_TEST_KEY).toBe('value');
  });

  test('no-op when .env does not exist', () => {
    // Don't write any .env file
    loadDotEnv();
    expect(process.env.SC_TEST_KEY).toBeUndefined();
  });

  test('re-load picks up .env created after first call', () => {
    // First call: no .env exists — should be a no-op
    loadDotEnv();
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();

    // Simulate configure wizard writing .env
    writeFileSync(join(tmpDir, '.env'), 'ANTHROPIC_API_KEY=sk-ant-test-key-123\n');

    // Second call: .env now exists — should load the key
    loadDotEnv();
    expect(process.env.ANTHROPIC_API_KEY).toBe('sk-ant-test-key-123');
  });
});
