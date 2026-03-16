import { describe, test, expect, vi, beforeEach } from 'vitest';

// Mock NATS message with reply support
interface MockMsg {
  data: Uint8Array;
  reply?: string;
  respond: ReturnType<typeof vi.fn>;
}

// Build an async-iterable subscription that we can push messages into
function createMockSubscription() {
  const messages: MockMsg[] = [];
  let resolver: ((value: IteratorResult<MockMsg>) => void) | null = null;
  let closed = false;

  const sub = {
    unsubscribe: vi.fn(() => { closed = true; if (resolver) resolver({ value: undefined as any, done: true }); }),
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<MockMsg>> {
          const msg = messages.shift();
          if (msg) return Promise.resolve({ value: msg, done: false });
          if (closed) return Promise.resolve({ value: undefined as any, done: true });
          return new Promise<IteratorResult<MockMsg>>((resolve) => { resolver = resolve; });
        },
      };
    },
    push(msg: MockMsg) {
      if (resolver) {
        const r = resolver;
        resolver = null;
        r({ value: msg, done: false });
      } else {
        messages.push(msg);
      }
    },
  };

  return sub;
}

// Create the NATS connection mock
function createMockNc(sub: ReturnType<typeof createMockSubscription>) {
  return {
    subscribe: vi.fn(() => sub),
    drain: vi.fn(async () => {}),
  };
}

// Mock the 'nats' module so dynamic import('nats') returns our mock
let mockSub: ReturnType<typeof createMockSubscription>;
let mockNc: ReturnType<typeof createMockNc>;

vi.mock('nats', () => {
  return {
    connect: vi.fn(async () => mockNc),
  };
});

beforeEach(() => {
  mockSub = createMockSubscription();
  mockNc = createMockNc(mockSub);
});

