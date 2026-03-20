# Web Provider Split Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Split the monolithic `WebProvider` into three distinct operations — raw fetch (hardcoded), configurable text extraction, and configurable web search — with independent provider selection for extract and search.

**Architecture:** Two new provider categories (`web_extract`, `web_search`) in the provider map, a hardcoded raw fetch from `fetch.ts`, and a third `extract` variant on the agent-facing `web` tool. Config changes from `web: 'tavily'` to `web: { extract: 'tavily', search: 'brave' }`.

**Tech Stack:** TypeScript, Zod (IPC schemas), TypeBox (tool catalog), Vitest (tests)

**Design doc:** `docs/plans/2026-03-20-web-provider-split-design.md`

---

## Task 1: New type interfaces

**Files:**
- Modify: `src/providers/web/types.ts`

**Step 1: Write the failing test**

Create `tests/providers/web/types.test.ts`:

```typescript
import { describe, it, expectTypeOf } from 'vitest';
import type { WebExtractProvider, WebSearchProvider, FetchRequest, FetchResponse, ExtractResult, SearchResult } from '../../../src/providers/web/types.js';

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
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/providers/web/types.test.ts`
Expected: FAIL — `WebExtractProvider`, `WebSearchProvider`, `ExtractResult` not exported

**Step 3: Implement the types**

In `src/providers/web/types.ts`, keep existing `FetchRequest`, `FetchResponse`, `SearchResult`. Add:

```typescript
export interface ExtractResult {
  url: string;
  content: string;
  taint: TaintTag;
}

export interface WebExtractProvider {
  extract(url: string): Promise<ExtractResult>;
}

export interface WebSearchProvider {
  search(query: string, maxResults?: number): Promise<SearchResult[]>;
}
```

Remove the old `WebProvider` interface (it will be replaced by direct use of these + the raw fetch type).

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/providers/web/types.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/providers/web/types.ts tests/providers/web/types.test.ts
git commit -m "feat(web): add WebExtractProvider and WebSearchProvider interfaces"
```

---

## Task 2: Tavily Extract provider

**Files:**
- Create: `src/providers/web/tavily-extract.ts`
- Create: `tests/providers/web/tavily-extract.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/providers/web/tavily-extract.test.ts
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
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/providers/web/tavily-extract.test.ts`
Expected: FAIL — module not found

**Step 3: Implement tavily-extract.ts**

```typescript
// src/providers/web/tavily-extract.ts
import { tavily } from '@tavily/core';
import type { WebExtractProvider, ExtractResult } from './types.js';
import type { Config, TaintTag } from '../../types.js';

