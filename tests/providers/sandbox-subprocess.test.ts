import { describe, test, expect } from 'vitest';
import { create } from '../../src/providers/sandbox/subprocess.js';
import type { Config } from '../../src/providers/types.js';

const mockConfig = {
  profile: 'paranoid',
  providers: { llm: 'anthropic', memory: 'file', scanner: 'basic', channels: ['cli'], web: 'none', browser: 'none', credentials: 'env', skills: 'readonly', audit: 'file', sandbox: 'subprocess', scheduler: 'none' },
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
      skills: '/tmp',
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
      skills: '/tmp',
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
      skills: '/tmp',
      ipcSocket: '/tmp/test.sock',
      command: ['sleep', '60'],
      timeoutSec: 1,
    });

    const code = await proc.exitCode;
    expect(code).not.toBe(0);
  }, 5000);

  test('provider.kill terminates by pid', async () => {
    const provider = await create(mockConfig);
    const proc = await provider.spawn({
      workspace: '/tmp',
      skills: '/tmp',
      ipcSocket: '/tmp/test.sock',
      command: ['sleep', '60'],
    });

    await provider.kill(proc.pid);
    const code = await proc.exitCode;
    expect(code).not.toBe(0);
  });
});
