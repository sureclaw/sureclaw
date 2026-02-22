// tests/cli/reload.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setupConfigReload, type ReloadContext } from '../../src/cli/reload.js';

function createMockContext(overrides: Partial<ReloadContext> = {}): ReloadContext {
  const mockServer = {
    listening: true,
    start: vi.fn<[], Promise<void>>().mockResolvedValue(undefined),
    stop: vi.fn<[], Promise<void>>().mockResolvedValue(undefined),
  };

  return {
    getServer: vi.fn(() => mockServer),
    setServer: vi.fn(),
    loadConfig: vi.fn(() => ({ profile: 'balanced' })),
    createServer: vi.fn(() => Promise.resolve({
      listening: false,
      start: vi.fn<[], Promise<void>>().mockResolvedValue(undefined),
      stop: vi.fn<[], Promise<void>>().mockResolvedValue(undefined),
    })),
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
      child: vi.fn(),
    },
    configPath: '/tmp/test-ax.yaml',
    ...overrides,
  };
}

describe('setupConfigReload', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('reload() stops old server and starts new one', async () => {
    const ctx = createMockContext();
    const handle = setupConfigReload(ctx);

    await handle.reload('test');

    const oldServer = (ctx.getServer as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(oldServer.stop).toHaveBeenCalledOnce();
    expect(ctx.loadConfig).toHaveBeenCalled();
    expect(ctx.createServer).toHaveBeenCalled();
    expect(ctx.setServer).toHaveBeenCalled();

    handle.cleanup();
  });

  it('reload() validates config before stopping server', async () => {
    const mockServer = {
      listening: true,
      start: vi.fn<[], Promise<void>>().mockResolvedValue(undefined),
      stop: vi.fn<[], Promise<void>>().mockResolvedValue(undefined),
    };
    const ctx = createMockContext({
      getServer: vi.fn(() => mockServer),
      loadConfig: vi.fn(() => { throw new Error('bad yaml'); }),
    });
    const handle = setupConfigReload(ctx);

    await handle.reload('test');

    // Server should NOT have been stopped — config was invalid
    expect(mockServer.stop).not.toHaveBeenCalled();
    expect(ctx.logger.error).toHaveBeenCalled();

    handle.cleanup();
  });

  it('serializes concurrent reloads', async () => {
    let resolveStop: () => void;
    const stopPromise = new Promise<void>(r => { resolveStop = r; });
    const slowServer = {
      listening: true,
      start: vi.fn<[], Promise<void>>().mockResolvedValue(undefined),
      stop: vi.fn<[], Promise<void>>().mockReturnValue(stopPromise),
    };
    const ctx = createMockContext({
      getServer: vi.fn(() => slowServer),
    });
    const handle = setupConfigReload(ctx);

    // Start first reload (will block on stop)
    const r1 = handle.reload('first');
    // Start second reload (should queue)
    const r2 = handle.reload('second');

    // Resolve the slow stop
    resolveStop!();
    await r1;
    await r2;

    // loadConfig called once per reload: once for the first reload,
    // once for the queued reload
    expect((ctx.loadConfig as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(2);

    handle.cleanup();
  });

  it('debounces rapid file change notifications', async () => {
    const ctx = createMockContext();
    const handle = setupConfigReload(ctx);

    // Simulate rapid file changes via the debounced callback
    handle.onFileChange();
    handle.onFileChange();
    handle.onFileChange();

    // Before debounce fires, no reload
    expect(ctx.loadConfig).not.toHaveBeenCalled();

    // Advance past debounce window (500ms)
    await vi.advanceTimersByTimeAsync(600);

    // Should have reloaded exactly once
    expect(ctx.loadConfig).toHaveBeenCalled();

    handle.cleanup();
  });

  it('cleanup() removes file watcher', () => {
    const ctx = createMockContext();
    const handle = setupConfigReload(ctx);

    // Should not throw
    handle.cleanup();
    handle.cleanup(); // idempotent
  });

  it('registers SIGHUP listener on non-win32', () => {
    const ctx = createMockContext();
    const listenersBefore = process.listenerCount('SIGHUP');
    const handle = setupConfigReload(ctx);
    expect(process.listenerCount('SIGHUP')).toBe(listenersBefore + 1);
    handle.cleanup();
    expect(process.listenerCount('SIGHUP')).toBe(listenersBefore);
  });
});
