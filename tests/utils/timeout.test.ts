import { describe, test, expect } from 'vitest';
import { withTimeout, TimeoutError } from '../../src/utils/timeout.js';

describe('withTimeout', () => {
  test('resolves if promise completes before timeout', async () => {
    const result = await withTimeout(Promise.resolve('ok'), 1000, 'test');
    expect(result).toBe('ok');
  });

  test('resolves with correct value type', async () => {
    const result = await withTimeout(Promise.resolve(42), 1000, 'test');
    expect(result).toBe(42);
  });

  test('rejects with TimeoutError if promise takes too long', async () => {
    const neverResolves = new Promise<string>(() => {});
    await expect(withTimeout(neverResolves, 50, 'test-op'))
      .rejects.toThrow(TimeoutError);
  });

  test('TimeoutError has correct operation and timeoutMs', async () => {
    const neverResolves = new Promise<string>(() => {});
    try {
      await withTimeout(neverResolves, 50, 'my-operation');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(TimeoutError);
      expect((err as TimeoutError).operation).toBe('my-operation');
      expect((err as TimeoutError).timeoutMs).toBe(50);
      expect((err as TimeoutError).message).toContain('my-operation');
      expect((err as TimeoutError).message).toContain('50ms');
    }
  });

  test('forwards rejection from original promise', async () => {
    await expect(withTimeout(Promise.reject(new Error('boom')), 1000, 'test'))
      .rejects.toThrow('boom');
  });

  test('clears timeout on successful completion (no timer leak)', async () => {
    // If timer leaks, vitest will warn about open handles
    await withTimeout(Promise.resolve(42), 10_000, 'test');
  });

  test('clears timeout on promise rejection (no timer leak)', async () => {
    await expect(withTimeout(Promise.reject(new Error('oops')), 10_000, 'test'))
      .rejects.toThrow('oops');
  });
});

describe('TimeoutError', () => {
  test('is an instance of Error', () => {
    const err = new TimeoutError('op', 1000);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('TimeoutError');
  });

  test('has correct properties', () => {
    const err = new TimeoutError('keytar.getPassword', 5000);
    expect(err.operation).toBe('keytar.getPassword');
    expect(err.timeoutMs).toBe(5000);
    expect(err.message).toBe('Operation "keytar.getPassword" timed out after 5000ms');
  });
});
