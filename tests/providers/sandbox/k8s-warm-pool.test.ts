// tests/providers/sandbox/k8s-warm-pool.test.ts — Tests for warm pool integration in k8s provider
//
// Tests buildExecCommand and the warm pool spawn path.

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SandboxConfig } from '../../../src/providers/sandbox/types.js';

// ── buildExecCommand tests (pure function, no mocks needed) ──

describe('buildExecCommand', () => {
  beforeEach(() => {
    delete process.env.NATS_SANDBOX_PASS;
    delete process.env.K8S_POD_LOG_LEVEL;
  });

  afterEach(() => {
    delete process.env.NATS_SANDBOX_PASS;
    delete process.env.K8S_POD_LOG_LEVEL;
  });

  test('builds env command with canonical env vars', async () => {
    const { buildExecCommand } = await import('../../../src/providers/sandbox/k8s.js');

    const config: SandboxConfig = {
      workspace: '/tmp/ws',
      ipcSocket: '/tmp/ipc.sock',
      command: ['node', '/opt/ax/dist/agent/runner.js'],
    };

    const cmd = buildExecCommand(config, 'nats://nats:4222');

    expect(cmd[0]).toBe('env');
    expect(cmd).toContain('AX_IPC_TRANSPORT=nats');
    expect(cmd).toContain('NATS_URL=nats://nats:4222');
    expect(cmd).toContain('LOG_LEVEL=warn');
    // Agent command at the end
    expect(cmd.slice(-2)).toEqual(['node', '/opt/ax/dist/agent/runner.js']);
    // AX_IPC_SOCKET should not be present (using NATS instead)
    expect(cmd.find(c => c.startsWith('AX_IPC_SOCKET='))).toBeUndefined();
  });

  test('includes extraEnv from sandbox config', async () => {
    const { buildExecCommand } = await import('../../../src/providers/sandbox/k8s.js');

    const config: SandboxConfig = {
      workspace: '/tmp/ws',
      ipcSocket: '/tmp/ipc.sock',
      command: ['node', 'runner.js'],
      extraEnv: {
        AX_IPC_TOKEN: 'tok-123',
        AX_IPC_REQUEST_ID: 'req-456',
      },
    };

    const cmd = buildExecCommand(config, 'nats://nats:4222');

    expect(cmd).toContain('AX_IPC_TOKEN=tok-123');
    expect(cmd).toContain('AX_IPC_REQUEST_ID=req-456');
  });

  test('includes NATS credentials when NATS_SANDBOX_PASS is set', async () => {
    process.env.NATS_SANDBOX_PASS = 'secret-pass';

    const { buildExecCommand } = await import('../../../src/providers/sandbox/k8s.js');

    const config: SandboxConfig = {
      workspace: '/tmp/ws',
      ipcSocket: '/tmp/ipc.sock',
      command: ['node', 'runner.js'],
    };

    const cmd = buildExecCommand(config, 'nats://nats:4222');

    expect(cmd).toContain('NATS_USER=sandbox');
    expect(cmd).toContain('NATS_PASS=secret-pass');
  });

  test('uses custom LOG_LEVEL from env', async () => {
    process.env.K8S_POD_LOG_LEVEL = 'debug';

    const { buildExecCommand } = await import('../../../src/providers/sandbox/k8s.js');

    const config: SandboxConfig = {
      workspace: '/tmp/ws',
      ipcSocket: '/tmp/ipc.sock',
      command: ['node', 'runner.js'],
    };

    const cmd = buildExecCommand(config, 'nats://nats:4222');

    expect(cmd).toContain('LOG_LEVEL=debug');
  });

  test('includes canonical workspace env vars', async () => {
    const { buildExecCommand } = await import('../../../src/providers/sandbox/k8s.js');

    const config: SandboxConfig = {
      workspace: '/tmp/ws',
      ipcSocket: '/tmp/ipc.sock',
      command: ['node', 'runner.js'],
      agentWorkspace: '/tmp/agent',
      userWorkspace: '/tmp/user',
    };

    const cmd = buildExecCommand(config, 'nats://nats:4222');

    expect(cmd).toContain('AX_WORKSPACE=/workspace');
    expect(cmd).toContain('AX_AGENT_WORKSPACE=/workspace/agent');
    expect(cmd).toContain('AX_USER_WORKSPACE=/workspace/user');
  });
});

// ── Warm pool integration tests ──
// Mock the warm-pool-client module directly for precise control over claiming behavior.

const mockClaimPod = vi.fn();
const mockReleasePod = vi.fn().mockResolvedValue(undefined);

vi.mock('../../../src/providers/sandbox/warm-pool-client.js', () => ({
  createWarmPoolClient: vi.fn().mockResolvedValue({
    claimPod: mockClaimPod,
    releasePod: mockReleasePod,
  }),
}));

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
const mockExec = vi.fn().mockImplementation(
  (_ns: string, _pod: string, _container: string, _cmd: string[],
    _stdout: any, _stderr: any, _stdin: any, _tty: boolean, statusCb: any) => {
    setTimeout(() => statusCb({ status: 'Success' }), 20);
    return Promise.resolve({});
  },
);

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
  Attach: class {
    constructor(_kc: any) {}
    attach = vi.fn();
  },
  Exec: class {
    constructor(_kc: any) {}
    exec = mockExec;
  },
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

