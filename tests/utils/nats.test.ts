import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { natsConnectOptions } from '../../src/utils/nats.js';

describe('natsConnectOptions', () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.NATS_URL;
    delete process.env.NATS_USER;
    delete process.env.NATS_PASS;
  });

  afterEach(() => {
    process.env.NATS_URL = origEnv.NATS_URL;
    process.env.NATS_USER = origEnv.NATS_USER;
    process.env.NATS_PASS = origEnv.NATS_PASS;
  });

  test('returns default NATS URL when NATS_URL is not set', () => {
    const opts = natsConnectOptions('test');
    expect(opts.servers).toBe('nats://localhost:4222');
  });

  test('uses NATS_URL from env', () => {
    process.env.NATS_URL = 'nats://custom:9222';
    const opts = natsConnectOptions('test');
    expect(opts.servers).toBe('nats://custom:9222');
  });

  test('builds connection name with prefix and PID suffix', () => {
    const opts = natsConnectOptions('host');
    expect(opts.name).toBe(`ax-host-${process.pid}`);
  });

  test('uses custom suffix instead of PID when provided', () => {
    const opts = natsConnectOptions('ipc-handler', 'req-123');
    expect(opts.name).toBe('ax-ipc-handler-req-123');
  });

  test('does not include user/pass when NATS_USER is not set', () => {
    const opts = natsConnectOptions('test');
    expect(opts.user).toBeUndefined();
    expect(opts.pass).toBeUndefined();
  });

  test('includes user/pass when NATS_USER and NATS_PASS are set', () => {
    process.env.NATS_USER = 'host';
    process.env.NATS_PASS = 'secret123';
    const opts = natsConnectOptions('test');
    expect(opts.user).toBe('host');
    expect(opts.pass).toBe('secret123');
  });

  test('sets reconnect options', () => {
    const opts = natsConnectOptions('test');
    expect(opts.reconnect).toBe(true);
    expect(opts.maxReconnectAttempts).toBe(-1);
    expect(opts.reconnectTimeWait).toBe(1000);
  });
});
