// tests/providers/sandbox/k8s.test.ts — k8s sandbox provider tests
//
// Tests the k8s SandboxProvider with mocked @kubernetes/client-node.
// No real k8s cluster is needed for these unit tests.

import { describe, test, expect, vi, beforeEach } from 'vitest';
import type { Config } from '../../../src/types.js';
import type { SandboxConfig } from '../../../src/providers/sandbox/types.js';

// Mock @kubernetes/client-node
const mockCreateNamespacedPod = vi.fn().mockResolvedValue({ body: {} });
const mockDeleteNamespacedPod = vi.fn().mockResolvedValue({ body: {} });
const mockListNamespacedPod = vi.fn().mockResolvedValue({ body: { items: [] } });
const mockReadNamespacedPodLog = vi.fn().mockRejectedValue(new Error('not ready'));
const mockReadNamespacedPersistentVolumeClaim = vi.fn().mockRejectedValue(
  Object.assign(new Error('not found'), { response: { statusCode: 404 } }),
);
const mockCreateNamespacedPersistentVolumeClaim = vi.fn().mockResolvedValue({ body: {} });
const mockWatch = vi.fn().mockImplementation((_path: string, _query: any, callback: any, _done: any) => {
  // Simulate immediate success
  setTimeout(() => {
    callback('MODIFIED', {
      status: { phase: 'Succeeded', containerStatuses: [{ state: { terminated: { exitCode: 0 } } }] },
    });
  }, 10);
  return { abort: vi.fn() };
});

class MockKubeConfig {
  loadFromCluster() {
    throw new Error('not in cluster');
  }
  loadFromDefault() {}
  makeApiClient() {
    return {
      createNamespacedPod: mockCreateNamespacedPod,
      deleteNamespacedPod: mockDeleteNamespacedPod,
      listNamespacedPod: mockListNamespacedPod,
      readNamespacedPodLog: mockReadNamespacedPodLog,
      readNamespacedPersistentVolumeClaim: mockReadNamespacedPersistentVolumeClaim,
      createNamespacedPersistentVolumeClaim: mockCreateNamespacedPersistentVolumeClaim,
    };
  }
}

class MockWatch {
  constructor(_kc: any) {}
  watch = mockWatch;
}

class MockAttach {
  constructor(_kc: any) {}
  attach = vi.fn();
}

class MockExec {
  constructor(_kc: any) {}
  exec = vi.fn();
}

vi.mock('@kubernetes/client-node', () => ({
  KubeConfig: MockKubeConfig,
  CoreV1Api: class {},
  Attach: MockAttach,
  Exec: MockExec,
  Watch: MockWatch,
}));

