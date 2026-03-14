import { describe, test, expect, vi } from 'vitest';

import { createLocalSandboxDispatcher } from '../../src/host/local-sandbox-dispatch.js';
import type {
  SandboxProvider,
  SandboxConfig,
} from '../../src/providers/sandbox/types.js';

function mockSandboxProvider(): {
  provider: SandboxProvider;
  spawnCalls: SandboxConfig[];
} {
  const spawnCalls: SandboxConfig[] = [];
  const killFn = vi.fn();
  return {
    spawnCalls,
    provider: {
      async spawn(config: SandboxConfig) {
        spawnCalls.push(config);
        return {
          pid: 10000 + spawnCalls.length,
          exitCode: new Promise<number>(() => {}),
          stdout: {
            [Symbol.asyncIterator]: async function* () {},
          } as unknown as NodeJS.ReadableStream,
          stderr: {
            [Symbol.asyncIterator]: async function* () {},
          } as unknown as NodeJS.ReadableStream,
          stdin: {
            write: vi.fn(),
            end: vi.fn(),
          } as unknown as NodeJS.WritableStream,
          kill: killFn,
        };
      },
      async kill() {},
      async isAvailable() {
        return true;
      },
    },
  };
}

const dummyConfig: SandboxConfig = {
  workspace: '/tmp/test',
  ipcSocket: '/tmp/test.sock',
  command: ['node', 'runner.js'],
};

describe('LocalSandboxDispatcher', () => {
  test('hasSandbox returns false initially', () => {
    const { provider } = mockSandboxProvider();
    const d = createLocalSandboxDispatcher({
      provider,
      sandboxType: 'apple',
    });
    expect(d.hasSandbox('req-1')).toBe(false);
  });

  test('ensureSandbox spawns container for apple sandbox type', async () => {
    const { provider, spawnCalls } = mockSandboxProvider();
    const d = createLocalSandboxDispatcher({
      provider,
      sandboxType: 'apple',
    });
    await d.ensureSandbox('req-1', dummyConfig);
    expect(d.hasSandbox('req-1')).toBe(true);
    expect(spawnCalls.length).toBe(1);
  });

  test('ensureSandbox spawns container for docker sandbox type', async () => {
    const { provider, spawnCalls } = mockSandboxProvider();
    const d = createLocalSandboxDispatcher({
      provider,
      sandboxType: 'docker',
    });
    await d.ensureSandbox('req-1', dummyConfig);
    expect(d.hasSandbox('req-1')).toBe(true);
    expect(spawnCalls.length).toBe(1);
  });

  test('ensureSandbox is no-op for subprocess sandbox type', async () => {
    const { provider, spawnCalls } = mockSandboxProvider();
    const d = createLocalSandboxDispatcher({
      provider,
      sandboxType: 'subprocess',
    });
    await d.ensureSandbox('req-1', dummyConfig);
    expect(d.hasSandbox('req-1')).toBe(false); // no sandbox spawned
    expect(spawnCalls.length).toBe(0);
  });

  test('ensureSandbox is no-op for seatbelt sandbox type', async () => {
    const { provider, spawnCalls } = mockSandboxProvider();
    const d = createLocalSandboxDispatcher({
      provider,
      sandboxType: 'seatbelt',
    });
    await d.ensureSandbox('req-1', dummyConfig);
    expect(d.hasSandbox('req-1')).toBe(false);
    expect(spawnCalls.length).toBe(0);
  });

  test('ensureSandbox reuses existing sandbox on second call', async () => {
    const { provider, spawnCalls } = mockSandboxProvider();
    const d = createLocalSandboxDispatcher({
      provider,
      sandboxType: 'docker',
    });
    await d.ensureSandbox('req-1', dummyConfig);
    await d.ensureSandbox('req-1', dummyConfig);
    expect(spawnCalls.length).toBe(1); // only one spawn
  });

  test('release kills and removes sandbox', async () => {
    const { provider } = mockSandboxProvider();
    const d = createLocalSandboxDispatcher({
      provider,
      sandboxType: 'apple',
    });
    await d.ensureSandbox('req-1', dummyConfig);
    expect(d.hasSandbox('req-1')).toBe(true);
    await d.release('req-1');
    expect(d.hasSandbox('req-1')).toBe(false);
  });

  test('release is no-op if no sandbox exists', async () => {
    const { provider } = mockSandboxProvider();
    const d = createLocalSandboxDispatcher({
      provider,
      sandboxType: 'apple',
    });
    await d.release('req-1'); // should not throw
    expect(d.hasSandbox('req-1')).toBe(false);
  });

  test('close releases all active sandboxes', async () => {
    const { provider } = mockSandboxProvider();
    const d = createLocalSandboxDispatcher({
      provider,
      sandboxType: 'apple',
    });
    await d.ensureSandbox('req-1', dummyConfig);
    await d.ensureSandbox('req-2', dummyConfig);
    expect(d.hasSandbox('req-1')).toBe(true);
    expect(d.hasSandbox('req-2')).toBe(true);
    await d.close();
    expect(d.hasSandbox('req-1')).toBe(false);
    expect(d.hasSandbox('req-2')).toBe(false);
  });

  test('getSandboxProcess returns the process for a spawned sandbox', async () => {
    const { provider } = mockSandboxProvider();
    const d = createLocalSandboxDispatcher({
      provider,
      sandboxType: 'apple',
    });
    await d.ensureSandbox('req-1', dummyConfig);
    const proc = d.getSandboxProcess('req-1');
    expect(proc).toBeDefined();
    expect(proc!.pid).toBe(10001);
  });

  test('getSandboxProcess returns undefined when no sandbox exists', () => {
    const { provider } = mockSandboxProvider();
    const d = createLocalSandboxDispatcher({
      provider,
      sandboxType: 'apple',
    });
    expect(d.getSandboxProcess('req-1')).toBeUndefined();
  });
});
