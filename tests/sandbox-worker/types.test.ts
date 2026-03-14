import { describe, test, expect } from 'vitest';

describe('SandboxClaimRequest workspace scopes', () => {
  test('claim request type includes scopes field', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync('src/sandbox-worker/types.ts', 'utf-8');
    expect(source).toContain('scopes');
    expect(source).toContain('gcsPrefix');
    expect(source).toContain('readOnly');
  });

  test('release response type includes staging field', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync('src/sandbox-worker/types.ts', 'utf-8');
    expect(source).toContain('SandboxReleaseResponse');
    expect(source).toContain('staging');
    expect(source).toContain('FileMeta');
  });
});
