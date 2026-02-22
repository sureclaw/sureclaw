/**
 * Runtime asset resolvers — resolves project-root-relative paths using
 * import.meta.url so commands work from any working directory.
 *
 * provider-map.ts already does this right. This module applies the same
 * pattern to templates/, skills/, node_modules/.bin/tsx, and src/agent/runner.ts.
 *
 * Override with AX_TEMPLATES_DIR, AX_SKILLS_DIR, AX_TSX_BIN, or
 * AX_RUNNER_PATH environment variables for non-standard layouts.
 */

import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

// This file is at src/utils/assets.ts → two levels up is the project root.
const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Absolute path to the templates/ directory. */
export function templatesDir(): string {
  return process.env.AX_TEMPLATES_DIR ?? join(PROJECT_ROOT, 'templates');
}

/** Absolute path to the skills/ directory. */
export function skillsDir(): string {
  return process.env.AX_SKILLS_DIR ?? join(PROJECT_ROOT, 'skills');
}

/** Absolute path to the tsx binary. */
export function tsxBin(): string {
  return process.env.AX_TSX_BIN ?? join(PROJECT_ROOT, 'node_modules', '.bin', 'tsx');
}

/** Absolute path to src/agent/runner.ts (entrypoint for agent processes). */
export function runnerPath(): string {
  return process.env.AX_RUNNER_PATH ?? join(PROJECT_ROOT, 'src', 'agent', 'runner.ts');
}
