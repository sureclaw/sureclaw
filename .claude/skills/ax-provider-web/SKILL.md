---
name: ax-provider-web
description: Use when modifying web access providers -- proxied HTTP fetch, DNS pinning, taint tagging, text extraction, or web search in src/providers/web/
---

## Overview

Web functionality is split into three independent operations:

1. **Raw fetch** — always loaded, hardcoded (not configurable). DNS-pinned HTTP client with SSRF protection.
2. **Extract** — configurable via `config.providers.web.extract`. Pulls cleaned text from web pages.
3. **Search** — configurable via `config.providers.web.search`. Web search queries.

Agents have no direct network access — all web requests route through the host via IPC.

## Interfaces (`src/providers/web/types.ts`)

| Type                  | Key Fields                                            |
|-----------------------|-------------------------------------------------------|
| `FetchRequest`        | `url`, `method?` (GET/HEAD), `headers?`, `timeoutMs?` |
| `FetchResponse`       | `status`, `headers`, `body`, `taint: TaintTag`        |
| `ExtractResult`       | `url`, `content`, `taint: TaintTag`                   |
| `SearchResult`        | `title`, `url`, `snippet`, `taint: TaintTag`          |
| `WebExtractProvider`  | `extract(url): Promise<ExtractResult>`                |
| `WebSearchProvider`   | `search(query, maxResults?): Promise<SearchResult[]>` |

Every response carries a `TaintTag` with `trust: 'external'`.

## Config Shape

```yaml
providers:
  web:
    extract: none    # or 'tavily'
    search: none     # or 'tavily' or 'brave'
```

Two provider categories in the provider map: `web_extract` and `web_search`.

## Implementations

### Fetch (always loaded)

| File                          | Purpose                                      |
|-------------------------------|----------------------------------------------|
| `src/providers/web/fetch.ts`  | Direct HTTP fetch with DNS pinning (hardcoded)|

### Extract Providers (`web_extract`)

| Name     | File                                  | Purpose                              |
|----------|---------------------------------------|--------------------------------------|
| `tavily` | `src/providers/web/tavily-extract.ts` | Tavily Extract API (markdown output) |
| `none`   | `src/providers/web/none-extract.ts`   | Disabled stub                        |

### Search Providers (`web_search`)

| Name     | File                                 | Purpose                              |
|----------|--------------------------------------|--------------------------------------|
| `tavily` | `src/providers/web/tavily-search.ts` | Tavily Search API                    |
| `brave`  | `src/providers/web/brave-search.ts`  | Brave Search API                     |
| `none`   | `src/providers/web/none-search.ts`   | Disabled stub                        |

All registered in `src/host/provider-map.ts` under `web_extract` and `web_search` kinds.

## ProviderRegistry Fields

```typescript
webFetch:   { fetch(req: FetchRequest): Promise<FetchResponse> };  // always loaded
webExtract: WebExtractProvider;  // from web_extract provider
webSearch:  WebSearchProvider;   // from web_search provider
```

## IPC Actions

| Action        | Schema                  | Handler                           |
|---------------|-------------------------|-----------------------------------|
| `web_fetch`   | `WebFetchSchema`        | Routes to `webFetch.fetch()`      |
| `web_extract` | `WebExtractSchema`      | Routes to `webExtract.extract()`  |
| `web_search`  | `WebSearchSchema`       | Routes to `webSearch.search()`    |

## Tool Catalog

The `web` tool has three variants via `type` discriminator:
- `type: "fetch"` → `web_fetch` IPC action
- `type: "extract"` → `web_extract` IPC action
- `type: "search"` → `web_search` IPC action

## Fetch Provider (`fetch.ts`)

- **DNS pinning:** Resolves hostname once via `dns/promises.lookup`, checks the IP against private ranges (IPv4 + IPv6), then connects to the pinned IP directly. Prevents TOCTOU DNS rebinding.
- **Private IP blocking:** Rejects `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16` (cloud metadata), `0.0.0.0/8`, `::1`, `fe80:`, `fc/fd`.
- **Body size limit:** 1 MB max, streaming reader with truncation.
- **Timeout:** Default 10s, configurable via `timeoutMs`.
- **Protocol:** Only `http:` and `https:` allowed.
- **Testing:** `allowedIPs` option bypasses private-range blocking for tests.

## Common Tasks

### Adding a new extract provider

1. Create `src/providers/web/<name>-extract.ts` implementing `WebExtractProvider`.
2. Export `create(config: Config): Promise<WebExtractProvider>`.
3. Add `<name>: '../providers/web/<name>-extract.js'` to `web_extract` in `src/host/provider-map.ts`.
4. Add tests in `tests/providers/web/<name>-extract.test.ts`.

### Adding a new search provider

1. Create `src/providers/web/<name>-search.ts` implementing `WebSearchProvider`.
2. Export `create(config: Config): Promise<WebSearchProvider>`.
3. Add `<name>: '../providers/web/<name>-search.js'` to `web_search` in `src/host/provider-map.ts`.
4. Add tests in `tests/providers/web/<name>-search.test.ts`.

## Web Proxy — MITM Credential Injection

When skills declare `requires.env` in their frontmatter (e.g., `LINEAR_API_KEY`), the host builds a `CredentialPlaceholderMap` at sandbox launch:

1. Skills' `requires.env` are collected by scanning skill files in agent + user workspace
2. For each env var, the host looks up the real value in `CredentialProvider`
3. Opaque placeholder tokens (`ax-cred:<hex>`) replace real values
4. Placeholders are injected as env vars into the sandbox
5. The web proxy's MITM mode replaces placeholders with real values in intercepted HTTPS traffic

**Key files:**
- `src/host/proxy-ca.ts` — CA certificate generation and domain cert signing
- `src/host/credential-placeholders.ts` — Placeholder token management
- `src/host/web-proxy.ts` — MITM TLS inspection in `handleMITMConnect()`
- `src/host/server-completions.ts` — Wiring: skill env collection, credential map build, CA trust injection
- `src/host/credential-prompts.ts` — Interactive credential prompting registry (request/resolve/cleanup)

## Gotchas

- **All web responses are auto-tainted** with `trust: 'external'`. Never strip or skip the taint tag.
- **DNS pinning prevents SSRF.** The fetch provider resolves DNS once and connects to the pinned IP. Do not bypass this.
- **Agents have no direct network.** All web access routes through host-side IPC. The provider runs in the host process.
- **Tavily and Brave need API keys** at runtime (`TAVILY_API_KEY`, `BRAVE_API_KEY`). The fetch provider needs no credentials.
- **`create()` is async** in all web providers.
- **Config is nested:** `config.providers.web.extract` and `config.providers.web.search`, not `config.providers.web` as a string.
- **Credential placeholders use `ax-cred:` prefix.** Never log or expose real credential values — only placeholders should appear in agent-side logs.
- **MITM bypass list** (`config.mitm_bypass_domains`) is for cert-pinning CLIs only. Most HTTPS traffic should go through MITM for credential injection to work.
