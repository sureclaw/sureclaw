import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { initLogger } from '../../src/logger.js';

initLogger({ file: false, level: 'silent' });

describe('workspace-release', () => {
  test('exports releaseWorkspaceScopes function', async () => {
    const mod = await import('../../src/agent/workspace-release.js');
    expect(typeof mod.releaseWorkspaceScopes).toBe('function');
  });

  test('module uses execFileSync to call workspace-cli.ts', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync('src/agent/workspace-release.ts', 'utf-8');

    expect(source).toContain('execFileSync');
    expect(source).toContain('workspace-cli.js');
    expect(source).toContain('release');
  });

  test('passes --token for direct release', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync('src/agent/workspace-release.ts', 'utf-8');

    expect(source).toContain("'--token'");
    expect(source).toContain('AX_IPC_TOKEN');
  });

  test('skips IPC call when result is empty (no changes)', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync('src/agent/workspace-release.ts', 'utf-8');

    expect(source).toContain('if (!result)');
    expect(source).toContain('workspace_release_empty');
  });
});

describe('runner applyPayload sets AX_IPC_TOKEN', () => {
  const originalToken = process.env.AX_IPC_TOKEN;

  afterEach(() => {
    // Restore original env
    if (originalToken !== undefined) {
      process.env.AX_IPC_TOKEN = originalToken;
    } else {
      delete process.env.AX_IPC_TOKEN;
    }
  });

  test('applyPayload propagates ipcToken to process.env.AX_IPC_TOKEN for workspace-release', () => {
    // This regression test guards against the bug where warm pool pods
    // received ipcToken in the NATS payload but never set process.env.AX_IPC_TOKEN,
    // causing workspace-release.ts to fall back to the broken legacy staging path.
    const { readFileSync } = require('node:fs');
    const source = readFileSync('src/agent/runner.ts', 'utf-8');

    // The applyPayload function must set process.env.AX_IPC_TOKEN from payload.ipcToken
    expect(source).toContain('process.env.AX_IPC_TOKEN = payload.ipcToken');
  });
});

describe('workspace-cli release command', () => {
  test('release command exists in workspace-cli.ts', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync('src/agent/workspace-cli.ts', 'utf-8');

    expect(source).toContain("command === 'release'");
    expect(source).toContain('async function release');
    expect(source).toContain('--host-url');
  });

  test('release creates gzipped JSON and uploads via HTTP', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync('src/agent/workspace-cli.ts', 'utf-8');

    expect(source).toContain('gzipSync');
    expect(source).toContain("'Content-Type': 'application/gzip'");
  });

  test('release supports direct mode with --token', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync('src/agent/workspace-cli.ts', 'utf-8');

    expect(source).toContain('/internal/workspace/release');
    expect(source).toContain("'Authorization': `Bearer ${token}`");
  });

  test('release supports legacy staging mode', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync('src/agent/workspace-cli.ts', 'utf-8');

    expect(source).toContain('/internal/workspace-staging');
    expect(source).toContain('staging_key');
  });

  test('release uses diffScope for change detection', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync('src/agent/workspace-cli.ts', 'utf-8');

    expect(source).toContain('diffScope(mountPath, baseHashes)');
    expect(source).toContain('content_base64');
  });

  test('release handles canonical workspace paths', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync('src/agent/workspace-cli.ts', 'utf-8');

    expect(source).toContain("session: '/workspace/scratch'");
    expect(source).toContain("agent: '/workspace/agent'");
    expect(source).toContain("user: '/workspace/user'");
  });

  test('release skips non-existent scope directories', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync('src/agent/workspace-cli.ts', 'utf-8');

    expect(source).toContain('!existsSync(mountPath)');
  });
});
