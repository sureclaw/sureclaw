import type { WebSearchProvider, SearchResult } from './types.js';
import type { Config, TaintTag } from '../../types.js';

const BRAVE_API_URL = 'https://api.search.brave.com/res/v1/web/search';
const DEFAULT_MAX_RESULTS = 5;

function taintTag(): TaintTag {
  return { source: 'web_search', trust: 'external', timestamp: new Date() };
}

function requireApiKey(): string {
  const apiKey = process.env.BRAVE_API_KEY;
  if (!apiKey) {
    throw new Error(
      'BRAVE_API_KEY environment variable is required.\n' +
      'Get an API key at https://brave.com/search/api/',
    );
  }
  return apiKey;
}

export async function create(_config: Config): Promise<WebSearchProvider> {
  return {
    async search(query: string, maxResults?: number): Promise<SearchResult[]> {
      const apiKey = requireApiKey();
      const count = Math.min(maxResults ?? DEFAULT_MAX_RESULTS, 20);

      const params = new URLSearchParams({ q: query, count: String(count) });
      const resp = await globalThis.fetch(`${BRAVE_API_URL}?${params}`, {
        headers: {
          'Accept': 'application/json',
          'Accept-Encoding': 'gzip',
          'X-Subscription-Token': apiKey,
        },
      });

      if (!resp.ok) {
        throw new Error(`Brave Search API error: ${resp.status} ${resp.statusText}`);
      }

      const data = await resp.json();
      const results = data.web?.results ?? [];

      return results.slice(0, count).map((r: any): SearchResult => ({
        title: r.title ?? '',
        url: r.url ?? '',
        snippet: r.description ?? '',
        taint: taintTag(),
      }));
    },
  };
}
