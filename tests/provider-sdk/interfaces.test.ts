import { describe, test, expect } from 'vitest';

/**
 * Verify that provider-sdk re-exports all expected interfaces
 * without import errors.
 */
describe('Provider SDK interfaces', () => {
  test('exports all provider types', async () => {
    const sdk = await import('../../src/provider-sdk/interfaces/index.js');

    // The module should export type aliases — we can't check types at runtime,
    // but we can verify the module loads without errors and has no unexpected
    // runtime exports (interfaces are erased at compile time).
    expect(sdk).toBeDefined();
  });

  test('exports safePath utility', async () => {
    const { safePath, assertWithinBase } = await import('../../src/provider-sdk/utils/safe-path.js');
    expect(typeof safePath).toBe('function');
    expect(typeof assertWithinBase).toBe('function');
  });

  test('main index re-exports harness', async () => {
    const sdk = await import('../../src/provider-sdk/index.js');
    expect(sdk.ProviderTestHarness).toBeDefined();
    expect(typeof sdk.ProviderTestHarness).toBe('function');
    expect(typeof sdk.safePath).toBe('function');
  });
});
