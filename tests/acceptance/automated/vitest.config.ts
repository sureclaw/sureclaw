import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 120_000,       // 2 min per test
    hookTimeout: 300_000,       // 5 min for globalSetup
    sequence: { concurrent: false },
    include: ['tests/acceptance/automated/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/mock-server/*.test.ts'],
    globalSetup: ['tests/acceptance/automated/global-setup.ts'],
  },
});
