/**
 * @ax/provider-sdk — Everything you need to build an AX provider.
 *
 * This package contains:
 * - All provider TypeScript interfaces (interfaces/)
 * - A contract test harness (testing/)
 * - Test fixtures per provider type (testing/fixtures/)
 * - safePath utility for file-based providers (utils/)
 *
 * For third-party provider authors:
 *
 *   import type { MemoryProvider, Config } from '@ax/provider-sdk';
 *   import { ProviderTestHarness } from '@ax/provider-sdk/testing';
 *
 *   // Your provider must export create(config):
 *   export async function create(config: Config): Promise<MemoryProvider> {
 *     return { ... };
 *   }
 *
 *   // Validate with the harness:
 *   const harness = new ProviderTestHarness('memory');
 *   const result = await harness.run(myProvider);
 */

// Re-export all provider interfaces
export * from './interfaces/index.js';

// Re-export test harness
export { ProviderTestHarness } from './testing/harness.js';
export type { TestResult, HarnessResult, ProviderKind } from './testing/harness.js';

// Re-export safe-path utility
export { safePath, assertWithinBase } from './utils/safe-path.js';
