// tests/providers/sandbox/k8s-lifecycle.test.ts — k8s pod lifecycle reason capture
//
// Verifies two operator-observability fixes:
//   1. When a pod fails, we record the *pod-level* reason (e.g. DeadlineExceeded,
//      Evicted) in addition to the container-level reason — because for SIGKILL
//      (exit 137) the container-level reason is the useless string "Error".
//   2. When the host calls deleteNamespacedPod after a pod has self-terminated,
//      the k8s API returns 404. That's the happy cleanup path — we downgrade
//      from warn ("pod_cleanup_failed" / "pod_kill_failed") to debug
//      ("pod_already_gone"). Other delete failures still warn.

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { Writable } from 'node:stream';
import type { Config } from '../../../src/types.js';
import type { SandboxConfig } from '../../../src/providers/sandbox/types.js';

// ── Mock @kubernetes/client-node (mirrors tests/providers/sandbox/k8s-correlation.test.ts) ──
const mockCreateNamespacedPod = vi.fn().mockResolvedValue({ body: {} });
const mockDeleteNamespacedPod = vi.fn().mockResolvedValue({ body: {} });
const mockListNamespacedPod = vi.fn().mockResolvedValue({ body: { items: [] } });
const mockReadNamespacedPod = vi.fn().mockRejectedValue(new Error('not ready'));
const mockWatch = vi.fn();

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

/** Capture log entries emitted by the singleton logger as parsed JSON objects. */
function captureLogs(): { entries: Record<string, unknown>[]; stream: Writable } {
  const entries: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      const text = chunk.toString();
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try { entries.push(JSON.parse(line)); } catch { /* ignore non-JSON */ }
      }
      cb();
    },
  });
  return { entries, stream };
}