describe('nats-ipc-handler', () => {
  test('module exports startNATSIPCHandler function', async () => {
    const mod = await import('../../src/host/nats-ipc-handler.js');
    expect(typeof mod.startNATSIPCHandler).toBe('function');
  });

  test('subscribes to token-scoped ipc.request.{requestId}.{token}', async () => {
    const { startNATSIPCHandler } = await import('../../src/host/nats-ipc-handler.js');

    const handleIPC = vi.fn(async () => '{"ok":true}');

    const handler = await startNATSIPCHandler({
      requestId: 'req-123',
      token: 'tok-abc',
      handleIPC,
      ctx: { sessionId: 'sess-1', agentId: 'system', userId: 'user-1' },
    });

    expect(mockNc.subscribe).toHaveBeenCalledWith('ipc.request.req-123.tok-abc');

    handler.close();
  });

  test('close() unsubscribes and drains', async () => {
    const { startNATSIPCHandler } = await import('../../src/host/nats-ipc-handler.js');

    const handleIPC = vi.fn(async () => '{"ok":true}');

    const handler = await startNATSIPCHandler({
      requestId: 'req-drain',
      token: 'tok-drain',
      handleIPC,
      ctx: { sessionId: 'sess-drain', agentId: 'system', userId: 'default' },
    });

    handler.close();

    expect(mockSub.unsubscribe).toHaveBeenCalled();
    expect(mockNc.drain).toHaveBeenCalled();
  });

  test('routes IPC requests through handleIPC and responds', async () => {
    const { startNATSIPCHandler } = await import('../../src/host/nats-ipc-handler.js');

    const handleIPC = vi.fn(async (_raw: string, _ctx: any) => {
      return JSON.stringify({ ok: true, data: 'hello' });
    });

    const handler = await startNATSIPCHandler({
      requestId: 'req-route',
      token: 'tok-route',
      handleIPC,
      ctx: { sessionId: 'sess-route', agentId: 'system', userId: 'user-1' },
    });

    // Push a mock message
    const respond = vi.fn();
    const payload = JSON.stringify({ action: 'memory_write', content: 'test' });
    mockSub.push({
      data: new TextEncoder().encode(payload),
      reply: 'reply-subject',
      respond,
    });

    // Allow the async loop to process
    await new Promise((r) => setTimeout(r, 50));

    // Uses bound ctx, not payload fields
    expect(handleIPC).toHaveBeenCalledWith(payload, expect.objectContaining({
      sessionId: 'sess-route',
      agentId: 'system',
      userId: 'user-1',
    }));
    expect(respond).toHaveBeenCalled();

    // Verify the response was encoded correctly
    const responseData = respond.mock.calls[0][0];
    const decoded = JSON.parse(new TextDecoder().decode(responseData));
    expect(decoded).toEqual({ ok: true, data: 'hello' });

    handler.close();
  });

  test('uses bound context, ignores _sessionId/_userId from payload', async () => {
    const { startNATSIPCHandler } = await import('../../src/host/nats-ipc-handler.js');

    const handleIPC = vi.fn(async () => '{"ok":true}');

    const boundCtx = {
      sessionId: 'bound-session',
      agentId: 'bound-agent',
      userId: 'bound-user',
    };

    const handler = await startNATSIPCHandler({
      requestId: 'req-ctx',
      token: 'tok-ctx',
      handleIPC,
      ctx: boundCtx,
    });

    const respond = vi.fn();
    // Payload includes _sessionId/_userId that should be IGNORED
    const payload = JSON.stringify({
      action: 'memory_write',
      _sessionId: 'rogue-session',
      _agentId: 'custom-agent',
      _userId: 'rogue-user',
    });
    mockSub.push({
      data: new TextEncoder().encode(payload),
      reply: 'reply',
      respond,
    });

    await new Promise((r) => setTimeout(r, 50));

    // sessionId and userId come from bound context, NOT payload
    expect(handleIPC).toHaveBeenCalledWith(payload, {
      sessionId: 'bound-session',
      agentId: 'custom-agent',  // _agentId from payload IS trusted (our own sandbox)
      userId: 'bound-user',
    });

    handler.close();
  });

  test('responds with error on invalid JSON', async () => {
    const { startNATSIPCHandler } = await import('../../src/host/nats-ipc-handler.js');

    const handleIPC = vi.fn(async () => '{"ok":true}');

    const handler = await startNATSIPCHandler({
      requestId: 'req-bad-json',
      token: 'tok-bad',
      handleIPC,
      ctx: { sessionId: 'sess-bad', agentId: 'system', userId: 'default' },
    });

    const respond = vi.fn();
    mockSub.push({
      data: new TextEncoder().encode('not valid json {{{'),
      reply: 'reply',
      respond,
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(respond).toHaveBeenCalled();
    const responseData = respond.mock.calls[0][0];
    const decoded = JSON.parse(new TextDecoder().decode(responseData));
    expect(decoded.error).toBeDefined();

    handler.close();
  });

  test('responds with error when handleIPC throws', async () => {
    const { startNATSIPCHandler } = await import('../../src/host/nats-ipc-handler.js');

    const handleIPC = vi.fn(async () => {
      throw new Error('handler exploded');
    });

    const handler = await startNATSIPCHandler({
      requestId: 'req-throw',
      token: 'tok-throw',
      handleIPC,
      ctx: { sessionId: 'sess-throw', agentId: 'system', userId: 'default' },
    });

    const respond = vi.fn();
    const payload = JSON.stringify({ action: 'memory_write', content: 'boom' });
    mockSub.push({
      data: new TextEncoder().encode(payload),
      reply: 'reply',
      respond,
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(respond).toHaveBeenCalled();
    const responseData = respond.mock.calls[0][0];
    const decoded = JSON.parse(new TextDecoder().decode(responseData));
    expect(decoded.error).toBe('handler exploded');

    handler.close();
  });

  test('does not respond when msg has no reply subject', async () => {
    const { startNATSIPCHandler } = await import('../../src/host/nats-ipc-handler.js');

    const handleIPC = vi.fn(async () => '{"ok":true}');

    const handler = await startNATSIPCHandler({
      requestId: 'req-no-reply',
      token: 'tok-no-reply',
      handleIPC,
      ctx: { sessionId: 'sess-no-reply', agentId: 'system', userId: 'default' },
    });

    const respond = vi.fn();
    const payload = JSON.stringify({ action: 'memory_write', content: 'fire-and-forget' });
    mockSub.push({
      data: new TextEncoder().encode(payload),
      // No reply subject
      respond,
    });

    await new Promise((r) => setTimeout(r, 50));

    // handleIPC is called but respond is NOT called since there's no reply
    expect(handleIPC).toHaveBeenCalled();
    expect(respond).not.toHaveBeenCalled();

    handler.close();
  });

  test('connects to NATS with correct options', async () => {
    const natsModule = await import('nats');
    const { startNATSIPCHandler } = await import('../../src/host/nats-ipc-handler.js');

    const handleIPC = vi.fn(async () => '{"ok":true}');

    const handler = await startNATSIPCHandler({
      requestId: 'req-connect',
      token: 'tok-connect',
      handleIPC,
      ctx: { sessionId: 'sess-connect', agentId: 'system', userId: 'default' },
    });

    expect(natsModule.connect).toHaveBeenCalledWith(expect.objectContaining({
      name: 'ax-ipc-handler-req-connect',
      reconnect: true,
      maxReconnectAttempts: -1,
      reconnectTimeWait: 1000,
    }));

    handler.close();
  });
});
