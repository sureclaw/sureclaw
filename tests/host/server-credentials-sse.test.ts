import { describe, test, expect } from 'vitest';

describe('credential.required SSE event', () => {
  test('sendSSENamedEvent emits named SSE event format', async () => {
    const { sendSSENamedEvent } = await import('../../src/host/server-http.js');

    // Mock ServerResponse
    const chunks: string[] = [];
    const mockRes = {
      write: (data: string) => { chunks.push(data); return true; },
    };

    sendSSENamedEvent(mockRes as any, 'credential_required', {
      envName: 'LINEAR_API_KEY',
      sessionId: 'sess-1',
    });

    expect(chunks.length).toBe(1);
    // Named SSE event format: "event: <name>\ndata: <json>\n\n"
    expect(chunks[0]).toContain('event: credential_required\n');
    expect(chunks[0]).toContain('"envName":"LINEAR_API_KEY"');
    expect(chunks[0]).toContain('\n\n');
  });

  test('sendSSENamedEvent emits oauth_required event format', async () => {
    const { sendSSENamedEvent } = await import('../../src/host/server-http.js');

    const chunks: string[] = [];
    const mockRes = {
      write: (data: string) => { chunks.push(data); return true; },
    };

    sendSSENamedEvent(mockRes as any, 'oauth_required', {
      envName: 'LINEAR_API_KEY',
      sessionId: 'sess-1',
      authorizeUrl: 'https://linear.app/oauth/authorize?client_id=abc&state=xyz',
    });

    expect(chunks.length).toBe(1);
    expect(chunks[0]).toContain('event: oauth_required\n');
    expect(chunks[0]).toContain('"envName":"LINEAR_API_KEY"');
    expect(chunks[0]).toContain('"authorizeUrl"');
    expect(chunks[0]).toContain('\n\n');
  });
});
