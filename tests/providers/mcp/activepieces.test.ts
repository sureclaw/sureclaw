import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CircuitBreaker, create } from '../../../src/providers/mcp/activepieces.js';
import { McpAuthRequiredError } from '../../../src/providers/mcp/types.js';
import type { Config } from '../../../src/types.js';

// ---------------------------------------------------------------------------
// Circuit Breaker (exported class — tested directly)
// ---------------------------------------------------------------------------

describe('CircuitBreaker', () => {
  it('starts closed', () => {
    const cb = new CircuitBreaker(3, 1000);
    expect(cb.isOpen).toBe(false);
  });

  it('stays closed below threshold', () => {
    const cb = new CircuitBreaker(3, 1000);
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.isOpen).toBe(false);
  });

  it('opens after threshold failures', () => {
    const cb = new CircuitBreaker(3, 1000);
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.isOpen).toBe(true);
  });

  it('resets after cooldown', () => {
    const cb = new CircuitBreaker(2, 100);
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.isOpen).toBe(true);

    // Advance time past cooldown
    vi.useFakeTimers();
    vi.advanceTimersByTime(101);
    expect(cb.isOpen).toBe(false);
    vi.useRealTimers();
  });

  it('reset() clears failures', () => {
    const cb = new CircuitBreaker(2, 1000);
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.isOpen).toBe(true);
    cb.reset();
    expect(cb.isOpen).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Activepieces provider (with mocked fetch)
// ---------------------------------------------------------------------------

const stubConfig = {
  mcp: {
    url: 'http://ap.test:8080',
    healthcheck_interval_ms: 0, // disable health check timer in tests
    circuit_breaker: { failure_threshold: 3, cooldown_ms: 5000 },
    timeout_ms: 5000,
  },
} as unknown as Config;

describe('ActivepiecesMcpProvider', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockFetch(handler: (url: string, init?: RequestInit) => Promise<Response>) {
    globalThis.fetch = handler as typeof fetch;
  }

  function jsonResponse(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  it('create() returns a provider', async () => {
    mockFetch(async () => jsonResponse({ status: 'ok' }));
    const provider = await create(stubConfig);
    expect(provider).toBeDefined();
    expect(typeof provider.listTools).toBe('function');
    expect(typeof provider.callTool).toBe('function');
    expect(typeof provider.credentialStatus).toBe('function');
    expect(typeof provider.storeCredential).toBe('function');
    expect(typeof provider.listApps).toBe('function');
  });

  it('listTools sends filter params', async () => {
    let capturedUrl = '';
    mockFetch(async (url) => {
      capturedUrl = url;
      return jsonResponse([{ name: 'linear_get_issues', description: 'Get issues', inputSchema: {} }]);
    });

    const provider = await create(stubConfig);
    const tools = await provider.listTools({ apps: ['linear', 'gmail'] });

    expect(capturedUrl).toContain('/api/v1/mcp/tools');
    expect(capturedUrl).toContain('apps=linear%2Cgmail');
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('linear_get_issues');
  });

  it('callTool returns tainted result', async () => {
    mockFetch(async () => jsonResponse({ content: 'issue data', isError: false }));

    const provider = await create(stubConfig);
    const result = await provider.callTool({
      tool: 'linear_get_issues',
      arguments: { query: 'test' },
      agentId: 'agent-1',
      userId: 'user-1',
      sessionId: 'sess-1',
    });

    expect(result.content).toBe('issue data');
    expect(result.isError).toBe(false);
    expect(result.taint.trust).toBe('external');
    expect(result.taint.source).toBe('mcp:linear_get_issues');
  });

  it('callTool throws McpAuthRequiredError when auth needed', async () => {
    mockFetch(async () => jsonResponse({
      content: '',
      authRequired: { available: false, app: 'linear', authType: 'api_key' },
    }));

    const provider = await create(stubConfig);
    await expect(provider.callTool({
      tool: 'linear_get_issues',
      arguments: {},
      agentId: 'agent-1',
      userId: 'user-1',
      sessionId: 'sess-1',
    })).rejects.toThrow(McpAuthRequiredError);
  });

  it('circuit breaker opens after consecutive failures', async () => {
    let callCount = 0;
    mockFetch(async () => {
      callCount++;
      return new Response('Service unavailable', { status: 503 });
    });

    const provider = await create(stubConfig);

    // Fail 3 times (threshold)
    for (let i = 0; i < 3; i++) {
      await expect(provider.listTools()).rejects.toThrow();
    }

    // 4th call should fail with circuit breaker message, NOT hitting the server
    const prevCount = callCount;
    await expect(provider.listTools()).rejects.toThrow(/circuit breaker/i);
    expect(callCount).toBe(prevCount); // no new fetch call
  });

  it('circuit breaker resets on success', async () => {
    let shouldFail = true;
    mockFetch(async () => {
      if (shouldFail) return new Response('fail', { status: 500 });
      return jsonResponse([]);
    });

    const provider = await create(stubConfig);

    // 2 failures (below threshold of 3)
    await expect(provider.listTools()).rejects.toThrow();
    await expect(provider.listTools()).rejects.toThrow();

    // Success resets the counter
    shouldFail = false;
    const tools = await provider.listTools();
    expect(tools).toEqual([]);

    // Now we can fail again without the circuit opening after just 1 failure
    shouldFail = true;
    await expect(provider.listTools()).rejects.toThrow();
    // Circuit should still be closed (only 1 failure since reset)
    shouldFail = false;
    const tools2 = await provider.listTools();
    expect(tools2).toEqual([]);
  });

  it('credentialStatus calls correct endpoint', async () => {
    let capturedUrl = '';
    mockFetch(async (url) => {
      capturedUrl = url;
      return jsonResponse({ available: true, app: 'linear', authType: 'api_key' });
    });

    const provider = await create(stubConfig);
    const status = await provider.credentialStatus('agent-1', 'linear');

    expect(capturedUrl).toContain('/api/v1/mcp/credentials/status');
    expect(capturedUrl).toContain('agentId=agent-1');
    expect(capturedUrl).toContain('app=linear');
    expect(status.available).toBe(true);
  });

  it('storeCredential sends POST', async () => {
    let capturedBody: unknown;
    mockFetch(async (_url, init) => {
      capturedBody = JSON.parse(init?.body as string);
      return jsonResponse({ ok: true });
    });

    const provider = await create(stubConfig);
    await provider.storeCredential('agent-1', 'linear', 'sk-test');

    expect(capturedBody).toEqual({ agentId: 'agent-1', app: 'linear', value: 'sk-test' });
  });

  it('listApps returns app list', async () => {
    const apps = [{ name: 'linear', description: 'Project management', authType: 'api_key' }];
    mockFetch(async () => jsonResponse(apps));

    const provider = await create(stubConfig);
    const result = await provider.listApps();
    expect(result).toEqual(apps);
  });
});

// ---------------------------------------------------------------------------
// None provider
// ---------------------------------------------------------------------------

describe('McpProvider (none)', () => {
  it('all methods throw "Provider disabled"', async () => {
    const { create: createNone } = await import('../../../src/providers/mcp/none.js');
    const provider = await createNone({} as Config);
    // disabledProvider returns sync functions that throw immediately
    expect(() => provider.listTools()).toThrow(/disabled/i);
    expect(() => provider.callTool({} as never)).toThrow(/disabled/i);
    expect(() => provider.credentialStatus('a', 'b')).toThrow(/disabled/i);
    expect(() => provider.storeCredential('a', 'b', 'c')).toThrow(/disabled/i);
    expect(() => provider.listApps()).toThrow(/disabled/i);
  });
});

// ---------------------------------------------------------------------------
// McpAuthRequiredError
// ---------------------------------------------------------------------------

describe('McpAuthRequiredError', () => {
  it('has correct name and status', () => {
    const status = { available: false, app: 'gmail', authType: 'oauth' as const };
    const err = new McpAuthRequiredError(status);
    expect(err.name).toBe('McpAuthRequiredError');
    expect(err.message).toContain('gmail');
    expect(err.status).toBe(status);
  });
});
