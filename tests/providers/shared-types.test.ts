import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Verify that provider categories don't import directly from sibling provider
 * directories. Cross-provider types must go through shared-types.ts.
 *
 * This is a structural test — it reads source files and checks import paths.
 * When a provider needs types from another category, it must use:
 *   import type { ... } from '../shared-types.js'
 * NOT:
 *   import type { ... } from '../channel/types.js'
 */
describe('cross-provider import isolation', () => {
  const providersDir = join(import.meta.dirname, '../../src/providers');

  // Provider categories that should NOT have direct sibling imports.
  // Routers are exempt because they import from router-utils.ts (shared).
  const categories = ['scheduler'];

  // Allowed import targets (not sibling providers)
  const allowedPatterns = [
    /from '\.\/(types|utils|index)/,       // own category files
    /from '\.\.\/shared-types/,            // cross-provider hub
    /from '\.\.\/router-utils/,            // shared router utils
    /from '\.\.\/\.\.\//,                  // parent (src/) imports like ../../types, ../../logger
    /from 'node:/,                          // Node.js builtins
  ];

  for (const category of categories) {
    test(`${category}/ has no direct sibling provider imports`, () => {
      const dir = join(providersDir, category);
      const files = ['types.ts', 'utils.ts', 'cron.ts', 'full.ts', 'none.ts'];

      for (const file of files) {
        let content: string;
        try {
          content = readFileSync(join(dir, file), 'utf-8');
        } catch {
          continue; // file doesn't exist, skip
        }

        // Find all import lines
        const importLines = content
          .split('\n')
          .filter(line => /^\s*import\s/.test(line));

        for (const line of importLines) {
          // Extract the from path
          const match = line.match(/from\s+['"]([^'"]+)['"]/);
          if (!match) continue;
          const importPath = match[1];

          // Skip if it matches an allowed pattern
          if (allowedPatterns.some(p => p.test(`from '${importPath}`))) continue;

          // If it looks like a sibling provider import, fail
          if (/^\.\.\/[a-z]+\//.test(importPath)) {
            throw new Error(
              `${category}/${file} has direct sibling provider import: "${importPath}". ` +
              `Use '../shared-types.js' instead.`
            );
          }
        }
      }
    });
  }

});
