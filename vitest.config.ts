import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 30_000,
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.worktrees/**',
      'ui/admin/tests/**',
      // `ui/chat` has its own vite-backed test harness (its own package.json
      // with `ai`, React, assistant-ui) — running its tests from the root
      // runner fails because root `node_modules` doesn't have those deps.
      // Run chat tests via `cd ui/chat && npx vitest run`.
      'ui/chat/**',
      'tests/e2e/**',
    ],
  },
});
