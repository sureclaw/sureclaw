import { describe, test, expect, afterEach } from 'vitest';

describe('credential provide endpoint', () => {
  afterEach(async () => {
    const { cleanupSession } = await import('../../src/host/credential-prompts.js');
    cleanupSession('sess-1');
  });

  test('resolveCredential is called with correct args', async () => {
    const { requestCredential, resolveCredential, cleanupSession } = await import('../../src/host/credential-prompts.js');

    // Start a pending request
    const promise = requestCredential('sess-1', 'LINEAR_API_KEY', 5000);

    // Simulate the HTTP endpoint calling resolveCredential
    const found = resolveCredential('sess-1', 'LINEAR_API_KEY', 'lin_key_123');
    expect(found).toBe(true);

    const result = await promise;
    expect(result).toBe('lin_key_123');

    cleanupSession('sess-1');
  });
});
