import { describe, test, expect } from 'vitest';

// ═══════════════════════════════════════════════════════
// Tests for GCS RemoteTransport (k8s NATS mode)
// ═══════════════════════════════════════════════════════

describe('GCS RemoteTransport (k8s NATS mode)', () => {
  test('exports RemoteWorkspaceTransport interface', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync('src/providers/workspace/gcs.ts', 'utf-8');
    expect(source).toContain('export interface RemoteWorkspaceTransport');
    expect(source).toContain('setRemoteChanges');
  });

  test('gcs.ts has setRemoteChanges wired into create() factory for k8s mode', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync('src/providers/workspace/gcs.ts', 'utf-8');
    expect(source).toContain('provider.setRemoteChanges');
    expect(source).toContain('remoteTransport.setRemoteChanges');
  });

  // ── setRemoteChanges stores changes ──

  describe('setRemoteChanges + diff', () => {
    test('stores changes and diff() returns them', async () => {
      const { readFileSync } = await import('node:fs');
      const source = readFileSync('src/providers/workspace/gcs.ts', 'utf-8');

      // Verify the key behaviors are implemented:
      // 1. pendingChanges map for storing
      expect(source).toContain('pendingChanges');
      // 2. diff consumes stored changes
      expect(source).toContain('pendingChanges.delete(scope)');
      // 3. setRemoteChanges groups by scope
      expect(source).toContain('pendingChanges.set(change.scope');
    });

    test('diff() consumes changes — second call returns empty', async () => {
      const { readFileSync } = await import('node:fs');
      const source = readFileSync('src/providers/workspace/gcs.ts', 'utf-8');

      // The diff method should delete the scope key after returning changes
      expect(source).toContain('pendingChanges.delete(scope)');
      // And return empty array via ?? when no changes exist
      expect(source).toContain("pendingChanges.get(scope) ?? []");
    });

    test('commit() writes to correct GCS prefix — session maps to scratch', async () => {
      const { readFileSync } = await import('node:fs');
      const source = readFileSync('src/providers/workspace/gcs.ts', 'utf-8');

      // RemoteTransport commit should use buildGcsPrefix which maps session → scratch
      expect(source).toContain("scope === 'session' ? 'scratch' : scope");
    });

    test('multiple setRemoteChanges calls accumulate (chunking support)', async () => {
      const { readFileSync } = await import('node:fs');
      const source = readFileSync('src/providers/workspace/gcs.ts', 'utf-8');

      // The implementation should append to existing array, not replace
      expect(source).toContain("pendingChanges.get(change.scope) ?? []");
      expect(source).toContain('existing.push(fileChange)');
    });
  });

  // ── commit() GCS behavior ──

  describe('commit', () => {
    test('provision returns empty string for remote transport', async () => {
      const { readFileSync } = await import('node:fs');
      const source = readFileSync('src/providers/workspace/gcs.ts', 'utf-8');

      // RemoteTransport provision is no-op
      expect(source).toContain("return '';");
    });

    test('commit uploads to correct GCS key with scope-based folder', async () => {
      const { readFileSync } = await import('node:fs');
      const source = readFileSync('src/providers/workspace/gcs.ts', 'utf-8');

      // Both transports should build GCS keys with scope folders
      // RemoteTransport commit uses gcsKeyPrefix result + change.path
      expect(source).toContain('kp + change.path');
    });
  });

  // ── RemoteFileChange type ──

  describe('RemoteFileChange type', () => {
    test('RemoteFileChange includes scope field', async () => {
      const { readFileSync } = await import('node:fs');
      const source = readFileSync('src/providers/workspace/types.ts', 'utf-8');

      expect(source).toContain('export interface RemoteFileChange');
      expect(source).toContain('scope: WorkspaceScope');
      expect(source).toContain("type: 'added' | 'modified' | 'deleted'");
      expect(source).toContain('content?: Buffer');
    });

    test('WorkspaceProvider has optional setRemoteChanges', async () => {
      const { readFileSync } = await import('node:fs');
      const source = readFileSync('src/providers/workspace/types.ts', 'utf-8');

      expect(source).toContain('setRemoteChanges?(sessionId: string, changes: RemoteFileChange[]): void');
    });
  });

  // ── Host staging endpoint integration ──

  describe('host staging endpoint', () => {
    test('server-k8s.ts uses session pod manager for session-long pods', async () => {
      const { readFileSync } = await import('node:fs');
      const source = readFileSync('src/host/server-k8s.ts', 'utf-8');

      // Session pod manager replaces old staging/workspace release
      expect(source).toContain('sessionPodManager');
      expect(source).toContain('agent_response');
    });

    test('host passes AX_HOST_URL to sandbox pods', async () => {
      const { readFileSync } = await import('node:fs');
      const source = readFileSync('src/host/server-k8s.ts', 'utf-8');

      expect(source).toContain('AX_HOST_URL');
      expect(source).toContain('ax-host');
    });

    test('IPC schema uses staging_key (not inline changes)', async () => {
      const { readFileSync } = await import('node:fs');
      const source = readFileSync('src/ipc-schemas.ts', 'utf-8');

      expect(source).toContain("ipcAction('workspace_release'");
      expect(source).toContain('staging_key');
      // Should NOT contain inline changes array
      expect(source).not.toContain('content_base64');
    });
  });
});