function taintTag(): TaintTag {
  return { source: 'web_extract', trust: 'external', timestamp: new Date() };
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

export async function create(_config: Config): Promise<WebExtractProvider> {
  return {
    async extract(url: string): Promise<ExtractResult> {
      const apiKey = requireApiKey();
      const client = tavily({ apiKey });
      const response = await client.extract([url], {
        extractDepth: 'basic',
        format: 'markdown',
      });

      if (response.failedResults?.length && !response.results?.length) {
        const err = response.failedResults[0];
        throw new Error(err.error || 'Extraction failed');
      }

      const result = response.results?.[0];
      return {
        url,
        content: result?.rawContent ?? '',
        taint: taintTag(),
      };
    },
  };
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/providers/web/tavily-extract.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/providers/web/tavily-extract.ts tests/providers/web/tavily-extract.test.ts
git commit -m "feat(web): add tavily extract provider"
```

---

## Task 3: Tavily Search provider

**Files:**
- Create: `src/providers/web/tavily-search.ts`
- Create: `tests/providers/web/tavily-search.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/providers/web/tavily-search.test.ts
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
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/providers/web/tavily-search.test.ts`
Expected: FAIL — module not found

**Step 3: Implement tavily-search.ts**

```typescript
// src/providers/web/tavily-search.ts
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
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/providers/web/tavily-search.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/providers/web/tavily-search.ts tests/providers/web/tavily-search.test.ts
git commit -m "feat(web): add tavily search provider"
```

---

## Task 4: Brave Search provider

**Files:**
- Create: `src/providers/web/brave-search.ts`
- Create: `tests/providers/web/brave-search.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/providers/web/brave-search.test.ts
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
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/providers/web/brave-search.test.ts`
Expected: FAIL — module not found

**Step 3: Implement brave-search.ts**

```typescript
// src/providers/web/brave-search.ts
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
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/providers/web/brave-search.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/providers/web/brave-search.ts tests/providers/web/brave-search.test.ts
git commit -m "feat(web): add brave search provider"
```

---

## Task 5: None stubs for extract and search

**Files:**
- Create: `src/providers/web/none-extract.ts`
- Create: `src/providers/web/none-search.ts`

**Step 1: Write the failing test**

```typescript
// tests/providers/web/none-stubs.test.ts
import { describe, test, expect } from 'vitest';
import type { Config } from '../../../src/types.js';

const config = {} as unknown as Config;

describe('none-extract', () => {
  test('extract() throws disabled error', async () => {
    const { create } = await import('../../../src/providers/web/none-extract.js');
    const provider = await create(config);
    await expect(provider.extract('https://example.com')).rejects.toThrow('disabled');
  });
});

describe('none-search', () => {
  test('search() throws disabled error', async () => {
    const { create } = await import('../../../src/providers/web/none-search.js');
    const provider = await create(config);
    await expect(provider.search('test')).rejects.toThrow('disabled');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/providers/web/none-stubs.test.ts`
Expected: FAIL — modules not found

**Step 3: Implement both stubs**

```typescript
// src/providers/web/none-extract.ts
import type { WebExtractProvider } from './types.js';
import type { Config } from '../../types.js';
import { disabledProvider } from '../../utils/disabled-provider.js';

export async function create(_config: Config): Promise<WebExtractProvider> {
  return disabledProvider<WebExtractProvider>();
}
```

```typescript
// src/providers/web/none-search.ts
import type { WebSearchProvider } from './types.js';
import type { Config } from '../../types.js';
import { disabledProvider } from '../../utils/disabled-provider.js';

export async function create(_config: Config): Promise<WebSearchProvider> {
  return disabledProvider<WebSearchProvider>();
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/providers/web/none-stubs.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/providers/web/none-extract.ts src/providers/web/none-search.ts tests/providers/web/none-stubs.test.ts
git commit -m "feat(web): add disabled stubs for extract and search"
```

---

## Task 6: Update provider map and config types

**Files:**
- Modify: `src/host/provider-map.ts` (lines 44-48, 114)
- Modify: `src/types.ts` (lines 79, 167)
- Modify: `src/config.ts` (line 47)

**Step 1: Update provider map**

In `src/host/provider-map.ts`, replace the `web` entry (lines 44-48):

```typescript
  // Old:
  // web: {
  //   none:   '../providers/web/none.js',
  //   fetch:  '../providers/web/fetch.js',
  //   tavily: '../providers/web/tavily.js',
  // },

  // New:
  web_extract: {
    none:   '../providers/web/none-extract.js',
    tavily: '../providers/web/tavily-extract.js',
  },
  web_search: {
    none:   '../providers/web/none-search.js',
    tavily: '../providers/web/tavily-search.js',
    brave:  '../providers/web/brave-search.js',
  },
```

Update the type export (line 114):
```typescript
// Remove:
// export type WebProviderName = keyof ProviderMapType['web'];

// Add:
export type WebExtractProviderName = keyof ProviderMapType['web_extract'];
export type WebSearchProviderName  = keyof ProviderMapType['web_search'];
```

**Step 2: Update Config type**

In `src/types.ts`, change line 79:
```typescript
// Old:
// web: WebProviderName;

// New:
web: {
  extract: WebExtractProviderName;
  search: WebSearchProviderName;
};
```

Update the imports at the top of `src/types.ts` to import the new type names instead of `WebProviderName`.

Update `ProviderRegistry` (lines 167):
```typescript
// Old:
// web: WebProvider;

// New:
webFetch: { fetch(req: FetchRequest): Promise<FetchResponse> };
webExtract: WebExtractProvider;
webSearch: WebSearchProvider;
```

Add imports for `WebExtractProvider`, `WebSearchProvider`, `FetchRequest`, `FetchResponse` from `./providers/web/types.js`.

**Step 3: Update config schema**

In `src/config.ts`, change line 47:
```typescript
// Old:
// web: providerEnum('web'),

// New:
web: z.strictObject({
  extract: providerEnum('web_extract'),
  search: providerEnum('web_search'),
}),
```

**Step 4: Run type check**

Run: `npx tsc --noEmit 2>&1 | head -50`
Expected: Type errors in files that still reference old `providers.web` / `WebProviderName` / `providers.web.fetch` / `providers.web.search`. This is expected — we'll fix those in subsequent tasks.

**Step 5: Commit**

```bash
git add src/host/provider-map.ts src/types.ts src/config.ts
git commit -m "feat(web): update config, types, and provider map for extract/search split"
```

---

## Task 7: Update provider registry loading

**Files:**
- Modify: `src/host/registry.ts` (line 116)
- Modify: `src/providers/web/fetch.ts` (remove `search()`, update return type)

**Step 1: Update fetch.ts**

In `src/providers/web/fetch.ts`:
- Change the import to use `FetchRequest`, `FetchResponse` instead of `WebProvider`
- Change the return type of `create()` from `Promise<WebProvider>` to `Promise<{ fetch(req: FetchRequest): Promise<FetchResponse> }>`
- Remove the `search()` stub method

**Step 2: Update registry.ts**

In `src/host/registry.ts`, change line 116:
```typescript
// Old:
// web: await loadProvider('web', config.providers.web, config),

// New:
webFetch:   await (await import('../providers/web/fetch.js')).create(config),
webExtract: await loadProvider('web_extract', config.providers.web.extract, config),
webSearch:  await loadProvider('web_search', config.providers.web.search, config),
```

**Step 3: Run type check to see remaining errors**

Run: `npx tsc --noEmit 2>&1 | head -50`

**Step 4: Commit**

```bash
git add src/host/registry.ts src/providers/web/fetch.ts
git commit -m "feat(web): update registry loading for split web providers"
```

---

## Task 8: Update IPC schema and handler

**Files:**
- Modify: `src/ipc-schemas.ts` (add `WebExtractSchema`)
- Modify: `src/host/ipc-handlers/web.ts`

**Step 1: Write the failing test**

Update `tests/host/ipc-handlers/web.test.ts`:

```typescript
// tests/host/ipc-handlers/web.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createWebHandlers } from '../../../src/host/ipc-handlers/web.js';
import type { IPCContext } from '../../../src/host/ipc-server.js';
import type { ProviderRegistry } from '../../../src/types.js';

function createSpyProviders() {
  const fetchCalls: any[] = [];
  const extractCalls: string[] = [];
  return {
    providers: {
      audit: { log: vi.fn() },
      webFetch: {
        async fetch(req: any) {
          fetchCalls.push(req);
          return { status: 200, headers: {}, body: 'ok', taint: {} };
        },
      },
      webExtract: {
        async extract(url: string) {
          extractCalls.push(url);
          return { url, content: 'extracted text', taint: {} };
        },
      },
      webSearch: {
        async search() { return []; },
      },
    } as unknown as ProviderRegistry,
    fetchCalls,
    extractCalls,
  };
}

const ctx: IPCContext = { sessionId: 'test', agentId: 'system' };

describe('web IPC handlers', () => {
  it('web_fetch passes url through', async () => {
    const { providers, fetchCalls } = createSpyProviders();
    const handlers = createWebHandlers(providers);
    await handlers.web_fetch({ url: 'https://example.com' }, ctx);
    expect(fetchCalls[0].url).toBe('https://example.com');
  });

  it('web_fetch normalizes query to url', async () => {
    const { providers, fetchCalls } = createSpyProviders();
    const handlers = createWebHandlers(providers);
    await handlers.web_fetch({ query: 'https://canopyworks.com' }, ctx);
    expect(fetchCalls[0].url).toBe('https://canopyworks.com');
  });

  it('web_extract calls extract provider', async () => {
    const { providers, extractCalls } = createSpyProviders();
    const handlers = createWebHandlers(providers);
    const result = await handlers.web_extract({ url: 'https://example.com' }, ctx);
    expect(extractCalls[0]).toBe('https://example.com');
    expect(result.content).toBe('extracted text');
  });

  it('web_search calls search provider', async () => {
    const { providers } = createSpyProviders();
    const handlers = createWebHandlers(providers);
    const result = await handlers.web_search({ query: 'test' }, ctx);
    expect(result).toEqual([]);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/host/ipc-handlers/web.test.ts`
Expected: FAIL — `web_extract` handler doesn't exist, spy structure doesn't match

**Step 3: Add IPC schema**

In `src/ipc-schemas.ts`, after line 117 (after `WebSearchSchema`), add:

```typescript
export const WebExtractSchema = ipcAction('web_extract', {
  url: z.url().max(2048),
});
```

**Step 4: Update IPC handler**

Replace `src/host/ipc-handlers/web.ts`:

```typescript
import type { ProviderRegistry } from '../../types.js';
import type { IPCContext } from '../ipc-server.js';

export function createWebHandlers(providers: ProviderRegistry) {
  return {
    web_fetch: async (req: any, ctx: IPCContext) => {
      const url = req.url ?? req.query;
      await providers.audit.log({ action: 'web_fetch', sessionId: ctx.sessionId, args: { url } });
      return await providers.webFetch.fetch({ ...req, url });
    },

    web_extract: async (req: any, ctx: IPCContext) => {
      await providers.audit.log({ action: 'web_extract', sessionId: ctx.sessionId, args: { url: req.url } });
      return await providers.webExtract.extract(req.url);
    },

    web_search: async (req: any, ctx: IPCContext) => {
      await providers.audit.log({ action: 'web_search', sessionId: ctx.sessionId, args: { query: req.query } });
      return await providers.webSearch.search(req.query, req.maxResults);
    },
  };
}
```

**Step 5: Run test to verify it passes**

Run: `npx vitest run tests/host/ipc-handlers/web.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add src/ipc-schemas.ts src/host/ipc-handlers/web.ts tests/host/ipc-handlers/web.test.ts
git commit -m "feat(web): add web_extract IPC schema and update handlers"
```

---

## Task 9: Update tool catalog

**Files:**
- Modify: `src/agent/tool-catalog.ts` (lines 87-115)

**Step 1: Update the web tool definition**

Replace the web tool entry (lines 87-115) with:

```typescript
  // ── Web ──
  {
    name: 'web',
    label: 'Web',
    description:
      'Retrieve web content.\n\n' +
      'Use `type: "fetch"` to get the raw HTTP response body (HTML, JSON, etc.) — best for APIs or when you need exact response content.\n' +
      'Use `type: "extract"` to get cleaned, readable text from a webpage — best for articles and page content.\n' +
      'Use `type: "search"` to find information on the web when you don\'t have a specific URL.\n' +
      'Never put a URL in `query`.',
    parameters: Type.Union([
      Type.Object({
        type: Type.Literal('fetch'),
        url: Type.String(),
        method: Type.Optional(Type.Union([Type.Literal('GET'), Type.Literal('HEAD')])),
        headers: Type.Optional(Type.Record(Type.String(), Type.String())),
        timeoutMs: Type.Optional(Type.Number()),
      }),
      Type.Object({
        type: Type.Literal('extract'),
        url: Type.String(),
      }),
      Type.Object({
        type: Type.Literal('search'),
        query: Type.String(),
        maxResults: Type.Optional(Type.Number()),
      }),
    ]),
    category: 'web',
    actionMap: {
      fetch: 'web_fetch',
      extract: 'web_extract',
      search: 'web_search',
    },
  },
```

**Step 2: Run type check**

Run: `npx tsc --noEmit 2>&1 | head -30`
Expected: Fewer errors (may still have some in other files referencing old types)

**Step 3: Commit**

```bash
git add src/agent/tool-catalog.ts
git commit -m "feat(web): add extract variant to web tool catalog"
```

---

## Task 10: Update onboarding defaults and remaining references

**Files:**
- Modify: `src/onboarding/prompts.ts`
- Search and fix any remaining references to old `WebProviderName` or `providers.web` as a string

**Step 1: Update onboarding profile defaults**

In `src/onboarding/prompts.ts`, change the `web` field in each profile:

```typescript
// paranoid:
web: { extract: 'none', search: 'none' },

// balanced:
web: { extract: 'none', search: 'none' },

// yolo:
web: { extract: 'none', search: 'none' },
```

Note: We default to `none` for now since tavily/brave require API keys. Users can configure them during onboarding or in config.

Update `PROVIDER_CHOICES` (line 174):
```typescript
// Old:
// web: ['none', 'fetch'],

// New:
web_extract: ['none', 'tavily'],
web_search: ['none', 'tavily', 'brave'],
```

**Step 2: Find and fix remaining references**

Run: `npx tsc --noEmit 2>&1`

Fix all remaining type errors. Common ones:
- `WebProviderName` → `WebExtractProviderName` / `WebSearchProviderName`
- `providers.web` as string → `providers.web.extract` / `providers.web.search`
- `registry.web.fetch(...)` → `registry.webFetch.fetch(...)`
- `registry.web.search(...)` → `registry.webSearch.search(...)`

Check these files for references:
- Any test files that mock `ProviderRegistry`
- `src/host/ipc-server.ts` (should be fine, uses `createWebHandlers`)
- Config validation/loading in `src/config.ts`

**Step 3: Run full type check and test suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: All pass

**Step 4: Commit**

```bash
git add -A
git commit -m "feat(web): update onboarding defaults and fix remaining references"
```

---

## Task 11: Delete old files

**Files:**
- Delete: `src/providers/web/tavily.ts`
- Delete: `src/providers/web/none.ts`
- Delete: `tests/providers/web/tavily.test.ts`

**Step 1: Delete the files**

```bash
git rm src/providers/web/tavily.ts src/providers/web/none.ts tests/providers/web/tavily.test.ts
```

**Step 2: Run full test suite**

Run: `npx vitest run`
Expected: All pass (no remaining imports of deleted files)

**Step 3: Commit**

```bash
git commit -m "refactor(web): remove old monolithic tavily and none providers"
```

---

## Task 12: Update skill and documentation

**Files:**
- Modify: `.claude/skills/ax-provider-web/skill.md`
- Verify: `docs/plans/2026-03-20-web-provider-split-design.md` is up to date

**Step 1: Update the ax-provider-web skill**

Update the skill to reflect the new architecture:
- Two provider categories: `web_extract` and `web_search`
- Built-in fetch (always loaded, not configurable)
- New file paths for all providers
- Updated interfaces (`WebExtractProvider`, `WebSearchProvider`)
- Updated config shape

**Step 2: Update journal and lessons**

Per the journal protocol, append entries to appropriate files.

**Step 3: Commit**

```bash
git add .claude/skills/ax-provider-web/skill.md .claude/journal/ .claude/lessons/
git commit -m "docs: update web provider skill and journal for extract/search split"
```

---

## Task 13: Final verification

**Step 1: Run full build**

Run: `npm run build`
Expected: Clean compilation

**Step 2: Run full test suite**

Run: `npm test`
Expected: All tests pass

**Step 3: Verify no dangling references to old types**

Run: `grep -r 'WebProviderName\b' src/ --include='*.ts'`
Run: `grep -r "providers\.web'" src/ --include='*.ts'`
Expected: No matches (only the new nested form `providers.web.extract` / `providers.web.search`)
