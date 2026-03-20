import { describe, test, expect, vi, afterEach, beforeEach } from 'vitest';
import type { Config } from '../../../src/types.js';

const config = { profile: 'balanced', providers: {} } as unknown as Config;

const mockSearch = vi.fn();
vi.mock('@tavily/core', () => ({
  tavily: vi.fn(() => ({ search: mockSearch })),
}));

describe('tavily-search', () => {
  const originalApiKey = process.env.TAVILY_API_KEY;

  beforeEach(() => { vi.resetModules(); mockSearch.mockReset(); });
  afterEach(() => {
    if (originalApiKey !== undefined) process.env.TAVILY_API_KEY = originalApiKey;
    else delete process.env.TAVILY_API_KEY;
  });

  test('throws without TAVILY_API_KEY', async () => {
    delete process.env.TAVILY_API_KEY;
    const { create } = await import('../../../src/providers/web/tavily-search.js');
    const provider = await create(config);
    await expect(provider.search('test query')).rejects.toThrow('TAVILY_API_KEY');
  });

  test('search() returns taint-tagged results', async () => {
    process.env.TAVILY_API_KEY = 'tvly-test-key';
    mockSearch.mockResolvedValue({
      results: [
        { title: 'First', url: 'https://example.com/1', content: 'Desc 1', score: 0.95 },
        { title: 'Second', url: 'https://example.com/2', content: 'Desc 2', score: 0.85 },
      ],
    });

    const { create } = await import('../../../src/providers/web/tavily-search.js');
    const provider = await create(config);
    const results = await provider.search('test query');

    expect(results.length).toBe(2);
    expect(results[0].title).toBe('First');
    expect(results[0].taint.source).toBe('web_search');
    expect(results[0].taint.trust).toBe('external');
  });

  test('maxResults is capped at 20', async () => {
    process.env.TAVILY_API_KEY = 'tvly-test-key';
    mockSearch.mockResolvedValue({ results: [] });

    const { create } = await import('../../../src/providers/web/tavily-search.js');
    const provider = await create(config);
    await provider.search('test', 100);

    expect(mockSearch).toHaveBeenCalledWith('test', { maxResults: 20, searchDepth: 'basic' });
  });
});
