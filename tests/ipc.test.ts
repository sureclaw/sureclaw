import { describe, test, expect, beforeEach } from 'vitest';
import { createIPCHandler, type IPCContext } from '../src/ipc.js';
import type { ProviderRegistry } from '../src/providers/types.js';

const ctx: IPCContext = { sessionId: 'test-session', agentId: 'test-agent' };

// Minimal mock registry with just enough to test dispatch
function mockRegistry(): ProviderRegistry {
  return {
    llm: {
      name: 'mock',
      async *chat() { yield { type: 'text', content: 'Hello' }; yield { type: 'done', usage: { inputTokens: 10, outputTokens: 5 } }; },
      async models() { return ['mock-model']; },
    },
    memory: {
      async write(entry) { return 'mock-id-00000000-0000-0000-0000-000000000000'; },
      async query() { return []; },
      async read() { return null; },
      async delete() {},
      async list() { return []; },
    },
    scanner: {
      canaryToken() { return 'CANARY-test'; },
      checkCanary() { return false; },
      async scanInput() { return { verdict: 'PASS' as const }; },
      async scanOutput() { return { verdict: 'PASS' as const }; },
    },
    channels: [],
    web: {
      async fetch() { throw new Error('Provider disabled (provider: none)'); },
      async search() { throw new Error('Provider disabled (provider: none)'); },
    },
    browser: {
      async launch() { throw new Error('Provider disabled (provider: none)'); },
      async navigate() { throw new Error('Provider disabled (provider: none)'); },
      async snapshot() { throw new Error('Provider disabled (provider: none)'); },
      async click() { throw new Error('Provider disabled (provider: none)'); },
      async type() { throw new Error('Provider disabled (provider: none)'); },
      async screenshot() { throw new Error('Provider disabled (provider: none)'); },
      async close() { throw new Error('Provider disabled (provider: none)'); },
    },
    credentials: {
      async get() { return null; },
      async set() {},
      async delete() {},
      async list() { return []; },
    },
    skills: {
      async list() { return []; },
      async read() { return ''; },
      async propose() { throw new Error('read-only'); },
      async approve() {},
      async reject() {},
      async revert() {},
      async log() { return []; },
    },
    audit: {
      async log() {},
      async query() { return []; },
    },
    sandbox: {
      async spawn() { throw new Error('not implemented'); },
      async kill() {},
      async isAvailable() { return false; },
    },
    scheduler: {
      async start() {},
      async stop() {},
    },
  } as ProviderRegistry;
}

describe('IPC Handler', () => {
  let handle: (raw: string, ctx: IPCContext) => Promise<string>;

  beforeEach(() => {
    handle = createIPCHandler(mockRegistry());
  });

  test('rejects invalid JSON', async () => {
    const result = JSON.parse(await handle('not json', ctx));
    expect(result.ok).toBe(false);
    expect(result.error).toBe('Invalid JSON');
  });

  test('rejects unknown action', async () => {
    const result = JSON.parse(await handle('{"action":"evil"}', ctx));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Unknown');
  });

  test('rejects invalid payload for known action', async () => {
    const result = JSON.parse(await handle('{"action":"llm_call"}', ctx));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Validation failed');
  });

  test('dispatches valid llm_call', async () => {
    const payload = JSON.stringify({
      action: 'llm_call',
      messages: [{ role: 'user', content: 'hello' }],
    });
    const result = JSON.parse(await handle(payload, ctx));
    expect(result.ok).toBe(true);
    expect(result.chunks).toBeDefined();
    expect(result.chunks.length).toBe(2);
  });

  test('dispatches valid memory_query', async () => {
    const payload = JSON.stringify({
      action: 'memory_query',
      scope: 'user_alice',
    });
    const result = JSON.parse(await handle(payload, ctx));
    expect(result.ok).toBe(true);
    expect(result.results).toEqual([]);
  });

  test('dispatches valid skill_list', async () => {
    const payload = JSON.stringify({ action: 'skill_list' });
    const result = JSON.parse(await handle(payload, ctx));
    expect(result.ok).toBe(true);
    expect(result.skills).toEqual([]);
  });

  test('dispatches valid audit_query', async () => {
    const payload = JSON.stringify({ action: 'audit_query' });
    const result = JSON.parse(await handle(payload, ctx));
    expect(result.ok).toBe(true);
  });

  test('returns handler error for disabled provider', async () => {
    const payload = JSON.stringify({
      action: 'web_fetch',
      url: 'https://example.com',
    });
    const result = JSON.parse(await handle(payload, ctx));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Provider disabled');
  });

  test('rejects extra fields (strict mode)', async () => {
    const payload = JSON.stringify({
      action: 'skill_list',
      evil: 'injected',
    });
    const result = JSON.parse(await handle(payload, ctx));
    expect(result.ok).toBe(false);
  });

  test('rejects null bytes', async () => {
    const payload = JSON.stringify({
      action: 'memory_query',
      scope: 'user\0evil',
    });
    const result = JSON.parse(await handle(payload, ctx));
    expect(result.ok).toBe(false);
  });
});
