import { describe, test, expect } from 'vitest';
import { create } from '../../../src/providers/workspace-sync/none.js';
import type { Config } from '../../../src/types.js';

describe('No-op workspace sync provider', () => {
  test('pull returns zero-count result', async () => {
    const provider = await create({} as Config);
    const result = await provider.pull('/tmp/whatever', 'prefix/');
    expect(result.filesUpdated).toBe(0);
    expect(result.filesDeleted).toBe(0);
    expect(result.bytesTransferred).toBe(0);
    expect(result.durationMs).toBe(0);
  });

  test('uploadFile is a no-op', async () => {
    const provider = await create({} as Config);
    await expect(provider.uploadFile('/tmp/dir', 'prefix/', 'file.txt')).resolves.toBeUndefined();
  });

  test('pushAll returns zero-count result', async () => {
    const provider = await create({} as Config);
    const result = await provider.pushAll('/tmp/dir', 'prefix/');
    expect(result.filesUpdated).toBe(0);
    expect(result.filesDeleted).toBe(0);
    expect(result.bytesTransferred).toBe(0);
  });

  test('deleteFile is a no-op', async () => {
    const provider = await create({} as Config);
    await expect(provider.deleteFile('prefix/', 'file.txt')).resolves.toBeUndefined();
  });
});
