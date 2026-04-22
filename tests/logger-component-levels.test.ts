// Per-component log level overrides via LOG_LEVEL_<COMPONENT> env vars.
//
// An operator working a single noisy subsystem (say, the k8s sandbox) should
// be able to crank that one up to debug without drowning the rest of the host
// in stack traces. The convention: take the component name, uppercase it,
// replace `-` with `_`, prefix with `LOG_LEVEL_`. So `sandbox-k8s` →
// `LOG_LEVEL_SANDBOX_K8S`.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Writable } from 'node:stream';

describe('per-component log levels', () => {
  // Save + restore env so tests don't bleed.
  const saved: Record<string, string | undefined> = {};
  const stash = (key: string) => { saved[key] = process.env[key]; };
  const restore = () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };

  beforeEach(() => {
    stash('LOG_LEVEL');
    stash('LOG_LEVEL_SANDBOX_K8S');
    stash('LOG_LEVEL_HOST');
    stash('LOG_LEVEL_FOO_BAR');
  });

  afterEach(() => {
    restore();
  });

  it('LOG_LEVEL_SANDBOX_K8S=debug raises sandbox-k8s component level above default', async () => {
    process.env.LOG_LEVEL = 'info';
    process.env.LOG_LEVEL_SANDBOX_K8S = 'debug';
    const { createLogger } = await import('../src/logger.js');
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, cb) { const t = chunk.toString().trim(); if (t) lines.push(t); cb(); },
    });
    const log = createLogger({ component: 'sandbox-k8s', stream });
    log.debug('debug_should_appear');
    log.info('info_should_appear');
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]).msg).toBe('debug_should_appear');
  });

  it('default LOG_LEVEL applies when no component override is set', async () => {
    process.env.LOG_LEVEL = 'warn';
    delete process.env.LOG_LEVEL_HOST;
    const { createLogger } = await import('../src/logger.js');
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, cb) { const t = chunk.toString().trim(); if (t) lines.push(t); cb(); },
    });
    const log = createLogger({ component: 'host', stream });
    log.info('info_should_be_filtered');
    log.warn('warn_should_appear');
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0]).msg).toBe('warn_should_appear');
  });

  it('component name with hyphens maps to env var with underscores', async () => {
    process.env.LOG_LEVEL = 'error';
    process.env.LOG_LEVEL_FOO_BAR = 'debug';
    const { createLogger } = await import('../src/logger.js');
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, cb) { const t = chunk.toString().trim(); if (t) lines.push(t); cb(); },
    });
    const log = createLogger({ component: 'foo-bar', stream });
    log.debug('component_hyphen_to_underscore');
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0]).msg).toBe('component_hyphen_to_underscore');
  });

  it('explicit level option wins over env var (caller intent beats env)', async () => {
    process.env.LOG_LEVEL = 'info';
    process.env.LOG_LEVEL_SANDBOX_K8S = 'debug';
    const { createLogger } = await import('../src/logger.js');
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, cb) { const t = chunk.toString().trim(); if (t) lines.push(t); cb(); },
    });
    const log = createLogger({ component: 'sandbox-k8s', level: 'error', stream });
    log.warn('warn_should_be_filtered');
    log.error('error_should_appear');
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0]).msg).toBe('error_should_appear');
  });

  it('child() with a component binding picks up the env override', async () => {
    process.env.LOG_LEVEL = 'info';
    process.env.LOG_LEVEL_SANDBOX_K8S = 'debug';
    const { createLogger } = await import('../src/logger.js');
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, cb) { const t = chunk.toString().trim(); if (t) lines.push(t); cb(); },
    });
    const root = createLogger({ stream });
    const child = root.child({ component: 'sandbox-k8s' });
    child.debug('child_debug_via_component_env');
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0]).msg).toBe('child_debug_via_component_env');
  });

  it('invalid env value (typo) is ignored — falls back gracefully', async () => {
    // A typo like `LOG_LEVEL_SANDBOX_K8S=infod` must not crash createLogger
    // (pino rejects unknown levels) and must fall through to LOG_LEVEL.
    process.env.LOG_LEVEL = 'warn';
    process.env.LOG_LEVEL_SANDBOX_K8S = 'infod'; // typo
    const { createLogger } = await import('../src/logger.js');
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, cb) { const t = chunk.toString().trim(); if (t) lines.push(t); cb(); },
    });
    // Must not throw despite the typo.
    const log = createLogger({ component: 'sandbox-k8s', stream });
    log.info('info_should_be_filtered_at_warn'); // dropped — fell back to LOG_LEVEL=warn
    log.warn('warn_should_appear');
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0]).msg).toBe('warn_should_appear');
  });
});

