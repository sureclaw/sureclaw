import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Config } from '../../../src/types.js';
import { loadManifest } from '../../../src/providers/workspace-sync/manifest.js';

// Mock @google-cloud/storage before importing the provider
const mockGetFiles = vi.fn();
const mockFileSave = vi.fn();
const mockFileDownload = vi.fn();
const mockFileGetMetadata = vi.fn();
const mockFileDelete = vi.fn();

const mockFile = vi.fn().mockImplementation((_name: string) => ({
  save: mockFileSave,
  download: mockFileDownload,
  getMetadata: mockFileGetMetadata,
  delete: mockFileDelete,
  name: _name,
}));

const mockBucket = vi.fn().mockReturnValue({
  getFiles: mockGetFiles,
  file: mockFile,
});

vi.mock('@google-cloud/storage', () => {
  class MockStorage {
    bucket = mockBucket;
  }
  return { Storage: MockStorage };
});

vi.mock('../../../src/logger.js', () => ({
  getLogger: () => ({
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    }),
  }),
}));

// Import after mocks are set up
const { create } = await import('../../../src/providers/workspace-sync/gcs.js');

function makeConfig(bucket = 'test-bucket', prefix?: string): Config {
  return {
    workspace_sync: { bucket, ...(prefix ? { prefix } : {}) },
  } as unknown as Config;
}