function mockConfig(): Config {
  return {
    profile: 'balanced',
    providers: {
      memory: 'cortex', security: 'patterns',
      channels: ['cli'], web: { extract: 'none', search: 'none' },
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

function mockSandboxConfig(): SandboxConfig {
  return {
    workspace: '/tmp/test-workspace',
    ipcSocket: '/tmp/test-ipc.sock',
    timeoutSec: 30,
    memoryMB: 256,
    command: ['node', 'runner.js'],
  };
}

describe('sandbox-k8s provider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('create returns a valid SandboxProvider', async () => {
    const { create } = await import('../../../src/providers/sandbox/k8s.js');
    const provider = await create(mockConfig());

    expect(provider.spawn).toBeTypeOf('function');
    expect(provider.kill).toBeTypeOf('function');
    expect(provider.isAvailable).toBeTypeOf('function');
  });

  test('spawn creates a k8s pod', async () => {
    const { create } = await import('../../../src/providers/sandbox/k8s.js');
    const provider = await create(mockConfig());

    const proc = await provider.spawn(mockSandboxConfig());

    expect(mockCreateNamespacedPod).toHaveBeenCalledOnce();
    const callArgs = mockCreateNamespacedPod.mock.calls[0][0];
    expect(callArgs.namespace).toBe('ax');
    expect(callArgs.body.spec.runtimeClassName).toBe('gvisor');
    expect(callArgs.body.spec.containers[0].image).toBe('ax/agent:latest');
    expect(callArgs.body.spec.containers[0].command).toEqual(['node', 'runner.js']);

    expect(proc.pid).toBeGreaterThan(0);
    expect(proc.exitCode).toBeInstanceOf(Promise);
    expect(proc.stdout).toBeDefined();
    expect(proc.stderr).toBeDefined();
    expect(proc.stdin).toBeDefined();
    expect(typeof proc.kill).toBe('function');
  });

  test('pod metadata includes execution plane label for network policy matching', async () => {
    const { create } = await import('../../../src/providers/sandbox/k8s.js');
    const provider = await create(mockConfig());
    await provider.spawn(mockSandboxConfig());

    const labels = mockCreateNamespacedPod.mock.calls[0][0].body.metadata.labels;
    expect(labels['ax.io/plane']).toBe('execution');
    expect(labels['app.kubernetes.io/component']).toBe('execution');
  });

  test('pod spec includes security hardening', async () => {
    const { create } = await import('../../../src/providers/sandbox/k8s.js');
    const provider = await create(mockConfig());
    await provider.spawn(mockSandboxConfig());

    const podSpec = mockCreateNamespacedPod.mock.calls[0][0].body.spec;
    const container = podSpec.containers[0];

    expect(container.securityContext.readOnlyRootFilesystem).toBe(false);
    expect(container.securityContext.allowPrivilegeEscalation).toBe(false);
    expect(container.securityContext.runAsNonRoot).toBe(true);
    expect(container.securityContext.capabilities.drop).toEqual(['ALL']);
    expect(podSpec.automountServiceAccountToken).toBe(false);
    expect(podSpec.hostNetwork).toBe(false);
    expect(podSpec.restartPolicy).toBe('Never');
  });

  test('pod spec includes resource limits from config', async () => {
    const { create } = await import('../../../src/providers/sandbox/k8s.js');
    const provider = await create(mockConfig());
    await provider.spawn(mockSandboxConfig());

    const container = mockCreateNamespacedPod.mock.calls[0][0].body.spec.containers[0];
    expect(container.resources.limits.memory).toBe('256Mi');
    expect(container.resources.requests.memory).toBe('256Mi');
  });

  test('pod does not include NATS env vars', async () => {
    const { create } = await import('../../../src/providers/sandbox/k8s.js');
    const provider = await create(mockConfig());
    await provider.spawn(mockSandboxConfig());

    const env = mockCreateNamespacedPod.mock.calls[0][0].body.spec.containers[0].env;
    const natsEnv = env.find((e: any) => e.name === 'NATS_URL');
    expect(natsEnv).toBeUndefined();
  });

  test('pod excludes AX_IPC_SOCKET (k8s uses HTTP IPC via AX_HOST_URL)', async () => {
    const { create } = await import('../../../src/providers/sandbox/k8s.js');
    const provider = await create(mockConfig());
    await provider.spawn(mockSandboxConfig());

    const env = mockCreateNamespacedPod.mock.calls[0][0].body.spec.containers[0].env;
    const socketEnv = env.find((e: any) => e.name === 'AX_IPC_SOCKET');
    expect(socketEnv).toBeUndefined();
  });

  test('pod includes activeDeadlineSeconds as safety net (timeoutSec + 300s buffer)', async () => {
    const { create } = await import('../../../src/providers/sandbox/k8s.js');
    const provider = await create(mockConfig());
    await provider.spawn(mockSandboxConfig());

    const spec = mockCreateNamespacedPod.mock.calls[0][0].body.spec;
    // timeoutSec (30) + 300s buffer = 330
    expect(spec.activeDeadlineSeconds).toBe(330);
  });

  test('exitCode resolves when pod succeeds and pod is deleted', async () => {
    const { create } = await import('../../../src/providers/sandbox/k8s.js');
    const provider = await create(mockConfig());

    const proc = await provider.spawn(mockSandboxConfig());
    const code = await proc.exitCode;
    expect(code).toBe(0);

    // Self-cleanup: pod should be deleted after exit
    await new Promise(r => setTimeout(r, 10));
    expect(mockDeleteNamespacedPod).toHaveBeenCalledWith(
      expect.objectContaining({ gracePeriodSeconds: 0 }),
    );
  });

  test('exitCode resolves with non-zero on pod failure', async () => {
    mockWatch.mockImplementationOnce((_path: string, _query: any, callback: any) => {
      setTimeout(() => {
        callback('MODIFIED', {
          status: { phase: 'Failed', containerStatuses: [{ state: { terminated: { exitCode: 137 } } }] },
        });
      }, 10);
      return { abort: vi.fn() };
    });

    const { create } = await import('../../../src/providers/sandbox/k8s.js');
    const provider = await create(mockConfig());

    const proc = await provider.spawn(mockSandboxConfig());
    const code = await proc.exitCode;
    expect(code).toBe(137);
  });

  test('kill() deletes the pod', async () => {
    const { create } = await import('../../../src/providers/sandbox/k8s.js');
    const provider = await create(mockConfig());

    const proc = await provider.spawn(mockSandboxConfig());
    proc.kill();

    await new Promise((r) => setTimeout(r, 10));
    expect(mockDeleteNamespacedPod).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: 'ax' }),
    );
  });

  test('kill(pid) deletes pod by PID lookup', async () => {
    const { create } = await import('../../../src/providers/sandbox/k8s.js');
    const provider = await create(mockConfig());

    const proc = await provider.spawn(mockSandboxConfig());
    await provider.kill(proc.pid);

    expect(mockDeleteNamespacedPod).toHaveBeenCalled();
  });

  test('kill(pid) is no-op for unknown PID', async () => {
    const { create } = await import('../../../src/providers/sandbox/k8s.js');
    const provider = await create(mockConfig());

    await provider.kill(999999);
    expect(mockDeleteNamespacedPod).not.toHaveBeenCalled();
  });

  test('isAvailable checks k8s API connectivity', async () => {
    const { create } = await import('../../../src/providers/sandbox/k8s.js');
    const provider = await create(mockConfig());

    const available = await provider.isAvailable();
    expect(available).toBe(true);
    expect(mockListNamespacedPod).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: 'ax', limit: 1 }),
    );
  });

  test('isAvailable returns false when k8s API fails', async () => {
    mockListNamespacedPod.mockRejectedValueOnce(new Error('unauthorized'));

    const { create } = await import('../../../src/providers/sandbox/k8s.js');
    const provider = await create(mockConfig());

    const available = await provider.isAvailable();
    expect(available).toBe(false);
  });

  test('pod has writable root filesystem for package installs', async () => {
    const { create } = await import('../../../src/providers/sandbox/k8s.js');
    const provider = await create(mockConfig());
    await provider.spawn(mockSandboxConfig());

    const container = mockCreateNamespacedPod.mock.calls[0][0].body.spec.containers[0];
    expect(container.securityContext.readOnlyRootFilesystem).toBe(false);
  });

  test('pod includes extraEnv vars from SandboxConfig', async () => {
    const { create } = await import('../../../src/providers/sandbox/k8s.js');
    const provider = await create(mockConfig());

    const config = {
      ...mockSandboxConfig(),
      extraEnv: {
        AX_IPC_TOKEN: 'tok-abc-123',
        AX_IPC_REQUEST_ID: 'req-456',
      },
    };
    await provider.spawn(config);

    const env = mockCreateNamespacedPod.mock.calls[0][0].body.spec.containers[0].env;
    const tokenEnv = env.find((e: any) => e.name === 'AX_IPC_TOKEN');
    const reqIdEnv = env.find((e: any) => e.name === 'AX_IPC_REQUEST_ID');
    expect(tokenEnv).toEqual({ name: 'AX_IPC_TOKEN', value: 'tok-abc-123' });
    expect(reqIdEnv).toEqual({ name: 'AX_IPC_REQUEST_ID', value: 'req-456' });
  });

  test('ensurePvc creates PVC with configured size', async () => {
    const { create } = await import('../../../src/providers/sandbox/k8s.js');
    const provider = await create(mockConfig());

    const config: SandboxConfig = {
      ...mockSandboxConfig(),
      pvcName: 'ax-workspace-test',
      workspaceSizeGi: 20,
    };
    await provider.spawn(config);

    expect(mockReadNamespacedPersistentVolumeClaim).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'ax-workspace-test' }),
    );
    expect(mockCreateNamespacedPersistentVolumeClaim).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          spec: expect.objectContaining({
            resources: { requests: { storage: '20Gi' } },
          }),
        }),
      }),
    );
  });

  test('ensurePvc defaults to 10Gi when workspaceSizeGi not set', async () => {
    const { create } = await import('../../../src/providers/sandbox/k8s.js');
    const provider = await create(mockConfig());

    const config: SandboxConfig = {
      ...mockSandboxConfig(),
      pvcName: 'ax-workspace-default',
    };
    await provider.spawn(config);

    expect(mockCreateNamespacedPersistentVolumeClaim).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          spec: expect.objectContaining({
            resources: { requests: { storage: '10Gi' } },
          }),
        }),
      }),
    );
  });

  test('workspace volume uses PVC when pvcName is set', async () => {
    const { create } = await import('../../../src/providers/sandbox/k8s.js');
    const provider = await create(mockConfig());

    const config: SandboxConfig = {
      ...mockSandboxConfig(),
      pvcName: 'ax-workspace-test',
    };
    await provider.spawn(config);

    const volumes = mockCreateNamespacedPod.mock.calls[0][0].body.spec.volumes;
    const wsVol = volumes.find((v: any) => v.name === 'workspace');
    expect(wsVol.persistentVolumeClaim).toEqual({ claimName: 'ax-workspace-test' });
  });
});
