// tests/providers/sandbox/k8s-correlation.test.ts — k8s sandbox reqId correlation
//
// Verifies that when a SandboxConfig with `requestId` is passed to the k8s
// provider's spawn(), every log line emitted from the per-pod logger child
// carries `reqId` (last 8 chars), `podName`, and `pid` bindings — so a single
// `grep <reqId>` reconstructs the pod's lifecycle across host + sandbox logs.

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { Writable } from 'node:stream';
import type { Config } from '../../../src/types.js';
import type { SandboxConfig } from '../../../src/providers/sandbox/types.js';

// ── Mock @kubernetes/client-node (same shape as tests/providers/sandbox/k8s.test.ts) ──
const mockCreateNamespacedPod = vi.fn().mockResolvedValue({ body: {} });
const mockDeleteNamespacedPod = vi.fn().mockResolvedValue({ body: {} });
const mockListNamespacedPod = vi.fn().mockResolvedValue({ body: { items: [] } });
const mockReadNamespacedPod = vi.fn().mockRejectedValue(new Error('not ready'));
const mockWatch = vi.fn().mockImplementation((_p: string, _q: any, callback: any) => {
  // Resolve as Failed so we exercise both spawn-time logs and the failure path.
  setTimeout(() => {
    callback('MODIFIED', {
      status: {
        phase: 'Failed',
        containerStatuses: [{ state: { terminated: { exitCode: 137, reason: 'OOMKilled' } } }],
      },
    });
  }, 5);
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

class MockWatch { constructor(_kc: any) {} watch = mockWatch; }

vi.mock('@kubernetes/client-node', () => ({
  KubeConfig: MockKubeConfig,
  CoreV1Api: class {},
  Watch: MockWatch,
}));

function mockConfig(): Config {
  return {
    profile: 'balanced',
    providers: {
      memory: 'cortex', security: 'patterns',
      channels: ['cli'], web: { extract: 'none', search: 'none' },
      credentials: 'database', skills: 'database', audit: 'database',
      sandbox: 'k8s', scheduler: 'none',
    },
    sandbox: { timeout_sec: 30, memory_mb: 256, cpus: 1 },
    scheduler: {
      active_hours: { start: '08:00', end: '22:00', timezone: 'UTC' },
      max_token_budget: 1000,
      heartbeat_interval_min: 5,
    },
  };
}

function mockSandboxConfig(overrides: Partial<SandboxConfig> = {}): SandboxConfig {
  return {
    workspace: '/tmp/test-workspace',
    ipcSocket: '/tmp/test-ipc.sock',
    timeoutSec: 30,
    memoryMB: 256,
    command: ['node', 'runner.js'],
    ...overrides,
  };
}

/** Capture all log entries emitted by the singleton logger as parsed JSON objects. */
function captureLogs(): { entries: Record<string, unknown>[]; stream: Writable } {
  const entries: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      const text = chunk.toString();
      // pino multistream may write multiple lines in one chunk
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try { entries.push(JSON.parse(line)); } catch { /* ignore non-JSON */ }
      }
      cb();
    },
  });
  return { entries, stream };
}

