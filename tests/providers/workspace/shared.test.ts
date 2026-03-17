import { describe, test, expect, vi, beforeEach } from 'vitest';
import { createOrchestrator } from '../../../src/providers/workspace/shared.js';
import type { WorkspaceProvider, WorkspaceBackend, FileChange } from '../../../src/providers/workspace/types.js';
import type { ScannerProvider, ScanResult } from '../../../src/providers/scanner/types.js';

// ═══════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════

function textChange(path: string, content: string, type: 'added' | 'modified' = 'added'): FileChange {
  const buf = Buffer.from(content, 'utf-8');
  return { path, type, content: buf, size: buf.length };
}

function deleteChange(path: string): FileChange {
  return { path, type: 'deleted', size: 0 };
}

function binaryChange(path: string, size = 100): FileChange {
  // Buffer with null bytes
  const buf = Buffer.alloc(size);
  buf[0] = 0x89; // PNG-like header
  buf[1] = 0x00; // null byte
  return { path, type: 'added', content: buf, size: buf.length };
}

function createMockScanner(overrides?: Partial<ScannerProvider>): ScannerProvider {
  return {
    scanInput: vi.fn(async () => ({ verdict: 'PASS' as const })),
    scanOutput: vi.fn(async () => ({ verdict: 'PASS' as const })),
    canaryToken: vi.fn(() => 'CANARY-mock'),
    checkCanary: vi.fn(() => false),
    ...overrides,
  };
}

function createMockBackend(overrides?: Partial<WorkspaceBackend>): WorkspaceBackend {
  return {
    mount: vi.fn(async (scope, id) => `/workspace/${scope}/${id}`),
    diff: vi.fn(async () => []),
    commit: vi.fn(async () => {}),
    ...overrides,
  };
}

const AGENT_ID = 'test-agent';

// ═══════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════

