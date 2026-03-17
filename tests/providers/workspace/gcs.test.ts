import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { WorkspaceBackend, WorkspaceScope, FileChange } from '../../../src/providers/workspace/types.js';

// ═══════════════════════════════════════════════════════
// In-memory GCS mock
// ═══════════════════════════════════════════════════════

/**
 * Minimal GCS bucket interface matching what createGcsBackend expects.
 * Stores objects in a Map for testing without real GCS.
 */
function createMockBucket() {
  const objects = new Map<string, Buffer>();

  const bucket = {
    getFiles: async (opts: { prefix: string }): Promise<[Array<{ name: string; download(): Promise<[Buffer]> }>]> => {
      const files = [...objects.entries()]
        .filter(([name]) => name.startsWith(opts.prefix))
        .map(([name, content]) => ({
          name,
          download: async () => [Buffer.from(content)] as [Buffer],
        }));
      return [files];
    },
    file: (name: string) => ({
      name,
      save: async (content: Buffer) => { objects.set(name, Buffer.from(content)); },
      delete: async () => { objects.delete(name); },
    }),
  };

  return { bucket, objects };
}

// ═══════════════════════════════════════════════════════
// Test helpers
// ═══════════════════════════════════════════════════════

let testDir: string;

// Lazy import — the module doesn't exist yet (RED phase)
async function importGcs() {
  return await import('../../../src/providers/workspace/gcs.js');
}

// ═══════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════

