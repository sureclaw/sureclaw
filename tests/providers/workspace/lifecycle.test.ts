import { describe, test, expect } from 'vitest';
import { resolve } from 'node:path';

describe('workspace lifecycle module', () => {
  test('exports WorkspaceLifecyclePlan type', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(resolve('src/providers/workspace/lifecycle.ts'), 'utf-8');
    expect(source).toContain('WorkspaceLifecyclePlan');
  });

  test('exports prepareGitWorkspace function', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(resolve('src/providers/workspace/lifecycle.ts'), 'utf-8');
    expect(source).toContain('export async function prepareGitWorkspace');
  });

  test('exports finalizeGitWorkspace function', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(resolve('src/providers/workspace/lifecycle.ts'), 'utf-8');
    expect(source).toContain('export async function finalizeGitWorkspace');
  });

  test('exports buildLifecyclePlan function', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(resolve('src/providers/workspace/lifecycle.ts'), 'utf-8');
    expect(source).toContain('export function buildLifecyclePlan');
  });
});