describe('k8s pod lifecycle reason capture', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    // Reset to a no-op default; each test installs its own watch behavior.
    mockWatch.mockReset();
    mockDeleteNamespacedPod.mockReset();
    mockDeleteNamespacedPod.mockResolvedValue({ body: {} });
  });

  afterEach(async () => {
    const { resetLogger } = await import('../../../src/logger.js');
    resetLogger();
  });

  test('records pod-level reason DeadlineExceeded when activeDeadlineSeconds fires', async () => {
    const { entries, stream } = captureLogs();
    const { initLogger } = await import('../../../src/logger.js');
    initLogger({ level: 'debug', stream, file: false, pretty: false });

    // Simulate the k8s payload for an activeDeadlineSeconds termination:
    //   - pod-level status.reason = 'DeadlineExceeded'
    //   - container-level reason   = 'Error' (the useless one)
    //   - exitCode = 137 (SIGKILL)
    mockWatch.mockImplementationOnce((_p: string, _q: any, callback: any) => {
      setTimeout(() => {
        callback('MODIFIED', {
          status: {
            phase: 'Failed',
            reason: 'DeadlineExceeded',
            containerStatuses: [{
              state: { terminated: { exitCode: 137, reason: 'Error' } },
            }],
          },
        });
      }, 5);
      return { abort: vi.fn() };
    });

    const { create } = await import('../../../src/providers/sandbox/k8s.js');
    const provider = await create(mockConfig());

    const proc = await provider.spawn(mockSandboxConfig());
    await proc.exitCode;
    await new Promise(r => setTimeout(r, 20));

    const podFailed = entries.find(
      e => e.component === 'sandbox-k8s' && e.msg === 'pod_failed',
    );
    expect(podFailed).toBeDefined();
    expect(podFailed!.exitCode).toBe(137);
    expect(podFailed!.podReason).toBe('DeadlineExceeded');
    expect(podFailed!.containerReason).toBe('Error');
    // terminationCause prefers the pod-level reason — that's the one operators want.
    expect(podFailed!.terminationCause).toBe('DeadlineExceeded');
  });

  test('falls back to containerReason when no pod-level reason is set', async () => {
    const { entries, stream } = captureLogs();
    const { initLogger } = await import('../../../src/logger.js');
    initLogger({ level: 'debug', stream, file: false, pretty: false });

    // OOMKilled is captured at the container level — pod-level reason is undefined.
    mockWatch.mockImplementationOnce((_p: string, _q: any, callback: any) => {
      setTimeout(() => {
        callback('MODIFIED', {
          status: {
            phase: 'Failed',
            containerStatuses: [{
              state: { terminated: { exitCode: 137, reason: 'OOMKilled' } },
            }],
          },
        });
      }, 5);
      return { abort: vi.fn() };
    });

    const { create } = await import('../../../src/providers/sandbox/k8s.js');
    const provider = await create(mockConfig());

    const proc = await provider.spawn(mockSandboxConfig());
    await proc.exitCode;
    await new Promise(r => setTimeout(r, 20));

    const podFailed = entries.find(
      e => e.component === 'sandbox-k8s' && e.msg === 'pod_failed',
    );
    expect(podFailed).toBeDefined();
    expect(podFailed!.podReason).toBeUndefined();
    expect(podFailed!.containerReason).toBe('OOMKilled');
    expect(podFailed!.terminationCause).toBe('OOMKilled');
  });

  test('cleanup deleteNamespacedPod 404 emits debug pod_already_gone, not warn', async () => {
    const { entries, stream } = captureLogs();
    const { initLogger } = await import('../../../src/logger.js');
    initLogger({ level: 'debug', stream, file: false, pretty: false });

    // Watch resolves Failed so the cleanup .catch() runs.
    mockWatch.mockImplementationOnce((_p: string, _q: any, callback: any) => {
      setTimeout(() => {
        callback('MODIFIED', {
          status: {
            phase: 'Failed',
            containerStatuses: [{ state: { terminated: { exitCode: 1 } } }],
          },
        });
      }, 5);
      return { abort: vi.fn() };
    });

    // The k8s client surfaces 404s with body containing JSON like:
    //   '{"kind":"Status","status":"Failure","reason":"NotFound", ... ,"code":404}'
    // We assert the .code === 404 path here; the body-regex fallback is covered separately.
    mockDeleteNamespacedPod.mockReset();
    mockDeleteNamespacedPod.mockRejectedValueOnce(
      Object.assign(new Error('Not Found'), { code: 404 }),
    );

    const { create } = await import('../../../src/providers/sandbox/k8s.js');
    const provider = await create(mockConfig());

    const proc = await provider.spawn(mockSandboxConfig());
    await proc.exitCode;
    // Let the .catch() microtask + the post-spawn pod-status checker drain.
    await new Promise(r => setTimeout(r, 30));

    const cleanupWarn = entries.find(
      e => e.component === 'sandbox-k8s' && e.msg === 'pod_cleanup_failed',
    );
    expect(cleanupWarn).toBeUndefined();

    const alreadyGone = entries.find(
      e => e.component === 'sandbox-k8s' && e.msg === 'pod_already_gone',
    );
    expect(alreadyGone).toBeDefined();
    expect(alreadyGone!.level).toBe(20); // pino debug level
  });

  test('cleanup 404 detected via JSON body fallback (no err.code)', async () => {
    const { entries, stream } = captureLogs();
    const { initLogger } = await import('../../../src/logger.js');
    initLogger({ level: 'debug', stream, file: false, pretty: false });

    mockWatch.mockImplementationOnce((_p: string, _q: any, callback: any) => {
      setTimeout(() => {
        callback('MODIFIED', {
          status: {
            phase: 'Failed',
            containerStatuses: [{ state: { terminated: { exitCode: 1 } } }],
          },
        });
      }, 5);
      return { abort: vi.fn() };
    });

    // Real-world shape from production logs: no `code` field, but `body` is the
    // serialized k8s Status object. We match /not found/i on body.
    mockDeleteNamespacedPod.mockReset();
    mockDeleteNamespacedPod.mockRejectedValueOnce(Object.assign(new Error('http error'), {
      body: '{"kind":"Status","status":"Failure","message":"pods \\"ax-sandbox-xyz\\" not found","reason":"NotFound","code":404}',
    }));

    const { create } = await import('../../../src/providers/sandbox/k8s.js');
    const provider = await create(mockConfig());

    const proc = await provider.spawn(mockSandboxConfig());
    await proc.exitCode;
    await new Promise(r => setTimeout(r, 30));

    expect(entries.find(e => e.msg === 'pod_cleanup_failed')).toBeUndefined();
    expect(entries.find(e => e.msg === 'pod_already_gone')).toBeDefined();
  });

  test('cleanup non-404 errors still warn at pod_cleanup_failed', async () => {
    const { entries, stream } = captureLogs();
    const { initLogger } = await import('../../../src/logger.js');
    initLogger({ level: 'debug', stream, file: false, pretty: false });

    mockWatch.mockImplementationOnce((_p: string, _q: any, callback: any) => {
      setTimeout(() => {
        callback('MODIFIED', {
          status: {
            phase: 'Failed',
            containerStatuses: [{ state: { terminated: { exitCode: 1 } } }],
          },
        });
      }, 5);
      return { abort: vi.fn() };
    });

    mockDeleteNamespacedPod.mockReset();
    mockDeleteNamespacedPod.mockRejectedValueOnce(
      Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' }),
    );

    const { create } = await import('../../../src/providers/sandbox/k8s.js');
    const provider = await create(mockConfig());

    const proc = await provider.spawn(mockSandboxConfig());
    await proc.exitCode;
    await new Promise(r => setTimeout(r, 30));

    const warn = entries.find(
      e => e.component === 'sandbox-k8s' && e.msg === 'pod_cleanup_failed',
    );
    expect(warn).toBeDefined();
    expect(warn!.level).toBe(40); // pino warn level
    expect(warn!.error).toBe('connection refused');
    // And we should NOT have emitted pod_already_gone for a non-404 error.
    expect(entries.find(e => e.msg === 'pod_already_gone')).toBeUndefined();
  });

  test('kill() 404 emits debug pod_already_gone instead of warn pod_kill_failed', async () => {
    const { entries, stream } = captureLogs();
    const { initLogger } = await import('../../../src/logger.js');
    initLogger({ level: 'debug', stream, file: false, pretty: false });

    // Idle watcher so kill() drives termination.
    mockWatch.mockImplementationOnce((_p: string, _q: any, _cb: any) => ({ abort: vi.fn() }));

    mockDeleteNamespacedPod.mockReset();
    mockDeleteNamespacedPod.mockRejectedValueOnce(
      Object.assign(new Error('Not Found'), { code: 404 }),
    );

    const { create } = await import('../../../src/providers/sandbox/k8s.js');
    const provider = await create(mockConfig());

    const proc = await provider.spawn(mockSandboxConfig());
    await provider.kill(proc.pid);

    const warn = entries.find(
      e => e.component === 'sandbox-k8s' && e.msg === 'pod_kill_failed',
    );
    expect(warn).toBeUndefined();

    const alreadyGone = entries.find(
      e => e.component === 'sandbox-k8s' && e.msg === 'pod_already_gone',
    );
    expect(alreadyGone).toBeDefined();
    expect(alreadyGone!.level).toBe(20);
  });

  test('kill() non-404 errors still warn at pod_kill_failed', async () => {
    const { entries, stream } = captureLogs();
    const { initLogger } = await import('../../../src/logger.js');
    initLogger({ level: 'debug', stream, file: false, pretty: false });

    mockWatch.mockImplementationOnce((_p: string, _q: any, _cb: any) => ({ abort: vi.fn() }));

    mockDeleteNamespacedPod.mockReset();
    mockDeleteNamespacedPod.mockRejectedValueOnce(
      Object.assign(new Error('forbidden'), { code: 403 }),
    );

    const { create } = await import('../../../src/providers/sandbox/k8s.js');
    const provider = await create(mockConfig());

    const proc = await provider.spawn(mockSandboxConfig());
    await provider.kill(proc.pid);

    const warn = entries.find(
      e => e.component === 'sandbox-k8s' && e.msg === 'pod_kill_failed',
    );
    expect(warn).toBeDefined();
    expect(warn!.level).toBe(40);
    expect(entries.find(e => e.msg === 'pod_already_gone')).toBeUndefined();
  });
});