describe('k8s sandbox correlation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules(); // force k8s.ts to re-bind the logger from the freshly-init'd singleton
  });

  afterEach(async () => {
    const { resetLogger } = await import('../../../src/logger.js');
    resetLogger();
  });

  test('every spawn-time log line carries reqId, podName, and pid bindings', async () => {
    const { entries, stream } = captureLogs();
    const { initLogger } = await import('../../../src/logger.js');
    initLogger({ level: 'debug', stream, file: false, pretty: false });

    const requestId = 'req-test-1234567890ab';

    const { create } = await import('../../../src/providers/sandbox/k8s.js');
    const provider = await create(mockConfig());

    const proc = await provider.spawn(mockSandboxConfig({ requestId }));
    await proc.exitCode;
    // Give the post-spawn async pod-status checker a tick to finish too.
    await new Promise(r => setTimeout(r, 20));

    // Pod-scoped lines must have podName + pid + reqId — they come from the per-pod child.
    // podName is only set by the per-pod child logger — module-level logs
    // (k8s_config_loaded etc.) don't have it, so we use it to distinguish
    // pod-scoped from process-scoped entries.
    const podScoped = entries.filter(
      e => e.component === 'sandbox-k8s' && typeof e.podName === 'string',
    );

    expect(podScoped.length).toBeGreaterThan(0);
    for (const e of podScoped) {
      expect(e.reqId).toBe(requestId.slice(-8));
      expect(e.podName).toMatch(/^ax-sandbox-/);
      // pid is the synthetic k8s PID (>= 100_000) — pino's child binding
      // overrides its default top-level `pid` field.
      expect(typeof e.pid).toBe('number');
      expect(e.pid as number).toBeGreaterThanOrEqual(100_000);
    }

    // At least one of: creating_pod (info), pod_failed (error) must be present.
    const events = podScoped.map(e => e.msg);
    expect(events).toContain('creating_pod');
    expect(events).toContain('pod_failed');

    const podFailed = podScoped.find(e => e.msg === 'pod_failed')!;
    expect(podFailed.podName).toBeDefined();
    expect(podFailed.pid).toBeDefined();
    expect(podFailed.reqId).toBe(requestId.slice(-8));
  });

  test('kill() emits pod_killed with reqId binding from per-pod logger', async () => {
    const { entries, stream } = captureLogs();
    const { initLogger } = await import('../../../src/logger.js');
    initLogger({ level: 'debug', stream, file: false, pretty: false });

    // Make the watcher idle so we can drive termination via kill() ourselves.
    mockWatch.mockImplementationOnce((_p: string, _q: any, _cb: any) => ({ abort: vi.fn() }));

    const requestId = 'req-killpath-7777aaaa';

    const { create } = await import('../../../src/providers/sandbox/k8s.js');
    const provider = await create(mockConfig());

    const proc = await provider.spawn(mockSandboxConfig({ requestId }));
    await provider.kill(proc.pid);

    // Pod-scoped lines: must include pod_killed with all bindings.
    const podScoped = entries.filter(
      e => e.component === 'sandbox-k8s' && typeof e.podName === 'string',
    );
    const killed = podScoped.find(e => e.msg === 'pod_killed' || e.msg === 'pod_kill_failed');
    expect(killed).toBeDefined();
    expect(killed!.reqId).toBe(requestId.slice(-8));
    expect(killed!.podName).toMatch(/^ax-sandbox-/);
    expect(typeof killed!.pid).toBe('number');
    expect(killed!.pid as number).toBe(proc.pid);

    // Sanity: deleteNamespacedPod was called with the same podName carried in the log.
    expect(mockDeleteNamespacedPod).toHaveBeenCalledWith(
      expect.objectContaining({ name: killed!.podName, namespace: 'ax' }),
    );
  });

  test('omits reqId binding when SandboxConfig has no requestId', async () => {
    const { entries, stream } = captureLogs();
    const { initLogger } = await import('../../../src/logger.js');
    initLogger({ level: 'debug', stream, file: false, pretty: false });

    const { create } = await import('../../../src/providers/sandbox/k8s.js');
    const provider = await create(mockConfig());

    const proc = await provider.spawn(mockSandboxConfig());
    await proc.exitCode;
    await new Promise(r => setTimeout(r, 20));

    // podName is only set by the per-pod child logger — module-level logs
    // (k8s_config_loaded etc.) don't have it, so we use it to distinguish
    // pod-scoped from process-scoped entries.
    const podScoped = entries.filter(
      e => e.component === 'sandbox-k8s' && typeof e.podName === 'string',
    );
    expect(podScoped.length).toBeGreaterThan(0);
    for (const e of podScoped) {
      expect(e.reqId).toBeUndefined();
      expect(e.podName).toMatch(/^ax-sandbox-/);
      expect(typeof e.pid).toBe('number');
    }
  });
});
