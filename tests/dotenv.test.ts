import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { loadDotEnv, loadCredentials } from '../src/dotenv.js';
import type { CredentialProvider } from '../src/providers/credentials/types.js';

describe('loadDotEnv', () => {
  let tmpDir: string;
  const savedEnv: Record<string, string | undefined> = {};
  const testKeys = [
    'SC_TEST_KEY', 'SC_TEST_QUOTED', 'SC_TEST_EXISTING', 'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN', 'AX_OAUTH_REFRESH_TOKEN', 'AX_OAUTH_EXPIRES_AT',
  ];

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

  test('loads key=value pairs into process.env', async () => {
    writeFileSync(join(tmpDir, '.env'), 'SC_TEST_KEY=hello-world\n');
    await loadDotEnv();
    expect(process.env.SC_TEST_KEY).toBe('hello-world');
  });

  test('strips surrounding quotes from values', async () => {
    writeFileSync(join(tmpDir, '.env'), 'SC_TEST_QUOTED="my-quoted-value"\n');
    await loadDotEnv();
    expect(process.env.SC_TEST_QUOTED).toBe('my-quoted-value');
  });

  test('does not override existing env vars', async () => {
    process.env.SC_TEST_EXISTING = 'original';
    writeFileSync(join(tmpDir, '.env'), 'SC_TEST_EXISTING=overwritten\n');
    await loadDotEnv();
    expect(process.env.SC_TEST_EXISTING).toBe('original');
  });

  test('skips comments and blank lines', async () => {
    writeFileSync(join(tmpDir, '.env'), '# comment\n\nSC_TEST_KEY=value\n');
    await loadDotEnv();
    expect(process.env.SC_TEST_KEY).toBe('value');
  });

  test('no-op when .env does not exist', async () => {
    // Don't write any .env file
    await loadDotEnv();
    expect(process.env.SC_TEST_KEY).toBeUndefined();
  });

  test('re-load picks up .env created after first call', async () => {
    // First call: no .env exists — should be a no-op
    await loadDotEnv();
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();

    // Simulate configure wizard writing .env
    writeFileSync(join(tmpDir, '.env'), 'ANTHROPIC_API_KEY=sk-ant-test-key-123\n');

    // Second call: .env now exists — should load the key
    await loadDotEnv();
    expect(process.env.ANTHROPIC_API_KEY).toBe('sk-ant-test-key-123');
  });

  // OAuth refresh tests moved to credential provider tests.
  // loadDotEnv() is now a simple .env → process.env loader.
});

describe('loadCredentials', () => {
  const savedEnv: Record<string, string | undefined> = {};
  const testKeys = [
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN', 'AX_OAUTH_REFRESH_TOKEN', 'AX_OAUTH_EXPIRES_AT',
  ];

  beforeEach(() => {
    for (const key of testKeys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of testKeys) {
      if (savedEnv[key] !== undefined) {
        process.env[key] = savedEnv[key];
      } else {
        delete process.env[key];
      }
    }
  });

  function mockProvider(store: Record<string, string>): CredentialProvider {
    return {
      get: async (key: string) => store[key] ?? null,
      set: async (key: string, val: string) => { store[key] = val; },
      delete: async (key: string) => { delete store[key]; },
      list: async () => Object.keys(store),
      listScopePrefix: async () => [],
    };
  }

  test('credentials.yaml values override stale .env values in process.env', async () => {
    // Simulate loadDotEnv() having loaded a stale token from .env
    process.env.AX_OAUTH_REFRESH_TOKEN = 'stale-refresh-token-from-dotenv';
    process.env.AX_OAUTH_EXPIRES_AT = String(Math.floor(Date.now() / 1000) + 99999);

    // Credential provider (credentials.yaml) has the fresh token
    const provider = mockProvider({
      AX_OAUTH_REFRESH_TOKEN: 'fresh-refresh-token-from-yaml',
      AX_OAUTH_EXPIRES_AT: String(Math.floor(Date.now() / 1000) + 99999),
    });

    await loadCredentials(provider);

    // Fresh token from credentials.yaml should win
    expect(process.env.AX_OAUTH_REFRESH_TOKEN).toBe('fresh-refresh-token-from-yaml');
  });

  test('seeds process.env from provider when no prior value exists', async () => {
    const provider = mockProvider({
      ANTHROPIC_API_KEY: 'sk-from-provider',
    });

    await loadCredentials(provider);

    expect(process.env.ANTHROPIC_API_KEY).toBe('sk-from-provider');
  });
});