describe('workspace/gcs backend', () => {
  beforeEach(() => {
    testDir = join(tmpdir(), `ax-workspace-gcs-${randomUUID()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(testDir, { recursive: true }); } catch { /* cleanup best-effort */ }
  });

  // ── Mount ──

  describe('mount', () => {
    test('creates local cache directory and returns its path', async () => {
      const { createGcsBackend } = await importGcs();
      const { bucket } = createMockBucket();
      const backend = createGcsBackend(bucket, testDir, '');

      const path = await backend.mount('agent', 'test-agent');

      expect(path).toBeTruthy();
      expect(existsSync(path)).toBe(true);
      expect(path).toContain('agent');
      expect(path).toContain('test-agent');
    });

    test('downloads existing GCS objects into local cache', async () => {
      const { createGcsBackend } = await importGcs();
      const { bucket, objects } = createMockBucket();

      // Pre-populate GCS with files
      objects.set('agent/test-agent/readme.txt', Buffer.from('hello from gcs'));
      objects.set('agent/test-agent/src/main.ts', Buffer.from('console.log("hi")'));

      const backend = createGcsBackend(bucket, testDir, '');
      const mountPath = await backend.mount('agent', 'test-agent');

      expect(readFileSync(join(mountPath, 'readme.txt'), 'utf-8')).toBe('hello from gcs');
      expect(readFileSync(join(mountPath, 'src', 'main.ts'), 'utf-8')).toBe('console.log("hi")');
    });

    test('handles GCS prefix correctly', async () => {
      const { createGcsBackend } = await importGcs();
      const { bucket, objects } = createMockBucket();

      // Pre-populate with prefix
      objects.set('workspaces/agent/test-agent/file.txt', Buffer.from('prefixed'));

      const backend = createGcsBackend(bucket, testDir, 'workspaces');
      const mountPath = await backend.mount('agent', 'test-agent');

      expect(readFileSync(join(mountPath, 'file.txt'), 'utf-8')).toBe('prefixed');
    });

    test('empty bucket produces empty directory', async () => {
      const { createGcsBackend } = await importGcs();
      const { bucket } = createMockBucket();

      const backend = createGcsBackend(bucket, testDir, '');
      const mountPath = await backend.mount('session', 'sess-1');

      expect(existsSync(mountPath)).toBe(true);
    });

    test('uses safePath — path traversal segments are sanitized', async () => {
      const { createGcsBackend } = await importGcs();
      const { bucket } = createMockBucket();

      const backend = createGcsBackend(bucket, testDir, '');
      const path = await backend.mount('agent', '../../../etc');

      expect(path).not.toContain('..');
      expect(path.startsWith(testDir)).toBe(true);
    });
  });

  // ── Diff ──

  describe('diff', () => {
    test('detects added files', async () => {
      const { createGcsBackend } = await importGcs();
      const { bucket } = createMockBucket();

      const backend = createGcsBackend(bucket, testDir, '');
      const mountPath = await backend.mount('agent', 'test-agent');

      writeFileSync(join(mountPath, 'new-file.txt'), 'added content');

      const changes = await backend.diff('agent', 'test-agent');
      expect(changes).toHaveLength(1);
      expect(changes[0].type).toBe('added');
      expect(changes[0].path).toBe('new-file.txt');
      expect(changes[0].content?.toString('utf-8')).toBe('added content');
    });

    test('detects modified files', async () => {
      const { createGcsBackend } = await importGcs();
      const { bucket, objects } = createMockBucket();

      objects.set('agent/test-agent/existing.txt', Buffer.from('original'));

      const backend = createGcsBackend(bucket, testDir, '');
      const mountPath = await backend.mount('agent', 'test-agent');

      writeFileSync(join(mountPath, 'existing.txt'), 'modified');

      const changes = await backend.diff('agent', 'test-agent');
      expect(changes).toHaveLength(1);
      expect(changes[0].type).toBe('modified');
      expect(changes[0].path).toBe('existing.txt');
    });

    test('detects deleted files', async () => {
      const { createGcsBackend } = await importGcs();
      const { bucket, objects } = createMockBucket();

      objects.set('agent/test-agent/to-delete.txt', Buffer.from('will be gone'));

      const backend = createGcsBackend(bucket, testDir, '');
      const mountPath = await backend.mount('agent', 'test-agent');

      unlinkSync(join(mountPath, 'to-delete.txt'));

      const changes = await backend.diff('agent', 'test-agent');
      expect(changes).toHaveLength(1);
      expect(changes[0].type).toBe('deleted');
      expect(changes[0].path).toBe('to-delete.txt');
    });

    test('returns empty array when no changes', async () => {
      const { createGcsBackend } = await importGcs();
      const { bucket, objects } = createMockBucket();

      objects.set('agent/test-agent/stable.txt', Buffer.from('unchanged'));

      const backend = createGcsBackend(bucket, testDir, '');
      await backend.mount('agent', 'test-agent');

      const changes = await backend.diff('agent', 'test-agent');
      expect(changes).toHaveLength(0);
    });

    test('returns empty for unmounted scope', async () => {
      const { createGcsBackend } = await importGcs();
      const { bucket } = createMockBucket();

      const backend = createGcsBackend(bucket, testDir, '');
      const changes = await backend.diff('agent', 'not-mounted');
      expect(changes).toHaveLength(0);
    });
  });

  // ── Commit ──

  describe('commit', () => {
    test('uploads added files to GCS', async () => {
      const { createGcsBackend } = await importGcs();
      const { bucket, objects } = createMockBucket();

      const backend = createGcsBackend(bucket, testDir, '');
      await backend.mount('agent', 'test-agent');

      const changes: FileChange[] = [{
        path: 'new-file.txt',
        type: 'added',
        content: Buffer.from('new content'),
        size: 11,
      }];

      await backend.commit('agent', 'test-agent', changes);

      expect(objects.get('agent/test-agent/new-file.txt')?.toString('utf-8')).toBe('new content');
    });

    test('uploads modified files to GCS', async () => {
      const { createGcsBackend } = await importGcs();
      const { bucket, objects } = createMockBucket();

      objects.set('agent/test-agent/file.txt', Buffer.from('old'));

      const backend = createGcsBackend(bucket, testDir, '');
      await backend.mount('agent', 'test-agent');

      const changes: FileChange[] = [{
        path: 'file.txt',
        type: 'modified',
        content: Buffer.from('updated'),
        size: 7,
      }];

      await backend.commit('agent', 'test-agent', changes);

      expect(objects.get('agent/test-agent/file.txt')?.toString('utf-8')).toBe('updated');
    });

    test('deletes removed files from GCS', async () => {
      const { createGcsBackend } = await importGcs();
      const { bucket, objects } = createMockBucket();

      objects.set('agent/test-agent/old-file.txt', Buffer.from('will be deleted'));

      const backend = createGcsBackend(bucket, testDir, '');
      await backend.mount('agent', 'test-agent');

      const changes: FileChange[] = [{
        path: 'old-file.txt',
        type: 'deleted',
        size: 0,
      }];

      await backend.commit('agent', 'test-agent', changes);

      expect(objects.has('agent/test-agent/old-file.txt')).toBe(false);
    });

    test('uses GCS prefix for object keys', async () => {
      const { createGcsBackend } = await importGcs();
      const { bucket, objects } = createMockBucket();

      const backend = createGcsBackend(bucket, testDir, 'workspaces');
      await backend.mount('agent', 'test-agent');

      const changes: FileChange[] = [{
        path: 'file.txt',
        type: 'added',
        content: Buffer.from('prefixed content'),
        size: 16,
      }];

      await backend.commit('agent', 'test-agent', changes);

      expect(objects.has('workspaces/agent/test-agent/file.txt')).toBe(true);
    });

    test('re-snapshots after commit — subsequent diff is clean', async () => {
      const { createGcsBackend } = await importGcs();
      const { bucket } = createMockBucket();

      const backend = createGcsBackend(bucket, testDir, '');
      const mountPath = await backend.mount('agent', 'test-agent');

      // Write a file and commit
      writeFileSync(join(mountPath, 'file.txt'), 'content');
      const changes = await backend.diff('agent', 'test-agent');
      await backend.commit('agent', 'test-agent', changes);

      // Subsequent diff should be clean
      const changes2 = await backend.diff('agent', 'test-agent');
      expect(changes2).toHaveLength(0);
    });

    test('no-op for unmounted scope', async () => {
      const { createGcsBackend } = await importGcs();
      const { bucket } = createMockBucket();

      const backend = createGcsBackend(bucket, testDir, '');

      // Should not throw
      await backend.commit('agent', 'not-mounted', []);
    });

    test('handles delete of already-absent GCS object gracefully', async () => {
      const { createGcsBackend } = await importGcs();
      const { bucket } = createMockBucket();

      const backend = createGcsBackend(bucket, testDir, '');
      await backend.mount('agent', 'test-agent');

      const changes: FileChange[] = [{
        path: 'nonexistent.txt',
        type: 'deleted',
        size: 0,
      }];

      // Should not throw
      await backend.commit('agent', 'test-agent', changes);
    });
  });

  // ── Credentials validation ──

  describe('create() credentials check', () => {
    const origEnv = process.env.GOOGLE_APPLICATION_CREDENTIALS;

    afterEach(() => {
      if (origEnv !== undefined) {
        process.env.GOOGLE_APPLICATION_CREDENTIALS = origEnv;
      } else {
        delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
      }
    });

    test('throws clear error when GOOGLE_APPLICATION_CREDENTIALS points to missing file', async () => {
      const { create } = await importGcs();
      process.env.GOOGLE_APPLICATION_CREDENTIALS = '/nonexistent/path/key.json';

      const config = {
        workspace: { bucket: 'test-bucket' },
        providers: { sandbox: 'subprocess' },
      } as any;

      await expect(create(config)).rejects.toThrow(
        /credentials file not found.*\/nonexistent\/path\/key\.json.*gcs-key/
      );
    });
  });

  // ── Full lifecycle ──

  describe('full lifecycle', () => {
    test('mount → write → diff → commit → re-mount preserves data in GCS', async () => {
      const { createGcsBackend } = await importGcs();
      const { bucket, objects } = createMockBucket();

      // Session 1: mount, write, commit
      const backend1 = createGcsBackend(bucket, testDir, '');
      const mountPath1 = await backend1.mount('agent', 'test-agent');

      writeFileSync(join(mountPath1, 'persistent.txt'), 'survives');
      const changes = await backend1.diff('agent', 'test-agent');
      await backend1.commit('agent', 'test-agent', changes);

      // Verify GCS has the file
      expect(objects.has('agent/test-agent/persistent.txt')).toBe(true);

      // Session 2: fresh backend, different cache dir, mount same scope
      const testDir2 = join(tmpdir(), `ax-workspace-gcs-${randomUUID()}`);
      mkdirSync(testDir2, { recursive: true });

      try {
        const backend2 = createGcsBackend(bucket, testDir2, '');
        const mountPath2 = await backend2.mount('agent', 'test-agent');

        // File should be downloaded from GCS
        expect(readFileSync(join(mountPath2, 'persistent.txt'), 'utf-8')).toBe('survives');
      } finally {
        try { rmSync(testDir2, { recursive: true }); } catch { /* cleanup */ }
      }
    });

    test('different scopes use different GCS key prefixes', async () => {
      const { createGcsBackend } = await importGcs();
      const { bucket, objects } = createMockBucket();

      const backend = createGcsBackend(bucket, testDir, '');

      await backend.mount('agent', 'my-agent');
      await backend.mount('session', 'sess-1');

      const agentChanges: FileChange[] = [{
        path: 'agent-file.txt', type: 'added',
        content: Buffer.from('agent data'), size: 10,
      }];
      const sessionChanges: FileChange[] = [{
        path: 'session-file.txt', type: 'added',
        content: Buffer.from('session data'), size: 12,
      }];

      await backend.commit('agent', 'my-agent', agentChanges);
      await backend.commit('session', 'sess-1', sessionChanges);

      expect(objects.has('agent/my-agent/agent-file.txt')).toBe(true);
      // 'session' scope maps to 'scratch' folder in GCS
      expect(objects.has('scratch/sess-1/session-file.txt')).toBe(true);
      // Cross-contamination check
      expect(objects.has('agent/my-agent/session-file.txt')).toBe(false);
      expect(objects.has('scratch/sess-1/agent-file.txt')).toBe(false);
    });

    test('incremental commits accumulate in GCS', async () => {
      const { createGcsBackend } = await importGcs();
      const { bucket, objects } = createMockBucket();

      const backend = createGcsBackend(bucket, testDir, '');
      const mountPath = await backend.mount('agent', 'test-agent');

      // First commit
      writeFileSync(join(mountPath, 'v1.txt'), 'version 1');
      const c1 = await backend.diff('agent', 'test-agent');
      await backend.commit('agent', 'test-agent', c1);

      // Second commit
      writeFileSync(join(mountPath, 'v2.txt'), 'version 2');
      const c2 = await backend.diff('agent', 'test-agent');
      await backend.commit('agent', 'test-agent', c2);

      // Both files should be in GCS
      expect(objects.has('agent/test-agent/v1.txt')).toBe(true);
      expect(objects.has('agent/test-agent/v2.txt')).toBe(true);
    });
  });
});
