import { describe, test, expect } from 'vitest';
import { create } from '../../../src/providers/sandbox/subprocess.js';
import type { Config } from '../../../src/types.js';

const mockConfig = {
  profile: 'paranoid',
  providers: { memory: 'cortex', scanner: 'patterns', channels: ['cli'], web: { extract: 'none', search: 'none' }, browser: 'none', credentials: 'keychain', skills: 'database', audit: 'database', sandbox: 'subprocess', scheduler: 'none' },
  sandbox: { timeout_sec: 120, memory_mb: 512 },
  scheduler: { active_hours: { start: '07:00', end: '23:00', timezone: 'America/New_York' }, max_token_budget: 4096, heartbeat_interval_min: 30 },
} as Config;

describe('sandbox-subprocess', () => {
  test('isAvailable returns true', async () => {
    const provider = await create(mockConfig);
    expect(await provider.isAvailable()).toBe(true);
  });

  test('spawns a process and captures output', async () => {
    const provider = await create(mockConfig);
    const proc = await provider.spawn({
      workspace: '/tmp',
      ipcSocket: '/tmp/test.sock',
      command: ['echo', 'hello from sandbox'],
      timeoutSec: 10,
    });

    expect(proc.pid).toBeGreaterThan(0);

    let output = '';
    for await (const chunk of proc.stdout) {
      output += chunk.toString();
    }

    const code = await proc.exitCode;
    expect(code).toBe(0);
    expect(output.trim()).toBe('hello from sandbox');
  });

  test('kill terminates the process', async () => {
    const provider = await create(mockConfig);
    const proc = await provider.spawn({
      workspace: '/tmp',
      ipcSocket: '/tmp/test.sock',
      command: ['sleep', '60'],
      timeoutSec: 30,
    });

    proc.kill();
    const code = await proc.exitCode;
    expect(code).not.toBe(0);
  });

  test('timeout kills long-running process', async () => {
    const provider = await create(mockConfig);
    const proc = await provider.spawn({
      workspace: '/tmp',
      ipcSocket: '/tmp/test.sock',
      command: ['sleep', '60'],
      timeoutSec: 1,
    });

    const code = await proc.exitCode;
    expect(code).not.toBe(0);
  }, 5000);

  test('extraEnv vars are passed to the spawned process', async () => {
    const provider = await create(mockConfig);
    const proc = await provider.spawn({
      workspace: '/tmp',
      ipcSocket: '/tmp/test.sock',
      command: ['sh', '-c', 'echo "$AX_TEST_CRED|$AX_TEST_CA"'],
      timeoutSec: 10,
      extraEnv: {
        AX_TEST_CRED: 'ax-cred:abc123',
        AX_TEST_CA: '/etc/ax/ca.crt',
      },
    });

    let output = '';
    for await (const chunk of proc.stdout) {
      output += chunk.toString();
    }

    const code = await proc.exitCode;
    expect(code).toBe(0);
    expect(output.trim()).toBe('ax-cred:abc123|/etc/ax/ca.crt');
  });

  test('provider.kill terminates by pid', async () => {
    const provider = await create(mockConfig);
    const proc = await provider.spawn({
      workspace: '/tmp',
      ipcSocket: '/tmp/test.sock',
      command: ['sleep', '60'],
    });

    await provider.kill(proc.pid);
    const code = await proc.exitCode;
    expect(code).not.toBe(0);
  });
});
