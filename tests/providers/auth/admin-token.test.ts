import { describe, test, expect } from 'vitest';
import { create } from '../../../src/providers/auth/admin-token.js';
import type { Config } from '../../../src/types.js';
import type { IncomingMessage } from 'node:http';

function fakeReq(headers: Record<string, string> = {}): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

describe('auth/admin-token', () => {
  const config = { admin: { enabled: true, token: 'test-token-abc', port: 9090 } } as Config;

  test('returns null when no token header present', async () => {
    const provider = await create(config);
    const result = await provider.authenticate(fakeReq());
    expect(result).toBeNull();
  });

  test('authenticates valid bearer token', async () => {
    const provider = await create(config);
    const result = await provider.authenticate(fakeReq({ authorization: 'Bearer test-token-abc' }));
    expect(result).toEqual({
      authenticated: true,
      user: { id: 'admin-token', email: '', role: 'admin' },
    });
  });

  test('rejects invalid bearer token', async () => {
    const provider = await create(config);
    const result = await provider.authenticate(fakeReq({ authorization: 'Bearer wrong-token' }));
    expect(result).toEqual({ authenticated: false });
  });

  test('accepts X-Ax-Token header', async () => {
    const provider = await create(config);
    const result = await provider.authenticate(fakeReq({ 'x-ax-token': 'test-token-abc' }));
    expect(result).toEqual({
      authenticated: true,
      user: { id: 'admin-token', email: '', role: 'admin' },
    });
  });

  test('returns null when admin token not configured', async () => {
    const noTokenConfig = { admin: { enabled: true, port: 9090 } } as Config;
    const provider = await create(noTokenConfig);
    expect(await provider.authenticate(fakeReq())).toBeNull();
  });

  test('rejects any token when admin token not configured', async () => {
    const noTokenConfig = { admin: { enabled: true, port: 9090 } } as Config;
    const provider = await create(noTokenConfig);
    const result = await provider.authenticate(fakeReq({ authorization: 'Bearer anything' }));
    expect(result).toEqual({ authenticated: false });
  });
});
