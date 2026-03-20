import { describe, test, expect, vi, afterEach, beforeEach } from 'vitest';
import type { Config } from '../../../src/types.js';

const config = { profile: 'balanced', providers: {} } as unknown as Config;

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('brave-search', () => {
  const originalApiKey = process.env.BRAVE_API_KEY;

  beforeEach(() => { mockFetch.mockReset(); });
  afterEach(() => {
    if (originalApiKey !== undefined) process.env.BRAVE_API_KEY = originalApiKey;
    else delete process.env.BRAVE_API_KEY;
  });

  test('throws without BRAVE_API_KEY', async () => {
    delete process.env.BRAVE_API_KEY;
    const { create } = await import('../../../src/providers/web/brave-search.js');
    const provider = await create(config);
    await expect(provider.search('test')).rejects.toThrow('BRAVE_API_KEY');
  });

  test('search() returns taint-tagged results', async () => {
    process.env.BRAVE_API_KEY = 'BSA-test-key';
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        web: {
          results: [
            { title: 'Result 1', url: 'https://example.com/1', description: 'Desc 1' },
            { title: 'Result 2', url: 'https://example.com/2', description: 'Desc 2' },
          ],
        },
      }),
    });

    const { create } = await import('../../../src/providers/web/brave-search.js');
    const provider = await create(config);
    const results = await provider.search('test query', 2);

    expect(results.length).toBe(2);
    expect(results[0].title).toBe('Result 1');
    expect(results[0].snippet).toBe('Desc 1');
    expect(results[0].taint.source).toBe('web_search');
    expect(results[0].taint.trust).toBe('external');
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('api.search.brave.com'),
      expect.objectContaining({
        headers: expect.objectContaining({ 'X-Subscription-Token': 'BSA-test-key' }),
      }),
    );
  });

  test('search() throws on API error', async () => {
    process.env.BRAVE_API_KEY = 'BSA-test-key';
    mockFetch.mockResolvedValue({ ok: false, status: 429, statusText: 'Too Many Requests' });

    const { create } = await import('../../../src/providers/web/brave-search.js');
    const provider = await create(config);
    await expect(provider.search('test')).rejects.toThrow('429');
  });
});
