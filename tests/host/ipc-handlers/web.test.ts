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

  it('web_fetch prefers url over query when both present', async () => {
    const { providers, fetchCalls } = createSpyProviders();
    const handlers = createWebHandlers(providers);
    await handlers.web_fetch({ url: 'https://a.com', query: 'https://b.com' }, ctx);
    expect(fetchCalls[0].url).toBe('https://a.com');
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