describe('GCS workspace sync provider', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ax-gcs-sync-test-'));
    vi.clearAllMocks();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('create throws without bucket config', async () => {
    await expect(create({ workspace_sync: {} } as unknown as Config)).rejects.toThrow('bucket');
  });

  test('create throws without workspace_sync config', async () => {
    await expect(create({} as Config)).rejects.toThrow('bucket');
  });

  describe('pull', () => {
    test('cold start downloads all files', async () => {
      const provider = await create(makeConfig());
      const fileData = Buffer.from('hello world');

      const mockRemoteFile = {
        name: 'workspaces/main/agent/notes.md',
        getMetadata: vi.fn().mockResolvedValue([{
          etag: 'etag1',
          size: fileData.length,
          metadata: { 'write-ts': '1000' },
        }]),
        download: vi.fn().mockResolvedValue([fileData]),
      };
      mockGetFiles.mockResolvedValue([[mockRemoteFile]]);

      const result = await provider.pull(tmpDir, 'workspaces/main/agent/');

      expect(result.filesUpdated).toBe(1);
      expect(result.bytesTransferred).toBe(fileData.length);
      const content = readFileSync(join(tmpDir, 'notes.md'), 'utf-8');
      expect(content).toBe('hello world');
    });

    test('incremental pull skips unchanged files', async () => {
      const provider = await create(makeConfig());

      // Pre-populate manifest with matching etag
      const { saveManifest } = await import('../../../src/providers/workspace-sync/manifest.js');
      saveManifest(tmpDir, {
        'notes.md': { etag: 'etag1', writeTs: 1000, size: 11 },
      });
      writeFileSync(join(tmpDir, 'notes.md'), 'hello world');

      const mockRemoteFile = {
        name: 'workspaces/main/agent/notes.md',
        getMetadata: vi.fn().mockResolvedValue([{
          etag: 'etag1',
          size: 11,
          metadata: { 'write-ts': '1000' },
        }]),
        download: vi.fn(),
      };
      mockGetFiles.mockResolvedValue([[mockRemoteFile]]);

      const result = await provider.pull(tmpDir, 'workspaces/main/agent/');

      expect(result.filesUpdated).toBe(0);
      expect(mockRemoteFile.download).not.toHaveBeenCalled();
    });

    test('pull downloads file when etag differs', async () => {
      const provider = await create(makeConfig());

      const { saveManifest } = await import('../../../src/providers/workspace-sync/manifest.js');
      saveManifest(tmpDir, {
        'notes.md': { etag: 'old-etag', writeTs: 500, size: 5 },
      });
      writeFileSync(join(tmpDir, 'notes.md'), 'old');

      const newData = Buffer.from('updated content');
      const mockRemoteFile = {
        name: 'prefix/notes.md',
        getMetadata: vi.fn().mockResolvedValue([{
          etag: 'new-etag',
          size: newData.length,
          metadata: { 'write-ts': '2000' },
        }]),
        download: vi.fn().mockResolvedValue([newData]),
      };
      mockGetFiles.mockResolvedValue([[mockRemoteFile]]);

      const result = await provider.pull(tmpDir, 'prefix/');

      expect(result.filesUpdated).toBe(1);
      const content = readFileSync(join(tmpDir, 'notes.md'), 'utf-8');
      expect(content).toBe('updated content');
    });

    test('pull deletes local files removed from remote', async () => {
      const provider = await create(makeConfig());

      const { saveManifest } = await import('../../../src/providers/workspace-sync/manifest.js');
      saveManifest(tmpDir, {
        'deleted.txt': { etag: 'e1', writeTs: 100, size: 5 },
      });
      writeFileSync(join(tmpDir, 'deleted.txt'), 'gone');

      // Remote has no files
      mockGetFiles.mockResolvedValue([[]]);

      const result = await provider.pull(tmpDir, 'prefix/');

      expect(result.filesDeleted).toBe(1);
      const manifest = loadManifest(tmpDir);
      expect(manifest['deleted.txt']).toBeUndefined();
    });
  });

  describe('uploadFile', () => {
    test('uploads file and updates manifest', async () => {
      const provider = await create(makeConfig());

      writeFileSync(join(tmpDir, 'test.txt'), 'content');
      mockFileSave.mockResolvedValue(undefined);
      mockFileGetMetadata.mockResolvedValue([{ etag: 'uploaded-etag' }]);

      await provider.uploadFile(tmpDir, 'workspaces/main/agent/', 'test.txt');

      expect(mockFile).toHaveBeenCalledWith('workspaces/main/agent/test.txt');
      expect(mockFileSave).toHaveBeenCalled();

      // Verify metadata includes host-id and write-ts
      const saveCall = mockFileSave.mock.calls[0];
      expect(saveCall[1].metadata.metadata['host-id']).toBeDefined();
      expect(saveCall[1].metadata.metadata['write-ts']).toBeDefined();

      // Manifest should be updated
      const manifest = loadManifest(tmpDir);
      expect(manifest['test.txt']).toBeDefined();
      expect(manifest['test.txt'].etag).toBe('uploaded-etag');
    });

    test('handles missing local file gracefully', async () => {
      const provider = await create(makeConfig());
      // Should not throw — just log warning
      await expect(
        provider.uploadFile(tmpDir, 'prefix/', 'nonexistent.txt'),
      ).resolves.toBeUndefined();
      expect(mockFileSave).not.toHaveBeenCalled();
    });
  });

  describe('pushAll', () => {
    test('uploads all local files', async () => {
      const provider = await create(makeConfig());

      mkdirSync(join(tmpDir, 'subdir'), { recursive: true });
      writeFileSync(join(tmpDir, 'a.txt'), 'aaa');
      writeFileSync(join(tmpDir, 'subdir', 'b.txt'), 'bbb');

      mockFileSave.mockResolvedValue(undefined);
      mockFileGetMetadata.mockResolvedValue([{ etag: 'e' }]);

      const result = await provider.pushAll(tmpDir, 'prefix/');

      expect(result.filesUpdated).toBe(2);
      expect(result.bytesTransferred).toBe(6);
    });

    test('skips .gcs-manifest.json', async () => {
      const provider = await create(makeConfig());

      writeFileSync(join(tmpDir, '.gcs-manifest.json'), '{}');
      writeFileSync(join(tmpDir, 'real.txt'), 'data');

      mockFileSave.mockResolvedValue(undefined);
      mockFileGetMetadata.mockResolvedValue([{ etag: 'e' }]);

      const result = await provider.pushAll(tmpDir, 'prefix/');

      expect(result.filesUpdated).toBe(1);
    });
  });

  describe('deleteFile', () => {
    test('deletes remote file', async () => {
      const provider = await create(makeConfig());
      mockFileDelete.mockResolvedValue(undefined);

      await provider.deleteFile('prefix/', 'old.txt');

      expect(mockFile).toHaveBeenCalledWith('prefix/old.txt');
      expect(mockFileDelete).toHaveBeenCalled();
    });
  });

  describe('prefix configuration', () => {
    test('prepends global prefix when configured', async () => {
      const provider = await create(makeConfig('bucket', 'my-prefix'));

      writeFileSync(join(tmpDir, 'test.txt'), 'data');
      mockFileSave.mockResolvedValue(undefined);
      mockFileGetMetadata.mockResolvedValue([{ etag: 'e' }]);

      await provider.uploadFile(tmpDir, 'workspaces/main/agent/', 'test.txt');

      expect(mockFile).toHaveBeenCalledWith('my-prefix/workspaces/main/agent/test.txt');
    });
  });
});
