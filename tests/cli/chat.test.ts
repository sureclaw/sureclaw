// tests/cli/chat.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createChatClient } from '../../src/cli/chat.js';
import { Readable, Writable } from 'node:stream';

describe('Chat Client', () => {
  let mockStdin: Readable;
  let mockStdout: Writable;
  let stdoutData: string[];

  beforeEach(() => {
    mockStdin = new Readable({
      read() {},
    });
    mockStdout = new Writable({
      write(chunk, _encoding, callback) {
        stdoutData.push(chunk.toString());
        callback();
      },
    });
    stdoutData = [];
  });

  it('should send message and receive response', async () => {
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/health')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ status: 'ok' }) });
      }
      return Promise.resolve({
        ok: true,
        body: createMockSSEStream('Hello, user!'),
      });
    });

    const client = createChatClient({
      socketPath: '/tmp/test.sock',
      stdin: mockStdin,
      stdout: mockStdout,
      fetch: mockFetch as any,
    });

    const clientPromise = client.start();

    // Simulate user input
    mockStdin.push('Hello\n');
    mockStdin.push(null); // EOF

    await clientPromise;

    // Health check + 1 chat request
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const output = stdoutData.join('');
    expect(output).toContain('Connected');
    expect(output).toContain('Hello, user!');
  });

  it('should accumulate conversation history', async () => {
    let chatCallCount = 0;
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/health')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ status: 'ok' }) });
      }
      chatCallCount++;
      return Promise.resolve({
        ok: true,
        body: createMockSSEStream(`Response ${chatCallCount}`),
      });
    });

    const client = createChatClient({
      socketPath: '/tmp/test.sock',
      stdin: mockStdin,
      stdout: mockStdout,
      fetch: mockFetch as any,
    });

    const clientPromise = client.start();

    mockStdin.push('First message\n');
    // Need to wait for the first message to be processed before sending second
    await new Promise(resolve => setTimeout(resolve, 50));
    mockStdin.push('Second message\n');
    await new Promise(resolve => setTimeout(resolve, 50));
    mockStdin.push(null);

    await clientPromise;

    // Health check + 2 chat requests
    expect(mockFetch).toHaveBeenCalledTimes(3);

    // Second chat call (index 2, after health check at 0) should include history
    const secondCall = mockFetch.mock.calls[2][1];
    const body = JSON.parse(secondCall.body);
    // Should have: user1, assistant1, user2
    expect(body.messages.length).toBe(3);
  });

  it('should include consistent session_id in every request', async () => {
    let chatCallCount = 0;
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/health')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ status: 'ok' }) });
      }
      chatCallCount++;
      return Promise.resolve({
        ok: true,
        body: createMockSSEStream(`Response ${chatCallCount}`),
      });
    });

    const client = createChatClient({
      socketPath: '/tmp/test.sock',
      stdin: mockStdin,
      stdout: mockStdout,
      fetch: mockFetch as any,
    });

    const clientPromise = client.start();

    mockStdin.push('First\n');
    await new Promise(resolve => setTimeout(resolve, 50));
    mockStdin.push('Second\n');
    await new Promise(resolve => setTimeout(resolve, 50));
    mockStdin.push(null);

    await clientPromise;

    // Health check + 2 chat requests
    expect(mockFetch).toHaveBeenCalledTimes(3);

    // Skip health check at index 0
    const body1 = JSON.parse(mockFetch.mock.calls[1][1].body);
    const body2 = JSON.parse(mockFetch.mock.calls[2][1].body);

    // Both requests should have session_id
    expect(body1.session_id).toBeDefined();
    expect(body2.session_id).toBeDefined();

    // session_id should be the same UUID across both requests
    expect(body1.session_id).toBe(body2.session_id);

    // Should be a valid UUID format
    expect(body1.session_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('should handle connection errors gracefully', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const client = createChatClient({
      socketPath: '/tmp/test.sock',
      stdin: mockStdin,
      stdout: mockStdout,
      fetch: mockFetch as any,
    });

    const clientPromise = client.start();

    mockStdin.push('Hello\n');
    await new Promise(resolve => setTimeout(resolve, 50));
    mockStdin.push(null);

    await clientPromise;

    const output = stdoutData.join('');
    expect(output).toContain('Server not running');
    expect(output).toContain('ax serve');
  });
});

function createMockSSEStream(content: string): ReadableStream {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      const chunk = {
        choices: [{ delta: { content }, finish_reason: null }],
      };
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
}
