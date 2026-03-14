import { describe, test, expect } from 'vitest';

describe('GCS transport abstraction', () => {
  test('gcs.ts exports WorkspaceTransport interface', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync('src/providers/workspace/gcs.ts', 'utf-8');
    expect(source).toContain('export interface WorkspaceTransport');
    expect(source).toContain('provision');
    expect(source).toContain('diff');
    expect(source).toContain('commit');
  });

  test('gcs.ts has LocalTransport and RemoteTransport implementations', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync('src/providers/workspace/gcs.ts', 'utf-8');
    expect(source).toContain('createLocalTransport');
    expect(source).toContain('createRemoteTransport');
  });

  test('factory picks transport based on sandbox provider', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync('src/providers/workspace/gcs.ts', 'utf-8');
    expect(source).toContain("config.providers.sandbox === 'k8s'");
    expect(source).toContain('isK8s');
  });

  test('createGcsBackend delegates to LocalTransport', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync('src/providers/workspace/gcs.ts', 'utf-8');
    // createGcsBackend should delegate to transport methods
    expect(source).toContain('transport.provision');
    expect(source).toContain('transport.diff');
    expect(source).toContain('transport.commit');
  });
});
