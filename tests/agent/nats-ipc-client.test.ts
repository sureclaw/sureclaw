import { describe, test, expect, vi, beforeEach } from 'vitest';
import { initLogger } from '../../src/logger.js';

// Silence logger in tests
initLogger({ level: 'silent', file: false });

// ─── NATS mock ──────────────────────────────────────────
// We mock the 'nats' module so no real NATS connection is needed.

const mockRequest = vi.fn();
const mockDrain = vi.fn().mockResolvedValue(undefined);
const mockConnect = vi.fn().mockResolvedValue({
  request: mockRequest,
  drain: mockDrain,
});

vi.mock('nats', () => ({
  connect: mockConnect,
}));

// ─── Helpers ────────────────────────────────────────────

function encode(obj: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj));
}

function makeNatsResponse(obj: Record<string, unknown>) {
  return { data: encode(obj) };
}

// ─── Tests ──────────────────────────────────────────────

describe('NATSIPCClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-apply default mock after clear
    mockConnect.mockResolvedValue({
      request: mockRequest,
      drain: mockDrain,
    });
    // Clear AX_IPC_TOKEN env to avoid leaking between tests
    delete process.env.AX_IPC_TOKEN;
  });

  test('module exports NATSIPCClient class', async () => {
    const mod = await import('../../src/agent/nats-ipc-client.js');
    expect(typeof mod.NATSIPCClient).toBe('function');
  });

  test('call() sends via NATS request/reply and returns the response', async () => {
    const { NATSIPCClient } = await import('../../src/agent/nats-ipc-client.js');

    mockRequest.mockResolvedValueOnce(makeNatsResponse({ ok: true, echo: 'skill_list' }));

    const client = new NATSIPCClient({ sessionId: 'sess-1' });
    const result = await client.call({ action: 'skill_list' });

    expect(result.ok).toBe(true);
    expect(result.echo).toBe('skill_list');

    // Verify NATS request was called on the correct subject (fallback without token)
    expect(mockRequest).toHaveBeenCalledTimes(1);
    const [subject, payload, opts] = mockRequest.mock.calls[0];
    expect(subject).toBe('ipc.request.sess-1');
    expect(opts.timeout).toBe(30_000);

    // Verify the payload contains the action
    const sent = JSON.parse(new TextDecoder().decode(payload));
    expect(sent.action).toBe('skill_list');

    await client.disconnect();
  });

  test('uses token-scoped subject when token and requestId are provided', async () => {
    const { NATSIPCClient } = await import('../../src/agent/nats-ipc-client.js');

    mockRequest.mockResolvedValueOnce(makeNatsResponse({ ok: true }));

    const client = new NATSIPCClient({
      sessionId: 'sess-1',
      requestId: 'req-42',
      token: 'tok-secret',
    });
    await client.call({ action: 'test' });

    const [subject] = mockRequest.mock.calls[0];
    expect(subject).toBe('ipc.request.req-42.tok-secret');

    await client.disconnect();
  });

  test('reads AX_IPC_TOKEN from env when token not passed in options', async () => {
    process.env.AX_IPC_TOKEN = 'env-token-123';

    const { NATSIPCClient } = await import('../../src/agent/nats-ipc-client.js');

    mockRequest.mockResolvedValueOnce(makeNatsResponse({ ok: true }));

    const client = new NATSIPCClient({
      sessionId: 'sess-env',
      requestId: 'req-env',
    });
    await client.call({ action: 'test' });

    const [subject] = mockRequest.mock.calls[0];
    expect(subject).toBe('ipc.request.req-env.env-token-123');

    await client.disconnect();
  });

  test('falls back to session-scoped subject when no token', async () => {
    const { NATSIPCClient } = await import('../../src/agent/nats-ipc-client.js');

    mockRequest.mockResolvedValueOnce(makeNatsResponse({ ok: true }));

    const client = new NATSIPCClient({ sessionId: 'my-pod-session' });
    await client.call({ action: 'web_search' });

    const [subject] = mockRequest.mock.calls[0];
    expect(subject).toBe('ipc.request.my-pod-session');

    await client.disconnect();
  });

  test('requests are enriched with _sessionId, _requestId, _userId, _sessionScope', async () => {
    const { NATSIPCClient } = await import('../../src/agent/nats-ipc-client.js');

    mockRequest.mockResolvedValueOnce(makeNatsResponse({ ok: true }));

    const client = new NATSIPCClient({
      sessionId: 'sess-42',
      requestId: 'req-7',
      userId: 'alice',
      sessionScope: 'dm',
    });

    await client.call({ action: 'memory_recall', query: 'hello' });

    const [, payload] = mockRequest.mock.calls[0];
    const sent = JSON.parse(new TextDecoder().decode(payload));

    expect(sent._sessionId).toBe('sess-42');
    expect(sent._requestId).toBe('req-7');
    expect(sent._userId).toBe('alice');
    expect(sent._sessionScope).toBe('dm');
    expect(sent.action).toBe('memory_recall');
    expect(sent.query).toBe('hello');

    await client.disconnect();
  });

  test('setContext() updates the session ID and subject', async () => {
    const { NATSIPCClient } = await import('../../src/agent/nats-ipc-client.js');

    mockRequest
      .mockResolvedValueOnce(makeNatsResponse({ ok: true, phase: 'before' }))
      .mockResolvedValueOnce(makeNatsResponse({ ok: true, phase: 'after' }));

    const client = new NATSIPCClient({ sessionId: 'old-session' });
    await client.call({ action: 'test1' });

    // Verify initial subject (fallback — no token)
    expect(mockRequest.mock.calls[0][0]).toBe('ipc.request.old-session');

    // Update context
    client.setContext({
      sessionId: 'new-session',
      requestId: 'req-99',
      userId: 'bob',
      sessionScope: 'channel',
    });

    await client.call({ action: 'test2' });

    // Still fallback (no token set) — uses session-scoped
    expect(mockRequest.mock.calls[1][0]).toBe('ipc.request.new-session');

    // Verify enriched fields use new context
    const sent = JSON.parse(new TextDecoder().decode(mockRequest.mock.calls[1][1]));
    expect(sent._sessionId).toBe('new-session');
    expect(sent._requestId).toBe('req-99');
    expect(sent._userId).toBe('bob');
    expect(sent._sessionScope).toBe('channel');

    await client.disconnect();
  });

  test('NATS timeouts propagate as errors', async () => {
    const { NATSIPCClient } = await import('../../src/agent/nats-ipc-client.js');

    mockRequest.mockRejectedValueOnce(new Error('TIMEOUT: request timed out'));

    const client = new NATSIPCClient({ sessionId: 'sess-timeout', timeoutMs: 500 });

    await expect(client.call({ action: 'slow_action' })).rejects.toThrow('TIMEOUT');

    await client.disconnect();
  });

  test('custom call timeout overrides default', async () => {
    const { NATSIPCClient } = await import('../../src/agent/nats-ipc-client.js');

    mockRequest.mockResolvedValueOnce(makeNatsResponse({ ok: true }));

    const client = new NATSIPCClient({ sessionId: 'sess-custom', timeoutMs: 30_000 });
    await client.call({ action: 'test' }, 5_000);

    const [, , opts] = mockRequest.mock.calls[0];
    expect(opts.timeout).toBe(5_000);

    await client.disconnect();
  });

  test('connect() is idempotent — second call is a no-op', async () => {
    const { NATSIPCClient } = await import('../../src/agent/nats-ipc-client.js');

    const client = new NATSIPCClient({ sessionId: 'sess-idem' });
    await client.connect();
    await client.connect();

    // nats.connect should only be called once
    expect(mockConnect).toHaveBeenCalledTimes(1);

    await client.disconnect();
  });

  test('disconnect() drains the NATS connection', async () => {
    const { NATSIPCClient } = await import('../../src/agent/nats-ipc-client.js');

    const client = new NATSIPCClient({ sessionId: 'sess-drain' });
    await client.connect();
    await client.disconnect();

    expect(mockDrain).toHaveBeenCalledTimes(1);
  });

  test('disconnect() is safe to call when not connected', async () => {
    const { NATSIPCClient } = await import('../../src/agent/nats-ipc-client.js');

    const client = new NATSIPCClient({ sessionId: 'sess-no-conn' });
    // Should not throw
    await client.disconnect();

    expect(mockDrain).not.toHaveBeenCalled();
  });

  test('call() auto-connects if not connected', async () => {
    const { NATSIPCClient } = await import('../../src/agent/nats-ipc-client.js');

    mockRequest.mockResolvedValueOnce(makeNatsResponse({ ok: true }));

    const client = new NATSIPCClient({ sessionId: 'sess-auto' });
    // Don't call connect() explicitly — call() should do it
    await client.call({ action: 'test' });

    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(mockRequest).toHaveBeenCalledTimes(1);

    await client.disconnect();
  });

  test('optional context fields are omitted when not set', async () => {
    const { NATSIPCClient } = await import('../../src/agent/nats-ipc-client.js');

    mockRequest.mockResolvedValueOnce(makeNatsResponse({ ok: true }));

    // Create with only sessionId — no requestId, userId, sessionScope
    const client = new NATSIPCClient({ sessionId: 'sess-minimal' });
    await client.call({ action: 'test' });

    const sent = JSON.parse(new TextDecoder().decode(mockRequest.mock.calls[0][1]));
    expect(sent._sessionId).toBe('sess-minimal');
    expect(sent).not.toHaveProperty('_requestId');
    expect(sent).not.toHaveProperty('_userId');
    expect(sent).not.toHaveProperty('_sessionScope');

    await client.disconnect();
  });
});
