// tests/agent/queue-group-work.test.ts — Tests for NATS queue group work subscription.
//
// Verifies that warm pods subscribe to sandbox.work with tier-based queue group
// instead of per-pod subject agent.work.{podName}.

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { initLogger } from '../../src/logger.js';

initLogger({ level: 'silent', file: false });

// ─── NATS mock ──────────────────────────────────────────
const mockSubscribe = vi.fn();
const mockDrain = vi.fn().mockResolvedValue(undefined);
const mockConnect = vi.fn();

vi.mock('nats', () => ({
  connect: (...args: unknown[]) => mockConnect(...args),
}));

describe('waitForNATSWork queue group', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    delete process.env.POD_NAME;
    delete process.env.SANDBOX_TIER;
  });

  afterEach(() => {
    delete process.env.POD_NAME;
    delete process.env.SANDBOX_TIER;
  });

  test('subscribes to sandbox.work with tier-based queue group', async () => {
    process.env.POD_NAME = 'ax-sandbox-light-abc123';
    process.env.SANDBOX_TIER = 'heavy';

    const mockRespond = vi.fn();
    const workPayload = JSON.stringify({
      message: 'hello',
      history: [],
      taintRatio: 0,
      taintThreshold: 1,
      profile: 'balanced',
      sandboxType: 'k8s',
    });

    mockSubscribe.mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        yield {
          data: new TextEncoder().encode(workPayload),
          reply: 'reply-subject',
          respond: mockRespond,
        };
      },
    });

    mockConnect.mockResolvedValue({
      subscribe: mockSubscribe,
      drain: mockDrain,
    });

    const { waitForNATSWork } = await import('../../src/agent/runner.js');
    const result = await waitForNATSWork();

    // Verify subscribe was called with queue group
    expect(mockSubscribe).toHaveBeenCalledWith('sandbox.work', { max: 1, queue: 'heavy' });

    // Verify pod replied with podName
    expect(mockRespond).toHaveBeenCalledWith(
      new TextEncoder().encode(JSON.stringify({ podName: 'ax-sandbox-light-abc123' })),
    );

    // Verify returned payload
    expect(result).toBe(workPayload);
  });

  test('defaults to light tier when SANDBOX_TIER not set', async () => {
    process.env.POD_NAME = 'ax-sandbox-light-xyz';

    const workPayload = JSON.stringify({
      message: 'test',
      history: [],
      taintRatio: 0,
      taintThreshold: 1,
      profile: 'balanced',
      sandboxType: 'k8s',
    });

    mockSubscribe.mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        yield {
          data: new TextEncoder().encode(workPayload),
          respond: vi.fn(),
        };
      },
    });

    mockConnect.mockResolvedValue({
      subscribe: mockSubscribe,
      drain: mockDrain,
    });

    const { waitForNATSWork } = await import('../../src/agent/runner.js');
    await waitForNATSWork();

    expect(mockSubscribe).toHaveBeenCalledWith('sandbox.work', { max: 1, queue: 'light' });
  });

  test('returns decoded work payload', async () => {
    process.env.POD_NAME = 'ax-sandbox-light-ret';

    const workPayload = JSON.stringify({
      message: 'work data here',
      history: [],
      taintRatio: 0.5,
      taintThreshold: 0.8,
      profile: 'paranoid',
      sandboxType: 'k8s',
      sessionId: 'sess-1',
      requestId: 'req-1',
      ipcToken: 'tok-1',
    });

    mockSubscribe.mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        yield {
          data: new TextEncoder().encode(workPayload),
          respond: vi.fn(),
        };
      },
    });

    mockConnect.mockResolvedValue({
      subscribe: mockSubscribe,
      drain: mockDrain,
    });

    const { waitForNATSWork, parseStdinPayload } = await import('../../src/agent/runner.js');
    const data = await waitForNATSWork();
    const parsed = parseStdinPayload(data);

    expect(parsed.message).toBe('work data here');
    expect(parsed.taintRatio).toBe(0.5);
    expect(parsed.ipcToken).toBe('tok-1');
  });

  test('throws when no POD_NAME is set', async () => {
    // POD_NAME not set — waitForNATSWork should still work (uses default)
    const workPayload = JSON.stringify({ message: 'test', history: [], taintRatio: 0, taintThreshold: 1, profile: 'balanced', sandboxType: 'k8s' });

    mockSubscribe.mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        yield {
          data: new TextEncoder().encode(workPayload),
          respond: vi.fn(),
        };
      },
    });

    mockConnect.mockResolvedValue({
      subscribe: mockSubscribe,
      drain: mockDrain,
    });

    const { waitForNATSWork } = await import('../../src/agent/runner.js');
    const result = await waitForNATSWork();
    expect(result).toBe(workPayload);
    // Uses 'unknown' as default podName
    expect(mockSubscribe).toHaveBeenCalledWith('sandbox.work', { max: 1, queue: 'light' });
  });
});
