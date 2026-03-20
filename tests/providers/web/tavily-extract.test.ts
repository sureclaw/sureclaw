import { describe, test, expect, vi, afterEach, beforeEach } from 'vitest';
import type { Config } from '../../../src/types.js';

const config = { profile: 'balanced', providers: {} } as unknown as Config;

const mockExtract = vi.fn();
vi.mock('@tavily/core', () => ({
  tavily: vi.fn(() => ({ extract: mockExtract })),
}));

describe('tavily-extract', () => {
  const originalApiKey = process.env.TAVILY_API_KEY;

  beforeEach(() => { vi.resetModules(); mockExtract.mockReset(); });
  afterEach(() => {
    if (originalApiKey !== undefined) process.env.TAVILY_API_KEY = originalApiKey;
    else delete process.env.TAVILY_API_KEY;
  });

  test('throws without TAVILY_API_KEY', async () => {
    delete process.env.TAVILY_API_KEY;
    const { create } = await import('../../../src/providers/web/tavily-extract.js');
    const provider = await create(config);
    await expect(provider.extract('https://example.com')).rejects.toThrow('TAVILY_API_KEY');
  });

  test('extract() returns content with taint tag', async () => {
    process.env.TAVILY_API_KEY = 'tvly-test-key';
    mockExtract.mockResolvedValue({
      results: [{ url: 'https://example.com', rawContent: '# Hello World\nPage content.' }],
      failedResults: [],
    });

    const { create } = await import('../../../src/providers/web/tavily-extract.js');
    const provider = await create(config);
    const result = await provider.extract('https://example.com');

    expect(result.url).toBe('https://example.com');
    expect(result.content).toBe('# Hello World\nPage content.');
    expect(result.taint.source).toBe('web_extract');
    expect(result.taint.trust).toBe('external');
  });

  test('extract() throws on failure', async () => {
    process.env.TAVILY_API_KEY = 'tvly-test-key';
    mockExtract.mockResolvedValue({
      results: [],
      failedResults: [{ url: 'https://example.com', error: 'Page not found' }],
    });

    const { create } = await import('../../../src/providers/web/tavily-extract.js');
    const provider = await create(config);
    await expect(provider.extract('https://example.com')).rejects.toThrow('Page not found');
  });
});
