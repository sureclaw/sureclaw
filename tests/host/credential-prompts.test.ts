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

  test('resolveCredential returns false if no pending request', async () => {
    const { resolveCredential } = await import('../../src/host/credential-prompts.js');
    const found = resolveCredential('test-session', 'NOPE', 'val');
    expect(found).toBe(false);
  });
});
