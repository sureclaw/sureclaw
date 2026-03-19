import { describe, test, expect, afterEach } from 'vitest';

describe('credential-prompts', () => {
  afterEach(async () => {
    const { cleanupSession } = await import('../../src/host/credential-prompts.js');
    cleanupSession('test-session');
  });

  test('requestCredential blocks until resolveCredential is called', async () => {
    const { requestCredential, resolveCredential } = await import('../../src/host/credential-prompts.js');

    // Start the request (non-blocking — returns a promise)
    const promise = requestCredential('test-session', 'LINEAR_API_KEY');

    // Resolve it from another "thread"
    setTimeout(() => resolveCredential('test-session', 'LINEAR_API_KEY', 'lin_real_key'), 10);

    const result = await promise;
    expect(result).toBe('lin_real_key');
  });

  test('requestCredential returns null on timeout', async () => {
    const { requestCredential } = await import('../../src/host/credential-prompts.js');

    // Use a very short timeout for testing
    const result = await requestCredential('test-session', 'MISSING_KEY', 50);
    expect(result).toBeNull();
  });

  test('duplicate requests for same credential piggyback', async () => {
    const { requestCredential, resolveCredential } = await import('../../src/host/credential-prompts.js');

    const p1 = requestCredential('test-session', 'API_KEY');
    const p2 = requestCredential('test-session', 'API_KEY');

    setTimeout(() => resolveCredential('test-session', 'API_KEY', 'the_value'), 10);

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe('the_value');
    expect(r2).toBe('the_value');
  });

  test('three or more piggybacked requests all resolve', async () => {
    const { requestCredential, resolveCredential } = await import('../../src/host/credential-prompts.js');

    const p1 = requestCredential('test-session', 'MULTI_KEY');
    const p2 = requestCredential('test-session', 'MULTI_KEY');
    const p3 = requestCredential('test-session', 'MULTI_KEY');

    setTimeout(() => resolveCredential('test-session', 'MULTI_KEY', 'val'), 10);

    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    expect(r1).toBe('val');
    expect(r2).toBe('val');
    expect(r3).toBe('val');
  });

  test('resolveCredential returns false if no pending request', async () => {
    const { resolveCredential } = await import('../../src/host/credential-prompts.js');
    const found = resolveCredential('test-session', 'NOPE', 'val');
    expect(found).toBe(false);
  });

  test('integration: emits event and blocks until credential provided', async () => {
    const { requestCredential, resolveCredential } = await import('../../src/host/credential-prompts.js');

    // Simulate the server-completions flow:
    // 1. Detect missing credential
    // 2. Emit event (we'll just verify the blocking behavior)
    // 3. Block until resolved
    const events: string[] = [];

    const promise = (async () => {
      events.push('requesting');
      const value = await requestCredential('int-test', 'GITHUB_TOKEN', 5000);
      events.push(`got:${value}`);
      return value;
    })();

    // Simulate user providing credential after a delay
    await new Promise(r => setTimeout(r, 20));
    events.push('providing');
    resolveCredential('int-test', 'GITHUB_TOKEN', 'ghp_secret');

    const result = await promise;
    expect(result).toBe('ghp_secret');
    expect(events).toEqual(['requesting', 'providing', 'got:ghp_secret']);
  });

  test('cleanupSession resolves all pending with null', async () => {
    const { requestCredential, cleanupSession } = await import('../../src/host/credential-prompts.js');

    const p1 = requestCredential('cleanup-test', 'KEY_A', 30_000);
    const p2 = requestCredential('cleanup-test', 'KEY_B', 30_000);

    // Cleanup should resolve both with null
    cleanupSession('cleanup-test');

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBeNull();
    expect(r2).toBeNull();
  });
});
