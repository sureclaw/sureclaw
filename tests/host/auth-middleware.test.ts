// tests/host/auth-middleware.test.ts
import { describe, test, expect } from 'vitest';
import type { IncomingMessage } from 'node:http';
import type { AuthProvider, AuthResult } from '../../src/providers/auth/types.js';
import { authenticateRequest } from '../../src/host/server-request-handlers.js';

function fakeReq(headers: Record<string, string> = {}): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

function mockProvider(fn: (req: IncomingMessage) => Promise<AuthResult | null>): AuthProvider {
  return { authenticate: fn };
}

describe('authenticateRequest', () => {
  test('returns authenticated:false when no providers match', async () => {
    const provider = mockProvider(async () => null);
    const result = await authenticateRequest(fakeReq(), [provider]);
    expect(result).toEqual({ authenticated: false });
  });

  test('returns first non-null result from provider chain', async () => {
    const skip = mockProvider(async () => null);
    const match = mockProvider(async () => ({
      authenticated: true,
      user: { id: '1', email: 'a@b.com', role: 'admin' as const },
    }));
    const result = await authenticateRequest(fakeReq(), [skip, match]);
    expect(result.authenticated).toBe(true);
    expect(result.user?.email).toBe('a@b.com');
  });

  test('stops at first non-null result (does not call later providers)', async () => {
    let called = false;
    const first = mockProvider(async () => ({ authenticated: false }));
    const second = mockProvider(async () => { called = true; return null; });
    await authenticateRequest(fakeReq(), [first, second]);
    expect(called).toBe(false);
  });

  test('returns authenticated:false for empty provider list', async () => {
    const result = await authenticateRequest(fakeReq(), []);
    expect(result).toEqual({ authenticated: false });
  });
});
