import { describe, it, expect, beforeAll, afterAll } from 'vitest';

// Integration test — requires POSTGRESQL_URL env var
const PG_URL = process.env.POSTGRESQL_URL;

describe.skipIf(!PG_URL)('postgres eventbus', () => {
  let provider: any;

  beforeAll(async () => {
    const mod = await import('../../../src/providers/eventbus/postgres.js');
    provider = await mod.create({ providers: { database: 'postgresql' } } as any);
  });

  afterAll(() => { provider?.close(); });

  it('delivers events to global subscribers', async () => {
    const received: any[] = [];
    provider.subscribe((e: any) => received.push(e));
    await new Promise(r => setTimeout(r, 100));

    provider.emit({ type: 'test', requestId: 'req-1', timestamp: Date.now(), data: {} });
    await new Promise(r => setTimeout(r, 200));

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe('test');
  });

  it('delivers events to per-request subscribers', async () => {
    const received: any[] = [];
    provider.subscribeRequest('req-2', (e: any) => received.push(e));
    await new Promise(r => setTimeout(r, 100));

    provider.emit({ type: 'a', requestId: 'req-2', timestamp: Date.now(), data: {} });
    provider.emit({ type: 'b', requestId: 'req-other', timestamp: Date.now(), data: {} });
    await new Promise(r => setTimeout(r, 200));

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe('a');
  });

  it('unsubscribe stops delivery', async () => {
    const received: any[] = [];
    const unsub = provider.subscribe((e: any) => received.push(e));
    await new Promise(r => setTimeout(r, 100));
    unsub();

    provider.emit({ type: 'after-unsub', requestId: 'x', timestamp: Date.now(), data: {} });
    await new Promise(r => setTimeout(r, 200));

    expect(received).toHaveLength(0);
  });

  it('reports listener count', () => {
    const unsub = provider.subscribe(() => {});
    expect(provider.listenerCount()).toBeGreaterThanOrEqual(1);
    unsub();
  });
});
