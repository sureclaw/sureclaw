import type { WebProvider, FetchRequest, FetchResponse, SearchResult, TaintTag, Config } from '../types.js';

/**
 * Web search provider using Brave Search API.
 *
 * Requires BRAVE_SEARCH_API_KEY environment variable.
 * Falls back to the base fetch provider for regular HTTP requests.
 * All search results are taint-tagged as external content.
 */

const BRAVE_API_URL = 'https://api.search.brave.com/res/v1/web/search';
const DEFAULT_MAX_RESULTS = 5;
const SEARCH_TIMEOUT_MS = 10_000;

function taintTag(): TaintTag {
  return { source: 'web_search', trust: 'external', timestamp: new Date() };
}

interface BraveSearchResult {
  title: string;
  url: string;
  description: string;
}

interface BraveSearchResponse {
  web?: {
    results: BraveSearchResult[];
  };
}

export async function create(config: Config): Promise<WebProvider> {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY;

  // Lazy-load the fetch provider for regular HTTP requests
  const { create: createFetch } = await import('./fetch.js');
  const fetchProvider = await createFetch(config);

  return {
    async fetch(req: FetchRequest): Promise<FetchResponse> {
      return fetchProvider.fetch(req);
    },

    async search(query: string, maxResults?: number): Promise<SearchResult[]> {
      if (!apiKey) {
        throw new Error(
          'Web search requires BRAVE_SEARCH_API_KEY environment variable.\n' +
          'Get an API key at https://api.search.brave.com/',
        );
      }

      const count = Math.min(maxResults ?? DEFAULT_MAX_RESULTS, 20);
      const url = `${BRAVE_API_URL}?q=${encodeURIComponent(query)}&count=${count}`;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);

      try {
        const resp = await globalThis.fetch(url, {
          headers: {
            'Accept': 'application/json',
            'Accept-Encoding': 'gzip',
            'X-Subscription-Token': apiKey,
          },
          signal: controller.signal,
        });

        if (!resp.ok) {
          throw new Error(`Brave Search API returned ${resp.status}: ${resp.statusText}`);
        }

        const data: BraveSearchResponse = await resp.json();
        const results = data.web?.results ?? [];

        return results.slice(0, count).map((r): SearchResult => ({
          title: r.title,
          url: r.url,
          snippet: r.description,
          taint: taintTag(),
        }));
      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          throw new Error(`Search timeout after ${SEARCH_TIMEOUT_MS}ms`);
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
