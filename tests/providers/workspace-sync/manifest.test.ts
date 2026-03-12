import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadManifest,
  saveManifest,
  updateManifestEntry,
  removeManifestEntry,
} from '../../../src/providers/workspace-sync/manifest.js';

describe('Workspace sync manifest', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ax-manifest-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('loadManifest returns empty object for missing manifest', () => {
    const manifest = loadManifest(tmpDir);
    expect(manifest).toEqual({});
  });

  test('save and load round-trip', () => {
    const data = {
      'notes.md': { etag: 'abc123', writeTs: 1000, size: 42 },
      'files/image.png': { etag: 'def456', writeTs: 2000, size: 1024 },
    };
    saveManifest(tmpDir, data);
    const loaded = loadManifest(tmpDir);
    expect(loaded).toEqual(data);
  });

  test('updateManifestEntry merges into existing manifest', () => {
    saveManifest(tmpDir, {
      'a.txt': { etag: 'e1', writeTs: 100, size: 10 },
    });

    updateManifestEntry(tmpDir, 'b.txt', { etag: 'e2', writeTs: 200, size: 20 });

    const manifest = loadManifest(tmpDir);
    expect(manifest['a.txt']).toEqual({ etag: 'e1', writeTs: 100, size: 10 });
    expect(manifest['b.txt']).toEqual({ etag: 'e2', writeTs: 200, size: 20 });
  });

  test('updateManifestEntry overwrites existing entry', () => {
    saveManifest(tmpDir, {
      'a.txt': { etag: 'old', writeTs: 100, size: 10 },
    });

    updateManifestEntry(tmpDir, 'a.txt', { etag: 'new', writeTs: 200, size: 30 });

    const manifest = loadManifest(tmpDir);
    expect(manifest['a.txt']).toEqual({ etag: 'new', writeTs: 200, size: 30 });
  });

  test('removeManifestEntry deletes entry', () => {
    saveManifest(tmpDir, {
      'a.txt': { etag: 'e1', writeTs: 100, size: 10 },
      'b.txt': { etag: 'e2', writeTs: 200, size: 20 },
    });

    removeManifestEntry(tmpDir, 'a.txt');

    const manifest = loadManifest(tmpDir);
    expect(manifest['a.txt']).toBeUndefined();
    expect(manifest['b.txt']).toEqual({ etag: 'e2', writeTs: 200, size: 20 });
  });

  test('loadManifest returns empty object for corrupt JSON', () => {
    const { writeFileSync } = require('node:fs');
    writeFileSync(join(tmpDir, '.gcs-manifest.json'), 'not valid json');
    const manifest = loadManifest(tmpDir);
    expect(manifest).toEqual({});
  });

  test('manifest is persisted as formatted JSON', () => {
    saveManifest(tmpDir, { 'x.txt': { etag: 'e', writeTs: 1, size: 1 } });
    const raw = readFileSync(join(tmpDir, '.gcs-manifest.json'), 'utf-8');
    expect(raw).toContain('\n'); // formatted, not minified
  });
});
