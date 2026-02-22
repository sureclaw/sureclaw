import { describe, test, expect, vi } from 'vitest';
import { connectChannelWithRetry } from '../../src/host/server-channels.js';
import type { ChannelProvider } from '../../src/providers/channel/types.js';
import { getLogger } from '../../src/logger.js';

function mockChannel(opts?: { connectError?: Error; failCount?: number }): ChannelProvider {
  let failures = opts?.failCount ?? 0;
  return {
    name: 'test-channel',
    async connect() {
      if (failures > 0) {
        failures--;
        throw opts?.connectError ?? new Error('connection failed');
      }
    },
    onMessage() {},
    shouldRespond() { return true; },
    async send() {},
    async disconnect() {},
  };
}

const logger = getLogger();

describe('connectChannelWithRetry', () => {
  test('succeeds on first attempt when channel connects fine', async () => {
    const channel = mockChannel();
    await connectChannelWithRetry(channel, logger);
    // Should not throw
  });

  test('retries and succeeds after transient failures', async () => {
    // 2 failures then success — uses real delays so keep failure count low
    const channel = mockChannel({ failCount: 2 });
    const connectSpy = vi.spyOn(channel, 'connect');

    await connectChannelWithRetry(channel, logger);

    // 2 failed attempts + 1 successful = 3 calls total
    expect(connectSpy).toHaveBeenCalledTimes(3);
  }, 30000); // Allow time for backoff delays

  test('does not retry auth errors (permanent failure)', async () => {
    const channel = mockChannel({
      connectError: new Error('invalid_auth token revoked'),
      failCount: 100,
    });
    const connectSpy = vi.spyOn(channel, 'connect');

    await expect(
      connectChannelWithRetry(channel, logger),
    ).rejects.toThrow('invalid_auth');

    // Should not have retried — auth errors are permanent
    expect(connectSpy).toHaveBeenCalledTimes(1);
  });

  test('does not retry 401 errors', async () => {
    const channel = mockChannel({
      connectError: new Error('HTTP 401 Unauthorized'),
      failCount: 100,
    });
    const connectSpy = vi.spyOn(channel, 'connect');

    await expect(
      connectChannelWithRetry(channel, logger),
    ).rejects.toThrow('401');

    expect(connectSpy).toHaveBeenCalledTimes(1);
  });

  test('does not retry token errors', async () => {
    const channel = mockChannel({
      connectError: new Error('invalid token'),
      failCount: 100,
    });
    const connectSpy = vi.spyOn(channel, 'connect');

    await expect(
      connectChannelWithRetry(channel, logger),
    ).rejects.toThrow('invalid token');

    expect(connectSpy).toHaveBeenCalledTimes(1);
  });
});
