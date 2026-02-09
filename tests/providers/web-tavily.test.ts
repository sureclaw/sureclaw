import { describe, test, expect, vi, afterEach } from 'vitest';
import type { Config } from '../../src/providers/types.js';

const config = {
  profile: 'balanced',
  providers: { web: 'tavily' },
} as unknown as Config;

describe('web-tavily', () => {
  const originalApiKey = process.env.TAVILY_API_KEY;

  afterEach(() => {
    if (originalApiKey !== undefined) {
      process.env.TAVILY_API_KEY = originalApiKey;
    } else {
      delete process.env.TAVILY_API_KEY;
    }
  });

  test('throws without TAVILY_API_KEY', async () => {
    delete process.env.TAVILY_API_KEY;
    const { create } = await import('../../src/providers/web/tavily.js');
    const provider = await create(config);

    await expect(provider.search('test query')).rejects.toThrow('TAVILY_API_KEY');
  });

  test('search() returns taint-tagged results', async () => {
    process.env.TAVILY_API_KEY = 'tvly-test-key';

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url.includes('api.tavily.com')) {
        return new Response(JSON.stringify({
          results: [
            { title: 'First Result', url: 'https://example.com/1', content: 'Desc 1', score: 0.95 },
            { title: 'Second Result', url: 'https://example.com/2', content: 'Desc 2', score: 0.85 },
          ],
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return originalFetch(input, init);
    }) as typeof globalThis.fetch;

    try {
      const { create } = await import('../../src/providers/web/tavily.js');
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

  test('search sends correct request body', async () => {
    process.env.TAVILY_API_KEY = 'tvly-test-key';

    let capturedBody: Record<string, unknown> | undefined;
    let capturedHeaders: Record<string, string> | undefined;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url.includes('api.tavily.com')) {
        capturedBody = JSON.parse(init?.body as string);
        capturedHeaders = Object.fromEntries(
          Object.entries(init?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v as string]),
        );
        return new Response(JSON.stringify({ results: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return originalFetch(input, init);
    }) as typeof globalThis.fetch;

    try {
      const { create } = await import('../../src/providers/web/tavily.js');
      const provider = await create(config);
      await provider.search('test query', 3);

      expect(capturedBody).toEqual({
        query: 'test query',
        max_results: 3,
        search_depth: 'basic',
      });
      expect(capturedHeaders?.['authorization']).toBe('Bearer tvly-test-key');
      expect(capturedHeaders?.['content-type']).toBe('application/json');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('search handles empty results', async () => {
    process.env.TAVILY_API_KEY = 'tvly-test-key';

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url.includes('api.tavily.com')) {
        return new Response(JSON.stringify({ results: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return originalFetch(input, _init);
    }) as typeof globalThis.fetch;

    try {
      const { create } = await import('../../src/providers/web/tavily.js');
      const provider = await create(config);
      const results = await provider.search('nonexistent query');

      expect(results).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('search handles API errors', async () => {
    process.env.TAVILY_API_KEY = 'tvly-test-key';

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url.includes('api.tavily.com')) {
        return new Response('Rate limited', {
          status: 429,
          statusText: 'Too Many Requests',
        });
      }
      return originalFetch(input, _init);
    }) as typeof globalThis.fetch;

    try {
      const { create } = await import('../../src/providers/web/tavily.js');
      const provider = await create(config);

      await expect(provider.search('test')).rejects.toThrow('429');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('maxResults is capped at 20', async () => {
    process.env.TAVILY_API_KEY = 'tvly-test-key';

    let capturedBody: Record<string, unknown> | undefined;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url.includes('api.tavily.com')) {
        capturedBody = JSON.parse(init?.body as string);
        return new Response(JSON.stringify({ results: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return originalFetch(input, init);
    }) as typeof globalThis.fetch;

    try {
      const { create } = await import('../../src/providers/web/tavily.js');
      const provider = await create(config);
      await provider.search('test query', 100);

      expect(capturedBody?.max_results).toBe(20);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('fetch() is available (delegates to fetch provider)', async () => {
    process.env.TAVILY_API_KEY = 'tvly-test-key';

    const { create } = await import('../../src/providers/web/tavily.js');
    const provider = await create(config);

    expect(typeof provider.fetch).toBe('function');
    expect(typeof provider.search).toBe('function');
  });
});
