// tests/cli/chat.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createChatClient } from '../../src/cli/chat.js';

describe('createChatClient', () => {
  it('should create a client with start method', () => {
    const client = createChatClient({ fetch: vi.fn() as any });
    expect(client).toHaveProperty('start');
    expect(typeof client.start).toBe('function');
  });

  it('should create client with custom socket path', () => {
    const client = createChatClient({
      socketPath: '/tmp/custom.sock',
      fetch: vi.fn() as any,
    });
    expect(client).toBeDefined();
  });

  it('should create client with noStream option', () => {
    const client = createChatClient({
      noStream: true,
      fetch: vi.fn() as any,
    });
    expect(client).toBeDefined();
  });
});