// Production multistream path regression
//
// The bug: the original tests pass `opts.stream` (single-stream branch),
// where pino's `level` IS the only filter — so a per-component `child.level`
// override "just worked." The pretty/syncFile/transport branches build
// `pino.multistream(streams)` with each stream carrying its OWN `level`
// filter. A child with `level='debug'` would emit past the root pino, but
// the per-stream filter at `level='info'` would drop it on the floor.
//
// Fix: set the per-stream filter to the minimum across all configured levels
// (`getMinConfiguredLevel`). The child.level (which honors the component
// override) becomes the real gate; the per-stream filter is just a floor
// that's always at least as permissive as the most-permissive override.
//
// We exercise this by spying on `pino.multistream` to capture the streams
// array AND inject a capturing Writable in place of the production console
// destination (process.stdout/process.stderr). Then we assert on (a) the
// per-stream level set by createLogger, and (b) what actually flows through
// when a component child emits.
describe('per-component log levels — production multistream path', () => {
  const saved: Record<string, string | undefined> = {};
  const stash = (key: string) => { saved[key] = process.env[key]; };

  beforeEach(() => {
    stash('LOG_LEVEL');
    stash('LOG_LEVEL_SANDBOX_K8S');
    stash('LOG_LEVEL_HOST');
    vi.resetModules();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('multistream stream level matches min across LOG_LEVEL_* — debug message reaches stream when component child overrides', async () => {
    process.env.LOG_LEVEL = 'info';
    process.env.LOG_LEVEL_SANDBOX_K8S = 'debug';

    // Spy on pino.multistream so we can (a) inspect the per-stream level set
    // by createLogger and (b) substitute a capturing Writable for the FD
    // destinations, while still delegating to the real multistream for proper
    // per-stream level filtering.
    const pino = (await import('pino')).default;
    const realMultistream = pino.multistream;
    const lines: string[] = [];
    let capturedStreamLevels: string[] = [];
    const multistreamSpy = vi.spyOn(pino, 'multistream').mockImplementation(((streams: any, opts?: any) => {
      capturedStreamLevels = streams.map((s: any) => s.level);
      const swapped = streams.map((s: any) => ({
        level: s.level,
        stream: new Writable({
          write(chunk, _enc, cb) {
            const t = chunk.toString().trim();
            if (t) lines.push(JSON.stringify({ _streamLevel: s.level, ...JSON.parse(t) }));
            cb();
          },
        }),
      }));
      return realMultistream(swapped, opts);
    }) as any);

    // Force the syncFile multistream path: pretty=false + LOG_SYNC=1.
    process.env.LOG_SYNC = '1';
    const { initLogger, getLogger, resetLogger } = await import('../src/logger.js');
    initLogger({ pretty: false, file: false }); // file: false → only console stream

    // The console stream's level should be the min ('debug'), NOT LOG_LEVEL
    // ('info'). This is the regression assertion for the original bug.
    expect(capturedStreamLevels).toEqual(['debug']);

    // Now exercise the actual emission: child with component override must
    // emit debug through the multistream.
    const child = getLogger().child({ component: 'sandbox-k8s' });
    child.debug('component_debug_via_multistream');
    child.info('component_info_via_multistream');

    expect(lines.length).toBe(2);
    const debugLine = JSON.parse(lines[0]);
    expect(debugLine.msg).toBe('component_debug_via_multistream');
    expect(debugLine.component).toBe('sandbox-k8s');
    expect(debugLine._streamLevel).toBe('debug');

    resetLogger();
    delete process.env.LOG_SYNC;
    multistreamSpy.mockRestore();
  });

  it('non-component child still filters at LOG_LEVEL even when floor is widened by another component', async () => {
    // The min-floor approach widens the per-stream filter to 'debug' to admit
    // the sandbox-k8s child. A non-component child (or component='host' with
    // no LOG_LEVEL_HOST) must STILL filter debug at child.level — otherwise
    // operators get a flood of unrelated debug noise.
    process.env.LOG_LEVEL = 'info';
    process.env.LOG_LEVEL_SANDBOX_K8S = 'debug';

    const pino = (await import('pino')).default;
    const realMultistream = pino.multistream;
    const lines: string[] = [];
    const multistreamSpy = vi.spyOn(pino, 'multistream').mockImplementation(((streams: any, opts?: any) => {
      const swapped = streams.map((s: any) => ({
        level: s.level,
        stream: new Writable({
          write(chunk, _enc, cb) {
            const t = chunk.toString().trim();
            if (t) lines.push(t);
            cb();
          },
        }),
      }));
      return realMultistream(swapped, opts);
    }) as any);

    process.env.LOG_SYNC = '1';
    const { initLogger, getLogger, resetLogger } = await import('../src/logger.js');
    initLogger({ pretty: false, file: false });

    const hostChild = getLogger().child({ component: 'host' });
    hostChild.debug('host_debug_should_be_filtered');
    hostChild.info('host_info_should_emit');

    const decoded = lines.map(l => JSON.parse(l));
    expect(decoded.find(l => l.msg === 'host_debug_should_be_filtered')).toBeUndefined();
    expect(decoded.find(l => l.msg === 'host_info_should_emit')).toBeDefined();

    resetLogger();
    delete process.env.LOG_SYNC;
    multistreamSpy.mockRestore();
  });
});
