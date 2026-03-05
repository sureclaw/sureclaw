import { describe, test, expect } from 'vitest';

describe('database/postgres', () => {
  test('module exports create function', async () => {
    const mod = await import('../../../src/providers/database/postgres.js');
    expect(typeof mod.create).toBe('function');
  });

  // Integration tests require a running PostgreSQL instance.
  // These are validated via acceptance tests in k8s environments.
});
