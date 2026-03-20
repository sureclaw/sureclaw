import { describe, it, expectTypeOf } from 'vitest';
import type { WebExtractProvider, WebSearchProvider, ExtractResult, SearchResult } from '../../../src/providers/web/types.js';

describe('web provider types', () => {
  it('WebExtractProvider has extract method', () => {
    expectTypeOf<WebExtractProvider['extract']>().toBeFunction();
    expectTypeOf<WebExtractProvider['extract']>().parameter(0).toBeString();
    expectTypeOf<WebExtractProvider['extract']>().returns.resolves.toMatchTypeOf<ExtractResult>();
  });

  it('WebSearchProvider has search method', () => {
    expectTypeOf<WebSearchProvider['search']>().toBeFunction();
    expectTypeOf<WebSearchProvider['search']>().parameter(0).toBeString();
    expectTypeOf<WebSearchProvider['search']>().returns.resolves.toMatchTypeOf<SearchResult[]>();
  });

  it('ExtractResult has required fields', () => {
    expectTypeOf<ExtractResult>().toHaveProperty('url');
    expectTypeOf<ExtractResult>().toHaveProperty('content');
    expectTypeOf<ExtractResult>().toHaveProperty('taint');
  });
});