describe('k8s provider warm pool integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Restore default implementations after clearAllMocks
    mockCreateNamespacedPod.mockResolvedValue({ body: {} });
    mockDeleteNamespacedPod.mockResolvedValue({ body: {} });
    mockListNamespacedPod.mockResolvedValue({ items: [] });
    mockReadNamespacedPod.mockResolvedValue({ status: { phase: 'Running' } });
    mockClaimPod.mockResolvedValue(null);  // default: no warm pods
    mockReleasePod.mockResolvedValue(undefined);
    mockWatch.mockImplementation((_path: string, _query: any, callback: any) => {
      setTimeout(() => {
        callback('MODIFIED', {
          status: { phase: 'Succeeded', containerStatuses: [{ state: { terminated: { exitCode: 0 } } }] },
        });
      }, 10);
      return { abort: vi.fn() };
    });
    mockExec.mockImplementation(
      (_ns: string, _pod: string, _container: string, _cmd: string[],
        _stdout: any, _stderr: any, _stdin: any, _tty: boolean, statusCb: any) => {
        setTimeout(() => statusCb({ status: 'Success' }), 20);
        return Promise.resolve({});
      },
    );
    delete process.env.WARM_POOL_ENABLED;
    delete process.env.WARM_POOL_TIER;
  });

  afterEach(() => {
    delete process.env.WARM_POOL_ENABLED;
    delete process.env.WARM_POOL_TIER;
  });

  test('cold start when warm pool is disabled (default)', async () => {
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

    // Should create a new pod (cold start)
    expect(mockCreateNamespacedPod).toHaveBeenCalledOnce();
    expect(mockClaimPod).not.toHaveBeenCalled();
    expect(proc.pid).toBeGreaterThan(0);
  });

  test('warm pool spawn uses exec API when warm pod is claimed', async () => {
    process.env.WARM_POOL_ENABLED = 'true';

    // Warm pool returns a claimed pod
    mockClaimPod.mockResolvedValueOnce({ name: 'warm-pod-1', tier: 'light' });

    const { create } = await import('../../../src/providers/sandbox/k8s.js');
    const provider = await create(mockConfig());

    const config: SandboxConfig = {
      workspace: '/tmp/ws',
      ipcSocket: '/tmp/ipc.sock',
      command: ['node', 'runner.js'],
      timeoutSec: 30,
    };

    const proc = await provider.spawn(config);

    // Should NOT create a new pod — used exec on the warm pod
    expect(mockCreateNamespacedPod).not.toHaveBeenCalled();
    expect(mockClaimPod).toHaveBeenCalledWith('light');
    // Should have exec'd into the claimed pod
    expect(mockExec).toHaveBeenCalledOnce();
    const execArgs = mockExec.mock.calls[0];
    expect(execArgs[0]).toBe('ax');    // namespace
    expect(execArgs[1]).toBe('warm-pod-1'); // pod name
    expect(execArgs[2]).toBe('sandbox');  // container

    // Exec command should include env pairs and the agent command
    const execCmd = execArgs[3] as string[];
    expect(execCmd[0]).toBe('env');
    expect(execCmd).toContain('AX_IPC_TRANSPORT=nats');
    expect(execCmd.slice(-2)).toEqual(['node', 'runner.js']);

    expect(proc.pid).toBeGreaterThan(0);
    const exitCode = await proc.exitCode;
    expect(exitCode).toBe(0);
  });

  test('falls back to cold start when no warm pods available', async () => {
    process.env.WARM_POOL_ENABLED = 'true';

    // claimPod returns null → no warm pods
    mockClaimPod.mockResolvedValueOnce(null);

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

    // Should fall back to creating a new pod
    expect(mockCreateNamespacedPod).toHaveBeenCalledOnce();
    expect(mockExec).not.toHaveBeenCalled();
    expect(proc.pid).toBeGreaterThan(0);
  });

  test('claimed pod is auto-deleted after exec completion', async () => {
    process.env.WARM_POOL_ENABLED = 'true';

    mockClaimPod.mockResolvedValueOnce({ name: 'warm-pod-auto', tier: 'light' });

    const { create } = await import('../../../src/providers/sandbox/k8s.js');
    const provider = await create(mockConfig());

    const config: SandboxConfig = {
      workspace: '/tmp/ws',
      ipcSocket: '/tmp/ipc.sock',
      command: ['node', 'runner.js'],
      timeoutSec: 30,
    };

    const proc = await provider.spawn(config);

    // Wait for exec to complete (the mock resolves after 20ms)
    const exitCode = await proc.exitCode;
    expect(exitCode).toBe(0);

    // Pod should have been auto-deleted after exec finished — no need for kill()
    await new Promise(r => setTimeout(r, 10));
    expect(mockDeleteNamespacedPod).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'warm-pod-auto' }),
    );
  });

  test('warm pool kill deletes the claimed pod', async () => {
    process.env.WARM_POOL_ENABLED = 'true';

    mockClaimPod.mockResolvedValueOnce({ name: 'warm-pod-kill', tier: 'light' });

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
      expect.objectContaining({ name: 'warm-pod-kill' }),
    );
  });
});
