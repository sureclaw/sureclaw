import { tavily } from '@tavily/core';
import type { WebSearchProvider, SearchResult } from './types.js';
import type { Config, TaintTag } from '../../types.js';

const DEFAULT_MAX_RESULTS = 5;

function taintTag(): TaintTag {
  return { source: 'web_search', trust: 'external', timestamp: new Date() };
}

function requireApiKey(): string {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    throw new Error(
      'TAVILY_API_KEY environment variable is required.\n' +
      'Get an API key at https://tavily.com/',
    );
  }
  return apiKey;
}

export async function create(_config: Config): Promise<WebSearchProvider> {
  return {
    async search(query: string, maxResults?: number): Promise<SearchResult[]> {
      const apiKey = requireApiKey();
      const count = Math.min(maxResults ?? DEFAULT_MAX_RESULTS, 20);
      const client = tavily({ apiKey });
      const response = await client.search(query, {
        maxResults: count,
        searchDepth: 'basic',
      });

      const results = response.results ?? [];
      return results.slice(0, count).map((r): SearchResult => ({
        title: r.title,
        url: r.url,
        snippet: r.content,
        taint: taintTag(),
      }));
    },
  };
}
