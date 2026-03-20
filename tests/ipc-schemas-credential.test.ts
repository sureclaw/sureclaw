import { describe, it, expect } from 'vitest';
import { IPC_SCHEMAS } from '../src/ipc-schemas.js';

describe('credential_request IPC schema', () => {
  it('is registered in IPC_SCHEMAS', () => {
    expect(IPC_SCHEMAS).toHaveProperty('credential_request');
  });

  it('accepts valid credential request', () => {
    const schema = IPC_SCHEMAS['credential_request'];
    const result = schema.safeParse({
      action: 'credential_request',
      envName: 'LINEAR_API_KEY',
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing envName', () => {
    const schema = IPC_SCHEMAS['credential_request'];
    const result = schema.safeParse({ action: 'credential_request' });
    expect(result.success).toBe(false);
  });

  it('rejects extra fields (strict mode)', () => {
    const schema = IPC_SCHEMAS['credential_request'];
    const result = schema.safeParse({
      action: 'credential_request',
      envName: 'LINEAR_API_KEY',
      hackerField: 'surprise',
    });
    expect(result.success).toBe(false);
  });
});
