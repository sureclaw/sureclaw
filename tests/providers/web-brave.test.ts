import { describe, test, expect, vi, afterEach } from 'vitest';
import type { Config } from '../../src/providers/types.js';

const config = {
  profile: 'balanced',
  providers: { web: 'brave' },
} as unknown as Config;

describe('web-brave', () => {
  const originalApiKey = process.env.BRAVE_SEARCH_API_KEY;

  afterEach(() => {
    if (originalApiKey !== undefined) {
      process.env.BRAVE_SEARCH_API_KEY = originalApiKey;
    } else {
      delete process.env.BRAVE_SEARCH_API_KEY;
    }
  });

  test('throws without BRAVE_SEARCH_API_KEY', async () => {
    delete process.env.BRAVE_SEARCH_API_KEY;
    const { create } = await import('../../src/providers/web/brave.js');
    const provider = await create(config);

    await expect(provider.search('test query')).rejects.toThrow('BRAVE_SEARCH_API_KEY');
  });

  test('search() returns taint-tagged results', async () => {
    process.env.BRAVE_SEARCH_API_KEY = 'test-key';

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url.includes('api.search.brave.com')) {
        return new Response(JSON.stringify({
          web: {
            results: [
              { title: 'First Result', url: 'https://example.com/1', description: 'Desc 1' },
              { title: 'Second Result', url: 'https://example.com/2', description: 'Desc 2' },
            ],
          },
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return originalFetch(input, init);
    }) as typeof globalThis.fetch;

    try {
      const { create } = await import('../../src/providers/web/brave.js');
      const provider = await create(config);
      const results = await provider.search('test query');

      expect(results.length).toBe(2);
      expect(results[0].title).toBe('First Result');
      expect(results[0].url).toBe('https://example.com/1');
      expect(results[0].snippet).toBe('Desc 1');
      expect(results[0].taint.source).toBe('web_search');
      expect(results[0].taint.trust).toBe('external');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('search respects maxResults parameter', async () => {
    process.env.BRAVE_SEARCH_API_KEY = 'test-key';

    let capturedUrl: string | undefined;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url.includes('api.search.brave.com')) {
        capturedUrl = url;
        return new Response(JSON.stringify({
          web: {
            results: Array.from({ length: 10 }, (_, i) => ({
              title: `Result ${i}`,
              url: `https://example.com/${i}`,
              description: `Description ${i}`,
            })),
          },
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return originalFetch(input, _init);
    }) as typeof globalThis.fetch;

    try {
      const { create } = await import('../../src/providers/web/brave.js');
      const provider = await create(config);
      const results = await provider.search('test query', 3);

      expect(capturedUrl).toContain('count=3');
      expect(results.length).toBe(3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('search handles empty results', async () => {
    process.env.BRAVE_SEARCH_API_KEY = 'test-key';

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url.includes('api.search.brave.com')) {
        return new Response(JSON.stringify({ web: { results: [] } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return originalFetch(input, _init);
    }) as typeof globalThis.fetch;

    try {
      const { create } = await import('../../src/providers/web/brave.js');
      const provider = await create(config);
      const results = await provider.search('nonexistent query');

      expect(results).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('search handles API errors', async () => {
    process.env.BRAVE_SEARCH_API_KEY = 'test-key';

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url.includes('api.search.brave.com')) {
        return new Response('Rate limited', {
          status: 429,
          statusText: 'Too Many Requests',
        });
      }
      return originalFetch(input, _init);
    }) as typeof globalThis.fetch;

    try {
      const { create } = await import('../../src/providers/web/brave.js');
      const provider = await create(config);

      await expect(provider.search('test')).rejects.toThrow('429');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('maxResults is capped at 20', async () => {
    process.env.BRAVE_SEARCH_API_KEY = 'test-key';

    let capturedUrl: string | undefined;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url.includes('api.search.brave.com')) {
        capturedUrl = url;
        return new Response(JSON.stringify({ web: { results: [] } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return originalFetch(input, _init);
    }) as typeof globalThis.fetch;

    try {
      const { create } = await import('../../src/providers/web/brave.js');
      const provider = await create(config);
      await provider.search('test query', 100);

      expect(capturedUrl).toContain('count=20');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('fetch() is available (delegates to fetch provider)', async () => {
    process.env.BRAVE_SEARCH_API_KEY = 'test-key';

    const { create } = await import('../../src/providers/web/brave.js');
    const provider = await create(config);

    expect(typeof provider.fetch).toBe('function');
    expect(typeof provider.search).toBe('function');
  });
});
