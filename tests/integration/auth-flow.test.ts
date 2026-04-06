/**
 * Auth integration tests.
 *
 * These tests exercise the full authenticateRequest middleware chain
 * with real provider instances (not mocks). They verify that the
 * provider chain correctly delegates, short-circuits, and falls through
 * as expected.
 */

import { describe, test, expect } from 'vitest';
import { create as createAdminToken } from '../../src/providers/auth/admin-token.js';
import { authenticateRequest } from '../../src/host/server-request-handlers.js';
import type { IncomingMessage } from 'node:http';
import type { Config } from '../../src/types.js';

function fakeReq(headers: Record<string, string> = {}): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

describe('auth integration', () => {
  test('admin-token provider authenticates valid token in chain', async () => {
    const config = { admin: { enabled: true, token: 'secret', port: 9090 } } as Config;
    const adminToken = await createAdminToken(config);

    const result = await authenticateRequest(
      fakeReq({ authorization: 'Bearer secret' }),
      [adminToken],
    );
    expect(result.authenticated).toBe(true);
    expect(result.user?.role).toBe('admin');
  });

  test('unauthenticated request falls through all providers', async () => {
    const config = { admin: { enabled: true, token: 'secret', port: 9090 } } as Config;
    const adminToken = await createAdminToken(config);

    const result = await authenticateRequest(fakeReq(), [adminToken]);
    expect(result.authenticated).toBe(false);
  });

  test('invalid token is rejected (not passed to next provider)', async () => {
    const config = { admin: { enabled: true, token: 'secret', port: 9090 } } as Config;
    const adminToken = await createAdminToken(config);

    const result = await authenticateRequest(
      fakeReq({ authorization: 'Bearer wrong' }),
      [adminToken],
    );
    expect(result.authenticated).toBe(false);
  });

  test('multiple providers: first match wins', async () => {
    const config1 = { admin: { enabled: true, token: 'token-a', port: 9090 } } as Config;
    const config2 = { admin: { enabled: true, token: 'token-b', port: 9090 } } as Config;
    const provider1 = await createAdminToken(config1);
    const provider2 = await createAdminToken(config2);

    // token-a matches first provider
    const result = await authenticateRequest(
      fakeReq({ authorization: 'Bearer token-a' }),
      [provider1, provider2],
    );
    expect(result.authenticated).toBe(true);
  });

  test('empty provider list means unauthenticated', async () => {
    const result = await authenticateRequest(fakeReq({ authorization: 'Bearer anything' }), []);
    expect(result.authenticated).toBe(false);
  });
});
