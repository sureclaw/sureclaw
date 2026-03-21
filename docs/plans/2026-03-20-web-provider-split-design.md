# Web Provider Split Design

**Date:** 2026-03-20
**Status:** Approved

## Problem

The current web provider design is confusing:

- `WebProvider` bundles `fetch()` and `search()` into one interface, but no single implementation does both well
- `fetch.ts` throws "not implemented" on `search()`
- `tavily.ts` does smart text extraction (not raw HTTP) in its `fetch()`, making the behavior wildly different depending on which provider is selected
- You can't mix providers — e.g., raw HTTP fetch + Brave search

## Design

Split into three agent-facing operations backed by two configurable provider categories plus one hardcoded provider.

### Config

```yaml
providers:
  web:
    extract: tavily     # 'tavily' | 'none'
    search: brave       # 'tavily' | 'brave' | 'none'
```

Raw HTTP fetch is always the built-in `fetch.ts` — not configurable, not in the provider map.

### Agent-Facing Operations

The agent sees a single `web` tool with a `type` discriminator:

| Operation | IPC Action | Provider Source | Purpose |
|-----------|-----------|----------------|---------|
| `type: 'fetch'` | `web_fetch` | Built-in `fetch.ts` (always loaded) | Raw HTTP response body |
| `type: 'extract'` | `web_extract` | `config.providers.web.extract` | Clean text extraction from a URL |
| `type: 'search'` | `web_search` | `config.providers.web.search` | Web search results |

### Interfaces

```typescript
// src/providers/web/types.ts

// Existing — unchanged
interface FetchRequest { url, method?, headers?, timeoutMs? }
interface FetchResponse { status, headers, body, taint }

// New — extract provider
interface ExtractResult {
  url: string;
  content: string;       // cleaned text/markdown
  taint: TaintTag;
}
interface WebExtractProvider {
  extract(url: string): Promise<ExtractResult>;
}

// New — search provider
interface SearchResult { title, url, snippet, taint }  // unchanged
interface WebSearchProvider {
  search(query: string, maxResults?: number): Promise<SearchResult[]>;
}
```

### Provider Map

```typescript
// src/host/provider-map.ts
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

The old `web` entry is removed. `fetch.ts` is instantiated directly during provider loading.

### ProviderRegistry

```typescript
webExtract: WebExtractProvider;
webSearch: WebSearchProvider;
web: { fetch(req: FetchRequest): Promise<FetchResponse> };  // always fetch.ts
```

### IPC

New schema:
```typescript
export const WebExtractSchema = ipcAction('web_extract', {
  url: z.url().max(2048),
});
```

Existing `WebFetchSchema` and `WebSearchSchema` unchanged.

### IPC Handler

```typescript
// src/host/ipc-handlers/web.ts
web_fetch: async (req, ctx) => {
  await providers.audit.log({ action: 'web_fetch', ... });
  return await providers.web.fetch(req);
},
web_extract: async (req, ctx) => {
  await providers.audit.log({ action: 'web_extract', ... });
  return await providers.webExtract.extract(req.url);
},
web_search: async (req, ctx) => {
  await providers.audit.log({ action: 'web_search', ... });
  return await providers.webSearch.search(req.query, req.maxResults);
},
```

### Tool Catalog

Single `web` tool, three variants:
```typescript
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
actionMap: {
  fetch: 'web_fetch',
  extract: 'web_extract',
  search: 'web_search',
},
```

Tool description guidance:
- `fetch` — raw HTTP response (HTML, JSON, etc.). Use for APIs or when you need the exact response body.
- `extract` — cleaned, readable text from a webpage. Use when you want the content of an article or page.
- `search` — web search. Use when you need to find information and don't have a specific URL.

## File Changes

### Create
- `src/providers/web/tavily-extract.ts` — Tavily Extract API, exports `WebExtractProvider`
- `src/providers/web/tavily-search.ts` — Tavily Search API, exports `WebSearchProvider`
- `src/providers/web/brave-search.ts` — Brave Search API, exports `WebSearchProvider`
- `src/providers/web/none-extract.ts` — disabled stub
- `src/providers/web/none-search.ts` — disabled stub

### Modify
- `src/providers/web/types.ts` — new interfaces
- `src/providers/web/fetch.ts` — remove dead `search()` method
- `src/types.ts` — config shape, registry fields
- `src/host/provider-map.ts` — remove `web`, add `web_extract` + `web_search`
- `src/host/ipc-handlers/web.ts` — add `web_extract` handler, update registry references
- `src/host/ipc-server.ts` — wire new handler (if needed)
- `src/ipc-schemas.ts` — add `WebExtractSchema`
- `src/agent/tool-catalog.ts` — add `extract` variant
- Provider loading code — hardcode `fetch.ts` instantiation, load `web_extract`/`web_search` from map

### Delete
- `src/providers/web/tavily.ts` — replaced by split files
- `src/providers/web/none.ts` — replaced by split files

### Tests
- Create `tests/providers/web/tavily-extract.test.ts`
- Create `tests/providers/web/tavily-search.test.ts`
- Create `tests/providers/web/brave-search.test.ts`
- Update `tests/host/ipc-handlers/web.test.ts`
- Update any tests referencing old `WebProvider` interface
