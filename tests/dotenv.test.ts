import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { loadDotEnv } from '../src/dotenv.js';

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

  test('refreshes expired OAuth token before returning', async () => {
    // Mock the OAuth refresh module to verify it's awaited (not fire-and-forget)
    const mockRefresh = vi.fn().mockResolvedValue({
      access_token: 'fresh-access-token',
      refresh_token: 'fresh-refresh-token',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    });

    vi.doMock('../src/host/oauth.js', () => ({
      refreshOAuthTokens: mockRefresh,
    }));

    // Re-import to pick up the mock
    const { loadDotEnv: loadDotEnvMocked } = await import('../src/dotenv.js');

    // Write .env with an expired token (expires_at in the past)
    const expiredAt = Math.floor(Date.now() / 1000) - 600; // 10 minutes ago
    writeFileSync(join(tmpDir, '.env'), [
      'AX_OAUTH_REFRESH_TOKEN=old-refresh-token',
      `AX_OAUTH_EXPIRES_AT=${expiredAt}`,
    ].join('\n'));

    await loadDotEnvMocked();

    // The refresh should have been called and awaited
    expect(mockRefresh).toHaveBeenCalledWith('old-refresh-token');

    // process.env should have the fresh token — proving the refresh
    // completed before loadDotEnv() returned
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('fresh-access-token');
    expect(process.env.AX_OAUTH_REFRESH_TOKEN).toBe('fresh-refresh-token');

    // The .env file should also be updated
    const envContent = readFileSync(join(tmpDir, '.env'), 'utf-8');
    expect(envContent).toContain('CLAUDE_CODE_OAUTH_TOKEN=fresh-access-token');

    vi.doUnmock('../src/host/oauth.js');
  });
});
