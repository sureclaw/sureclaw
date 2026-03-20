import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 30_000,
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.worktrees/**',
      'dashboard/tests/**',
      'tests/e2e/**',
      'tests/acceptance/automated/**',
    ],
  },
});
