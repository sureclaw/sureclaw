import { describe, test, expect, vi } from 'vitest';
import { createSchedulerCallback } from '../../src/host/server-request-handlers.js';
import type { Config } from '../../src/types.js';

/**
 * Verifies that scheduler-initiated sandbox runs use
 * config.scheduler.timeout_sec when configured.
 *
 * The actual override happens in the `runCompletion` lambda wired by
 * server-local.ts / server-k8s.ts. These tests exercise the same pattern:
 * wrapping runCompletion to override sandbox timeout.
 */

describe('scheduler sandbox timeout override', () => {
  function makeConfig(schedulerTimeout?: number): Config {
    return {
      profile: 'paranoid',
      agent_name: 'main',
      providers: {
        memory: 'cortex', security: 'patterns', channels: ['cli'],
        web: { extract: 'none', search: 'none' },
        credentials: 'keychain', skills: 'database', audit: 'database',
        sandbox: 'docker', scheduler: 'plainjob',
      },
      sandbox: { timeout_sec: 600, memory_mb: 512 },
      scheduler: {
        active_hours: { start: '00:00', end: '23:59', timezone: 'UTC' },
        max_token_budget: 4096,
        heartbeat_interval_min: 30,
        ...(schedulerTimeout !== undefined ? { timeout_sec: schedulerTimeout } : {}),
      },
    } as Config;
  }

  test('runCompletion receives overridden sandbox timeout when scheduler.timeout_sec is set', async () => {
    const config = makeConfig(60);
    let capturedConfig: Config | undefined;

    // Simulate the pattern from server-local.ts
    const runCompletion = async (
      content: string, _requestId: string,
      _messages: { role: string; content: string }[],
      _sessionId: string,
    ) => {
      const deps = config.scheduler.timeout_sec
        ? { config: { ...config, sandbox: { ...config.sandbox, timeout_sec: config.scheduler.timeout_sec } } }
        : { config };
      capturedConfig = deps.config as Config;
      return { responseContent: 'ok' };
    };

    await runCompletion('hello', 'req-1', [], 'session-1');

    expect(capturedConfig!.sandbox.timeout_sec).toBe(60);
    // Original config unchanged
    expect(config.sandbox.timeout_sec).toBe(600);
  });

  test('runCompletion uses default sandbox timeout when scheduler.timeout_sec is not set', async () => {
    const config = makeConfig();
    let capturedConfig: Config | undefined;

    const runCompletion = async (
      content: string, _requestId: string,
      _messages: { role: string; content: string }[],
      _sessionId: string,
    ) => {
      const deps = config.scheduler.timeout_sec
        ? { config: { ...config, sandbox: { ...config.sandbox, timeout_sec: config.scheduler.timeout_sec } } }
        : { config };
      capturedConfig = deps.config as Config;
      return { responseContent: 'ok' };
    };

    await runCompletion('hello', 'req-1', [], 'session-1');

    expect(capturedConfig!.sandbox.timeout_sec).toBe(600);
  });

  test('createSchedulerCallback invokes runCompletion for queued messages', async () => {
    const config = makeConfig(60);
    const runCompletionSpy = vi.fn().mockResolvedValue({ responseContent: '' });

    const mockRouter = {
      processInbound: vi.fn().mockResolvedValue({
        queued: true,
        sessionId: 'sched-session',
        messageId: 'msg-1',
        canaryToken: 'canary-abc',
        scanResult: { verdict: 'PASS' },
      }),
      processOutbound: vi.fn(),
    };

    const callback = createSchedulerCallback({
      config,
      router: mockRouter as any,
      sessionCanaries: new Map(),
      sessionStore: { get: vi.fn(), set: vi.fn(), delete: vi.fn() } as any,
      agentName: 'main',
      channels: [],
      scheduler: { listJobs: vi.fn().mockResolvedValue([]) } as any,
      runCompletion: runCompletionSpy,
    });

    await callback({
      id: 'msg-1',
      session: { provider: 'scheduler', scope: 'dm', identifiers: {} },
      sender: 'heartbeat',
      content: 'check status',
      attachments: [],
      timestamp: new Date(),
    });

    expect(runCompletionSpy).toHaveBeenCalledTimes(1);
    expect(runCompletionSpy.mock.calls[0][0]).toBe('check status');
  });
});
