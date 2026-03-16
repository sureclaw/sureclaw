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

  test('subscribes to ipc.request.{sessionId}', async () => {
    const { startNATSIPCHandler } = await import('../../src/host/nats-ipc-handler.js');

    const handleIPC = vi.fn(async () => '{"ok":true}');

    const handler = await startNATSIPCHandler({
      sessionId: 'test-session-123',
      natsUrl: 'nats://mock:4222',
      handleIPC,
    });

    expect(mockNc.subscribe).toHaveBeenCalledWith('ipc.request.test-session-123');

    handler.close();
  });

  test('close() unsubscribes and drains', async () => {
    const { startNATSIPCHandler } = await import('../../src/host/nats-ipc-handler.js');

    const handleIPC = vi.fn(async () => '{"ok":true}');

    const handler = await startNATSIPCHandler({
      sessionId: 'sess-drain',
      natsUrl: 'nats://mock:4222',
      handleIPC,
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
      sessionId: 'sess-route',
      natsUrl: 'nats://mock:4222',
      handleIPC,
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

    expect(handleIPC).toHaveBeenCalledWith(payload, expect.objectContaining({
      sessionId: 'sess-route',
      agentId: 'system',
      userId: 'default',
    }));
    expect(respond).toHaveBeenCalled();

    // Verify the response was encoded correctly
    const responseData = respond.mock.calls[0][0];
    const decoded = JSON.parse(new TextDecoder().decode(responseData));
    expect(decoded).toEqual({ ok: true, data: 'hello' });

    handler.close();
  });

  test('uses _sessionId/_agentId/_userId from request payload for context', async () => {
    const { startNATSIPCHandler } = await import('../../src/host/nats-ipc-handler.js');

    const handleIPC = vi.fn(async () => '{"ok":true}');

    const handler = await startNATSIPCHandler({
      sessionId: 'sess-ctx',
      natsUrl: 'nats://mock:4222',
      handleIPC,
    });

    const respond = vi.fn();
    const payload = JSON.stringify({
      action: 'memory_write',
      _sessionId: 'custom-session',
      _agentId: 'custom-agent',
      _userId: 'custom-user',
    });
    mockSub.push({
      data: new TextEncoder().encode(payload),
      reply: 'reply',
      respond,
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(handleIPC).toHaveBeenCalledWith(payload, {
      sessionId: 'custom-session',
      agentId: 'custom-agent',
      userId: 'custom-user',
    });

    handler.close();
  });

  test('responds with error on invalid JSON', async () => {
    const { startNATSIPCHandler } = await import('../../src/host/nats-ipc-handler.js');

    const handleIPC = vi.fn(async () => '{"ok":true}');

    const handler = await startNATSIPCHandler({
      sessionId: 'sess-bad-json',
      natsUrl: 'nats://mock:4222',
      handleIPC,
    });

    const respond = vi.fn();
    mockSub.push({
      data: new TextEncoder().encode('not valid json {{{'),
      reply: 'reply',
      respond,
    });

    await new Promise((r) => setTimeout(r, 50));

    // handleIPC should NOT have been called for invalid JSON
    // (JSON.parse will throw in the try block, caught by the outer catch)
    expect(respond).toHaveBeenCalled();
    const responseData = respond.mock.calls[0][0];
    const decoded = JSON.parse(new TextDecoder().decode(responseData));
    expect(decoded.error).toBeDefined();

    handler.close();
  });

  test('uses custom ctx when provided', async () => {
    const { startNATSIPCHandler } = await import('../../src/host/nats-ipc-handler.js');

    const handleIPC = vi.fn(async () => '{"ok":true}');

    const customCtx = {
      sessionId: 'override-session',
      agentId: 'override-agent',
      userId: 'override-user',
    };

    const handler = await startNATSIPCHandler({
      sessionId: 'sess-custom-ctx',
      natsUrl: 'nats://mock:4222',
      handleIPC,
      ctx: customCtx,
    });

    const respond = vi.fn();
    // Payload without _sessionId/_agentId/_userId — should use custom ctx defaults
    const payload = JSON.stringify({ action: 'web_fetch', url: 'https://example.com' });
    mockSub.push({
      data: new TextEncoder().encode(payload),
      reply: 'reply',
      respond,
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(handleIPC).toHaveBeenCalledWith(payload, {
      sessionId: 'override-session',
      agentId: 'override-agent',
      userId: 'override-user',
    });

    handler.close();
  });

  test('responds with error when handleIPC throws', async () => {
    const { startNATSIPCHandler } = await import('../../src/host/nats-ipc-handler.js');

    const handleIPC = vi.fn(async () => {
      throw new Error('handler exploded');
    });

    const handler = await startNATSIPCHandler({
      sessionId: 'sess-throw',
      natsUrl: 'nats://mock:4222',
      handleIPC,
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
      sessionId: 'sess-no-reply',
      natsUrl: 'nats://mock:4222',
      handleIPC,
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
      sessionId: 'sess-connect',
      natsUrl: 'nats://custom:4222',
      handleIPC,
    });

    expect(natsModule.connect).toHaveBeenCalledWith(expect.objectContaining({
      servers: 'nats://custom:4222',
      name: 'ax-ipc-handler-sess-connect',
      reconnect: true,
      maxReconnectAttempts: -1,
      reconnectTimeWait: 1000,
    }));

    handler.close();
  });
});
