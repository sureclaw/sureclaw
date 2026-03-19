---
name: ax-provider-web
description: Use when modifying web access providers -- proxied HTTP fetch, DNS pinning, taint tagging, or web search in src/providers/web/
---

## Overview

Web providers handle HTTP fetch and web search for agents, with DNS pinning to prevent SSRF and automatic taint tagging on all responses. Agents have no direct network access -- all web requests route through the host via IPC.

## Interface (`src/providers/web/types.ts`)

| Type            | Key Fields                                            |
|-----------------|-------------------------------------------------------|
| `FetchRequest`  | `url`, `method?` (GET/HEAD), `headers?`, `timeoutMs?` |
| `FetchResponse` | `status`, `headers`, `body`, `taint: TaintTag`        |
| `SearchResult`  | `title`, `url`, `snippet`, `taint: TaintTag`          |
| `WebProvider`   | `fetch(req)`, `search(query, maxResults?)`             |

Every response carries a `TaintTag` with `trust: 'external'`.

## Implementations

| Name     | File                           | Purpose                                     |
|----------|--------------------------------|---------------------------------------------|
| `fetch`  | `src/providers/web/fetch.ts`   | Direct HTTP fetch with DNS pinning           |
| `tavily` | `src/providers/web/tavily.ts`  | Tavily SDK for web search and page extraction |
| `none`   | `src/providers/web/none.ts`    | Disabled stub (returns `disabledProvider()`)  |

All three are registered in `src/host/provider-map.ts` under the `web` kind.

## Fetch Provider (`fetch.ts`)

- **DNS pinning:** Resolves hostname once via `dns/promises.lookup`, checks the IP against private ranges (IPv4 + IPv6), then connects to the pinned IP directly. Prevents TOCTOU DNS rebinding.
- **Private IP blocking:** Rejects `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16` (cloud metadata), `0.0.0.0/8`, `::1`, `fe80:`, `fc/fd`.
- **Body size limit:** 1 MB max, streaming reader with truncation.
- **Timeout:** Default 10s, configurable via `timeoutMs`.
- **Protocol:** Only `http:` and `https:` allowed.
- **Search:** Not implemented -- throws with message to use `tavily`.
- **Testing:** `allowedIPs` option bypasses private-range blocking for tests.

## Tavily Provider (`tavily.ts`)

- Uses `@tavily/core` SDK. Requires `TAVILY_API_KEY` env var.
- **fetch():** Uses Tavily Extract API (returns markdown content).
- **search():** Uses Tavily Search API. Default 5 results, max 20.
- Both methods taint-tag results as `external`.

## Common Tasks

### Adding a new web provider

1. Create `src/providers/web/<name>.ts` implementing `WebProvider`.
2. Export `create(config: Config): Promise<WebProvider>`.
3. Add `<name>: '../providers/web/<name>.js'` to the `web` section in `src/host/provider-map.ts`.
4. Add tests in `tests/providers/web/<name>.test.ts`.

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

**MITM TLS flow:**
- Proxy generates self-signed root CA (persisted to `<agentDir>/ca/`)
- CONNECT requests: proxy terminates client TLS with a dynamically-generated domain cert, opens new TLS to target
- Decrypted traffic is scanned for credential placeholders (replaced) and canary tokens (blocked)
- Audit entries include `credentialInjected: true` when replacement occurs
- Domains in `config.mitm_bypass_domains` skip MITM (raw TCP tunnel for cert-pinning CLIs)
- CA trust: `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE` env vars set in sandbox

## Gotchas

- **All web responses are auto-tainted** with `trust: 'external'`. Never strip or skip the taint tag.
- **DNS pinning prevents SSRF.** The fetch provider resolves DNS once and connects to the pinned IP. Do not bypass this.
- **Agents have no direct network.** All web access routes through host-side IPC. The provider runs in the host process.
- **Tavily needs an API key** at runtime (`TAVILY_API_KEY`). The fetch provider needs no credentials.
- **`create()` is async** in all web providers (returns `Promise<WebProvider>`).
- **Credential placeholders use `ax-cred:` prefix.** Never log or expose real credential values — only placeholders should appear in agent-side logs.
- **MITM bypass list** (`config.mitm_bypass_domains`) is for cert-pinning CLIs only. Most HTTPS traffic should go through MITM for credential injection to work.
