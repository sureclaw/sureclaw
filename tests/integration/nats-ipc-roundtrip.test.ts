import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NATSIPCClient } from '../../src/agent/nats-ipc-client.js';
import { startNATSIPCHandler } from '../../src/host/nats-ipc-handler.js';

const NATS_URL = process.env.NATS_URL ?? 'nats://localhost:4222';
const TEST_REQUEST_ID = 'test-roundtrip-req';
const TEST_TOKEN = 'test-roundtrip-token';

describe('NATS IPC round-trip', () => {
  let handler: { close: () => void };
  let client: NATSIPCClient;
  let natsAvailable = false;

  beforeAll(async () => {
    // Check if NATS is available
    try {
      const nats = await import('nats');
      const nc = await nats.connect({ servers: NATS_URL, timeout: 2000 });
      await nc.drain();
      natsAvailable = true;
    } catch {
      console.log('NATS not available, skipping integration test');
      return;
    }

    // Start handler (host side) — uses token-scoped subjects
    handler = await startNATSIPCHandler({
      requestId: TEST_REQUEST_ID,
      token: TEST_TOKEN,
      handleIPC: async (raw: string) => {
        const req = JSON.parse(raw);
        if (req.action === 'sandbox_approve')
          return JSON.stringify({ approved: true });
        if (req.action === 'memory_search')
          return JSON.stringify({ ok: true, results: [{ text: 'hello' }] });
        return JSON.stringify({ ok: true });
      },
      ctx: { sessionId: 'test-session', agentId: 'system', userId: 'test-user' },
    });

    // Start client (pod side) — matches the token-scoped subject
    client = new NATSIPCClient({
      sessionId: 'test-session',
      requestId: TEST_REQUEST_ID,
      token: TEST_TOKEN,
    });
    await client.connect();
  });

  afterAll(async () => {
    if (client) await client.disconnect();
    if (handler) handler.close();
  });

  it('routes sandbox_approve through NATS', async () => {
    if (!natsAvailable) return;
    const result = await client.call({
      action: 'sandbox_approve',
      operation: 'bash',
      command: 'ls',
    });
    expect(result).toEqual({ approved: true });
  });

  it('routes memory_search through NATS', async () => {
    if (!natsAvailable) return;
    const result = await client.call({
      action: 'memory_search',
      query: 'test',
    });
    expect(result).toHaveProperty('results');
    expect((result as any).results).toHaveLength(1);
  });

  it('routes unknown action with default response', async () => {
    if (!natsAvailable) return;
    const result = await client.call({ action: 'some_other_action' });
    expect(result).toEqual({ ok: true });
  });
});
