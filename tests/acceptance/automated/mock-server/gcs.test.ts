import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { handleGCS, resetGCS, getGCSFiles } from './gcs.js';

describe('mock-gcs', () => {
  let port: number;
  let server: ReturnType<typeof createServer>;

  beforeEach(async () => {
    resetGCS();
    server = createServer(handleGCS);
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>(r => server.close(() => r()));
  });

  test('resumable upload: initiate, upload, download, delete cycle', async () => {
    // 1. Initiate resumable upload
    const initRes = await fetch(
      `http://127.0.0.1:${port}/upload/storage/v1/b/test-bucket/o?uploadType=resumable&name=docs/hello.txt`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contentType: 'text/plain' }),
      },
    );
    expect(initRes.status).toBe(200);
    const uploadUrl = initRes.headers.get('location')!;
    expect(uploadUrl).toContain('upload_id=');

    // 2. Upload content
    const uploadRes = await fetch(uploadUrl, {
      method: 'PUT',
      body: 'Hello, GCS!',
    });
    expect(uploadRes.status).toBe(200);
    const meta = await uploadRes.json();
    expect(meta.name).toBe('docs/hello.txt');
    expect(meta.bucket).toBe('test-bucket');

    // 3. List objects
    const listRes = await fetch(
      `http://127.0.0.1:${port}/storage/v1/b/test-bucket/o?prefix=docs/`,
    );
    const list = await listRes.json();
    expect(list.items).toHaveLength(1);
    expect(list.items[0].name).toBe('docs/hello.txt');

    // 4. Download
    const dlRes = await fetch(
      `http://127.0.0.1:${port}/storage/v1/b/test-bucket/o/${encodeURIComponent('docs/hello.txt')}?alt=media`,
    );
    expect(dlRes.status).toBe(200);
    expect(await dlRes.text()).toBe('Hello, GCS!');

    // 5. Get metadata
    const metaRes = await fetch(
      `http://127.0.0.1:${port}/storage/v1/b/test-bucket/o/${encodeURIComponent('docs/hello.txt')}`,
    );
    const metaJson = await metaRes.json();
    expect(metaJson.name).toBe('docs/hello.txt');
    expect(metaJson.size).toBe('11');

    // 6. Delete
    const delRes = await fetch(
      `http://127.0.0.1:${port}/storage/v1/b/test-bucket/o/${encodeURIComponent('docs/hello.txt')}`,
      { method: 'DELETE' },
    );
    expect(delRes.status).toBe(204);

    // 7. Verify deleted
    const gone = await fetch(
      `http://127.0.0.1:${port}/storage/v1/b/test-bucket/o/${encodeURIComponent('docs/hello.txt')}?alt=media`,
    );
    expect(gone.status).toBe(404);
  });

  test('multipart upload', async () => {
    const res = await fetch(
      `http://127.0.0.1:${port}/upload/storage/v1/b/mybucket/o?uploadType=multipart&name=file.json`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"key":"value"}',
      },
    );
    expect(res.status).toBe(200);
    const meta = await res.json();
    expect(meta.name).toBe('file.json');

    // Verify stored
    expect(getGCSFiles().has('mybucket/file.json')).toBe(true);
  });
});
