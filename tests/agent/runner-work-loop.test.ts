import { describe, it, expect, vi } from 'vitest';
import { HttpIPCClient } from '../../src/agent/http-ipc-client.js';

describe('HttpIPCClient.fetchWork', () => {
  it('returns payload on 200', async () => {
    const client = new HttpIPCClient({ hostUrl: 'http://localhost:9999' });
    // @ts-expect-error — accessing private for test
    client.token = 'test-token';

    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => '{"msg":"hello"}',
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await client.fetchWork(100, 0);
    expect(result).toBe('{"msg":"hello"}');

    vi.unstubAllGlobals();
  });

  it('returns null on 404 with no wait', async () => {
    const client = new HttpIPCClient({ hostUrl: 'http://localhost:9999' });
    // @ts-expect-error
    client.token = 'test-token';

    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: async () => 'not found',
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await client.fetchWork(100, 0);
    expect(result).toBeNull();

    vi.unstubAllGlobals();
  });
});
