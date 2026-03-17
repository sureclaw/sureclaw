// tests/providers/sandbox/k8s-warm-pool.test.ts — Tests for k8s provider (cold start only)
//
// Warm pool claiming is now handled by NATS queue groups in host-process.ts,
// not by the k8s sandbox provider. The provider always cold-starts a pod.

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SandboxConfig } from '../../../src/providers/sandbox/types.js';

const mockCreateNamespacedPod = vi.fn().mockResolvedValue({ body: {} });
const mockDeleteNamespacedPod = vi.fn().mockResolvedValue({ body: {} });
const mockListNamespacedPod = vi.fn().mockResolvedValue({ items: [] });
const mockReadNamespacedPod = vi.fn().mockResolvedValue({ status: { phase: 'Running' } });
const mockWatch = vi.fn().mockImplementation((_path: string, _query: any, callback: any) => {
  setTimeout(() => {
    callback('MODIFIED', {
      status: { phase: 'Succeeded', containerStatuses: [{ state: { terminated: { exitCode: 0 } } }] },
    });
  }, 10);
  return { abort: vi.fn() };
});

class MockKubeConfig {
  loadFromCluster() { throw new Error('not in cluster'); }
  loadFromDefault() {}
  makeApiClient() {
    return {
      createNamespacedPod: mockCreateNamespacedPod,
      deleteNamespacedPod: mockDeleteNamespacedPod,
      listNamespacedPod: mockListNamespacedPod,
      readNamespacedPod: mockReadNamespacedPod,
    };
  }
}

vi.mock('@kubernetes/client-node', () => ({
  KubeConfig: MockKubeConfig,
  CoreV1Api: class {},
  Watch: class {
    constructor(_kc: any) {}
    watch = mockWatch;
  },
}));

function mockConfig() {
  return {
    profile: 'balanced' as const,
    providers: {
      memory: 'cortex', scanner: 'patterns',
      channels: ['cli'], web: 'none', browser: 'none',
      credentials: 'keychain', skills: 'database', audit: 'database',
      sandbox: 'k8s', scheduler: 'none',
    },
    sandbox: { timeout_sec: 30, memory_mb: 256 },
    scheduler: {
      active_hours: { start: '08:00', end: '22:00', timezone: 'UTC' },
      max_token_budget: 1000,
      heartbeat_interval_min: 5,
    },
  };
}

describe('k8s provider (cold start, NATS queue group claiming)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateNamespacedPod.mockResolvedValue({ body: {} });
    mockDeleteNamespacedPod.mockResolvedValue({ body: {} });
    mockListNamespacedPod.mockResolvedValue({ items: [] });
    mockReadNamespacedPod.mockResolvedValue({ status: { phase: 'Running' } });
    mockWatch.mockImplementation((_path: string, _query: any, callback: any) => {
      setTimeout(() => {
        callback('MODIFIED', {
          status: { phase: 'Succeeded', containerStatuses: [{ state: { terminated: { exitCode: 0 } } }] },
        });
      }, 10);
      return { abort: vi.fn() };
    });
  });

  test('spawn always creates a new pod (cold start)', async () => {
    const { create } = await import('../../../src/providers/sandbox/k8s.js');
    const provider = await create(mockConfig());

    const config: SandboxConfig = {
      workspace: '/tmp/ws',
      ipcSocket: '/tmp/ipc.sock',
      command: ['node', 'runner.js'],
      timeoutSec: 30,
      memoryMB: 256,
    };

    const proc = await provider.spawn(config);

    expect(mockCreateNamespacedPod).toHaveBeenCalledOnce();
    expect(proc.pid).toBeGreaterThan(0);
    expect(proc.podName).toMatch(/^ax-sandbox-/);
  });

  test('pod has podName set for NATS work delivery', async () => {
    const { create } = await import('../../../src/providers/sandbox/k8s.js');
    const provider = await create(mockConfig());

    const config: SandboxConfig = {
      workspace: '/tmp/ws',
      ipcSocket: '/tmp/ipc.sock',
      command: ['node', 'runner.js'],
      timeoutSec: 30,
      memoryMB: 256,
    };

    const proc = await provider.spawn(config);

    expect(proc.podName).toMatch(/^ax-sandbox-/);
    expect(proc.pid).toBeGreaterThan(0);
  });

  test('kill deletes the pod', async () => {
    const { create } = await import('../../../src/providers/sandbox/k8s.js');
    const provider = await create(mockConfig());

    const config: SandboxConfig = {
      workspace: '/tmp/ws',
      ipcSocket: '/tmp/ipc.sock',
      command: ['node', 'runner.js'],
      timeoutSec: 30,
    };

    const proc = await provider.spawn(config);
    proc.kill();

    await new Promise(r => setTimeout(r, 10));
    expect(mockDeleteNamespacedPod).toHaveBeenCalledWith(
      expect.objectContaining({ name: proc.podName }),
    );
  });

  test('exit code resolves from pod watch', async () => {
    const { create } = await import('../../../src/providers/sandbox/k8s.js');
    const provider = await create(mockConfig());

    const config: SandboxConfig = {
      workspace: '/tmp/ws',
      ipcSocket: '/tmp/ipc.sock',
      command: ['node', 'runner.js'],
      timeoutSec: 30,
    };

    const proc = await provider.spawn(config);
    const exitCode = await proc.exitCode;
    expect(exitCode).toBe(0);
  });
});
