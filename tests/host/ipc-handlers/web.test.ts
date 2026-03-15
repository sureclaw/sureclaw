// tests/host/ipc-handlers/web.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createWebHandlers } from '../../../src/host/ipc-handlers/web.js';
import type { IPCContext } from '../../../src/host/ipc-server.js';
import type { ProviderRegistry } from '../../../src/types.js';

function createSpyProviders() {
  const fetchCalls: any[] = [];
  return {
    providers: {
      audit: { log: vi.fn() },
      web: {
        async fetch(req: any) {
          fetchCalls.push(req);
          return { status: 200, headers: {}, body: 'ok', taint: {} };
        },
        async search() { return []; },
      },
    } as unknown as ProviderRegistry,
    fetchCalls,
  };
}

const ctx: IPCContext = { sessionId: 'test', agentId: 'system' };

describe('web IPC handlers', () => {
  it('passes url through when present', async () => {
    const { providers, fetchCalls } = createSpyProviders();
    const handlers = createWebHandlers(providers);
    await handlers.web_fetch({ url: 'https://example.com' }, ctx);
    expect(fetchCalls[0].url).toBe('https://example.com');
  });

  // Regression: Gemini Flash sends query instead of url for web fetch
  it('normalizes query to url when url is missing', async () => {
    const { providers, fetchCalls } = createSpyProviders();
    const handlers = createWebHandlers(providers);
    await handlers.web_fetch({ query: 'https://canopyworks.com' }, ctx);
    expect(fetchCalls[0].url).toBe('https://canopyworks.com');
  });

  it('prefers url over query when both present', async () => {
    const { providers, fetchCalls } = createSpyProviders();
    const handlers = createWebHandlers(providers);
    await handlers.web_fetch({ url: 'https://a.com', query: 'https://b.com' }, ctx);
    expect(fetchCalls[0].url).toBe('https://a.com');
  });
});