describe('workspace/shared orchestrator', () => {
  let scanner: ScannerProvider;
  let backend: WorkspaceBackend;

  beforeEach(() => {
    scanner = createMockScanner();
    backend = createMockBackend();
  });

  // ── Scope tracking ──

  describe('scope tracking', () => {
    test('activeMounts returns correct scopes after mount', async () => {
      const provider = createOrchestrator({ backend, scanner, config: {}, agentId: AGENT_ID });

      await provider.mount('s1', ['agent', 'session']);
      const mounts = provider.activeMounts('s1');
      expect(mounts).toContain('agent');
      expect(mounts).toContain('session');
      expect(mounts).toHaveLength(2);
    });

    test('scopes accumulate across multiple mount calls (additive)', async () => {
      const provider = createOrchestrator({ backend, scanner, config: {}, agentId: AGENT_ID });

      await provider.mount('s1', ['session']);
      await provider.mount('s1', ['agent']);

      const mounts = provider.activeMounts('s1');
      expect(mounts).toContain('session');
      expect(mounts).toContain('agent');
      expect(mounts).toHaveLength(2);
    });

    test('already-mounted scope is not re-mounted on backend', async () => {
      const provider = createOrchestrator({ backend, scanner, config: {}, agentId: AGENT_ID });

      await provider.mount('s1', ['agent']);
      await provider.mount('s1', ['agent', 'session']);

      // Backend should be called once for agent and once for session (not twice for agent)
      expect(backend.mount).toHaveBeenCalledTimes(2);
    });

    test('mount with userId resolves user scope to userId instead of sessionId', async () => {
      const provider = createOrchestrator({ backend, scanner, config: {}, agentId: AGENT_ID });

      await provider.mount('s1', ['user'], { userId: 'alice' });

      // Backend should be called with scope='user', id='alice' (not 's1')
      expect(backend.mount).toHaveBeenCalledWith('user', 'alice');
    });

    test('mount without userId resolves user scope to sessionId', async () => {
      const provider = createOrchestrator({ backend, scanner, config: {}, agentId: AGENT_ID });

      await provider.mount('s1', ['user']);

      // Without userId, should fall back to sessionId
      expect(backend.mount).toHaveBeenCalledWith('user', 's1');
    });

    test('mount with userId resolves agent scope to agentId (not userId)', async () => {
      const provider = createOrchestrator({ backend, scanner, config: {}, agentId: AGENT_ID });

      await provider.mount('s1', ['agent'], { userId: 'alice' });

      // Agent scope uses agentId, not userId
      expect(backend.mount).toHaveBeenCalledWith('agent', AGENT_ID);
    });

    test('different sessions are independent', async () => {
      const provider = createOrchestrator({ backend, scanner, config: {}, agentId: AGENT_ID });

      await provider.mount('s1', ['agent']);
      await provider.mount('s2', ['session']);

      expect(provider.activeMounts('s1')).toEqual(['agent']);
      expect(provider.activeMounts('s2')).toEqual(['session']);
    });

    test('activeMounts returns empty for unknown session', () => {
      const provider = createOrchestrator({ backend, scanner, config: {}, agentId: AGENT_ID });
      expect(provider.activeMounts('unknown')).toEqual([]);
    });
  });

  // ── Commit pipeline: passthrough (no filtering/scanning) ──

  describe('commit pipeline — passthrough', () => {
    test('all changes pass through to backend.commit without filtering', async () => {
      const changes = [
        textChange('.git/config', 'git config data'),
        textChange('node_modules/lodash/index.js', 'module.exports'),
        textChange('app.log', 'log entries'),
        textChange('src/main.ts', 'console.log("hello")'),
      ];

      backend = createMockBackend({ diff: vi.fn(async () => changes) });
      const provider = createOrchestrator({
        backend, scanner, config: {}, agentId: AGENT_ID,
      });

      await provider.mount('s1', ['agent']);
      const result = await provider.commit('s1');

      const scope = result.scopes.agent!;
      expect(scope.status).toBe('committed');
      expect(scope.filesChanged).toBe(4);
      expect(backend.commit).toHaveBeenCalledWith('agent', AGENT_ID, changes);
    });

    test('binary files pass through without rejection', async () => {
      const changes = [binaryChange('image.png')];

      backend = createMockBackend({ diff: vi.fn(async () => changes) });
      const provider = createOrchestrator({
        backend, scanner, config: {}, agentId: AGENT_ID,
      });

      await provider.mount('s1', ['agent']);
      const result = await provider.commit('s1');

      const scope = result.scopes.agent!;
      expect(scope.status).toBe('committed');
      expect(scope.filesChanged).toBe(1);
    });

    test('large files pass through without rejection', async () => {
      const largeContent = Buffer.alloc(200, 'x');
      const changes: FileChange[] = [
        { path: 'big.txt', type: 'added', content: largeContent, size: largeContent.length },
      ];

      backend = createMockBackend({ diff: vi.fn(async () => changes) });
      const provider = createOrchestrator({
        backend, scanner, config: { maxFileSize: 100 }, agentId: AGENT_ID,
      });

      await provider.mount('s1', ['agent']);
      const result = await provider.commit('s1');

      const scope = result.scopes.agent!;
      expect(scope.status).toBe('committed');
      expect(scope.filesChanged).toBe(1);
    });

    test('scanner is not called during commit', async () => {
      const changes = [textChange('file.ts', 'code')];
      const scanFn = vi.fn(async () => ({ verdict: 'PASS' as const }));
      const trackScanner = createMockScanner({ scanOutput: scanFn });

      backend = createMockBackend({ diff: vi.fn(async () => changes) });
      const provider = createOrchestrator({
        backend, scanner: trackScanner, config: {}, agentId: AGENT_ID,
      });

      await provider.mount('s1', ['agent']);
      await provider.commit('s1');

      expect(scanFn).not.toHaveBeenCalled();
    });

    test('delete changes pass through', async () => {
      const changes = [deleteChange('old-file.txt')];

      backend = createMockBackend({ diff: vi.fn(async () => changes) });
      const provider = createOrchestrator({
        backend, scanner, config: {}, agentId: AGENT_ID,
      });

      await provider.mount('s1', ['agent']);
      const result = await provider.commit('s1');

      const scope = result.scopes.agent!;
      expect(scope.status).toBe('committed');
      expect(scope.filesChanged).toBe(1);
    });
  });

  // ── Commit results ──

  describe('commit results', () => {
    test('empty changeset returns status empty', async () => {
      backend = createMockBackend({ diff: vi.fn(async () => []) });
      const provider = createOrchestrator({
        backend, scanner, config: {}, agentId: AGENT_ID,
      });

      await provider.mount('s1', ['agent']);
      const result = await provider.commit('s1');

      const scope = result.scopes.agent!;
      expect(scope.status).toBe('empty');
      expect(scope.filesChanged).toBe(0);
      expect(scope.bytesChanged).toBe(0);
    });

    test('committed result reports correct file and byte counts', async () => {
      const content1 = 'hello'; // 5 bytes
      const content2 = 'world!'; // 6 bytes
      const changes = [
        textChange('a.txt', content1),
        textChange('b.txt', content2),
      ];

      backend = createMockBackend({ diff: vi.fn(async () => changes) });
      const provider = createOrchestrator({
        backend, scanner, config: {}, agentId: AGENT_ID,
      });

      await provider.mount('s1', ['agent']);
      const result = await provider.commit('s1');

      const scope = result.scopes.agent!;
      expect(scope.status).toBe('committed');
      expect(scope.filesChanged).toBe(2);
      expect(scope.bytesChanged).toBe(5 + 6);
    });

    test('no mounted scopes returns empty commit result', async () => {
      const provider = createOrchestrator({
        backend, scanner, config: {}, agentId: AGENT_ID,
      });

      // commit without mounting anything
      const result = await provider.commit('s1');
      expect(result.scopes).toEqual({});
    });

    test('multiple scopes produce independent results', async () => {
      backend = createMockBackend({
        diff: vi.fn(async (scope) => {
          if (scope === 'agent') {
            return [textChange('agent-file.ts', 'code')];
          }
          return []; // session scope has no changes
        }),
      });

      const provider = createOrchestrator({
        backend, scanner, config: {}, agentId: AGENT_ID,
      });

      await provider.mount('s1', ['agent', 'session']);
      const result = await provider.commit('s1');

      expect(result.scopes.agent!.status).toBe('committed');
      expect(result.scopes.agent!.filesChanged).toBe(1);
      expect(result.scopes.session!.status).toBe('empty');
    });
  });

  // ── Commit uses remembered userId ──

  describe('commit uses userId from mount', () => {
    test('commit resolves user scope with the userId provided during mount', async () => {
      const changes = [textChange('prefs.txt', 'dark mode')];
      backend = createMockBackend({ diff: vi.fn(async () => changes) });
      const provider = createOrchestrator({
        backend, scanner, config: {}, agentId: AGENT_ID,
      });

      // Mount with userId='alice'
      await provider.mount('s1', ['agent', 'user'], { userId: 'alice' });

      // Commit should use 'alice' (not 's1') for the user scope
      await provider.commit('s1');

      // backend.diff should be called with ('user', 'alice')
      expect(backend.diff).toHaveBeenCalledWith('user', 'alice');
      // backend.commit should be called with ('user', 'alice', ...)
      expect(backend.commit).toHaveBeenCalledWith('user', 'alice', expect.any(Array));
    });

    test('commit without userId falls back to sessionId for user scope', async () => {
      const changes = [textChange('prefs.txt', 'dark mode')];
      backend = createMockBackend({ diff: vi.fn(async () => changes) });
      const provider = createOrchestrator({
        backend, scanner, config: {}, agentId: AGENT_ID,
      });

      // Mount without userId
      await provider.mount('s1', ['user']);
      await provider.commit('s1');

      expect(backend.diff).toHaveBeenCalledWith('user', 's1');
    });

    test('cleanup removes remembered userId', async () => {
      const changes = [textChange('file.txt', 'data')];
      backend = createMockBackend({ diff: vi.fn(async () => changes) });
      const provider = createOrchestrator({
        backend, scanner, config: {}, agentId: AGENT_ID,
      });

      await provider.mount('s1', ['user'], { userId: 'alice' });
      await provider.cleanup('s1');

      // Re-mount without userId after cleanup — should not use old 'alice'
      await provider.mount('s1', ['user']);
      await provider.commit('s1');

      // The last diff call should use 's1' (sessionId fallback), not 'alice'
      const diffCalls = (backend.diff as any).mock.calls;
      const lastCall = diffCalls[diffCalls.length - 1];
      expect(lastCall).toEqual(['user', 's1']);
    });
  });

  // ── Cleanup ──

  describe('cleanup', () => {
    test('session scope tracking is removed after cleanup', async () => {
      const provider = createOrchestrator({
        backend, scanner, config: {}, agentId: AGENT_ID,
      });

      await provider.mount('s1', ['agent', 'session']);
      expect(provider.activeMounts('s1')).toHaveLength(2);

      await provider.cleanup('s1');
      expect(provider.activeMounts('s1')).toEqual([]);
    });

    test('cleanup of one session does not affect other sessions', async () => {
      const provider = createOrchestrator({
        backend, scanner, config: {}, agentId: AGENT_ID,
      });

      await provider.mount('s1', ['agent']);
      await provider.mount('s2', ['session']);

      await provider.cleanup('s1');

      expect(provider.activeMounts('s1')).toEqual([]);
      expect(provider.activeMounts('s2')).toEqual(['session']);
    });

    test('cleanup of non-existent session does not throw', async () => {
      const provider = createOrchestrator({
        backend, scanner, config: {}, agentId: AGENT_ID,
      });

      await expect(provider.cleanup('nonexistent')).resolves.toBeUndefined();
    });

    test('commit after cleanup returns empty result', async () => {
      backend = createMockBackend({
        diff: vi.fn(async () => [textChange('file.ts', 'code')]),
      });

      const provider = createOrchestrator({
        backend, scanner, config: {}, agentId: AGENT_ID,
      });

      await provider.mount('s1', ['agent']);
      await provider.cleanup('s1');

      const result = await provider.commit('s1');
      expect(result.scopes).toEqual({});
    });
  });
});
