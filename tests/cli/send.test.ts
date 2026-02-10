// tests/cli/send.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createSendClient } from '../../src/cli/send.js';
import { Writable } from 'node:stream';

describe('Send Client', () => {
  it('should send single message and output response', async () => {
    let stdoutData = '';
    const mockStdout = new Writable({
      write(chunk, _encoding, callback) {
        stdoutData += chunk.toString();
        callback();
      },
    });

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      body: createMockSSEStream('The capital is Paris'),
    });

    const client = createSendClient({
      message: 'what is the capital of France',
      socketPath: '/tmp/test.sock',
      stdout: mockStdout,
      fetch: mockFetch as any,
    });

    await client.send();

    expect(mockFetch).toHaveBeenCalledOnce();
    expect(stdoutData).toBe('The capital is Paris');
  });

  it('should read from stdin when --stdin flag', async () => {
    let stdoutData = '';
    const mockStdout = new Writable({
      write(chunk, _encoding, callback) {
        stdoutData += chunk.toString();
        callback();
      },
    });

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      body: createMockSSEStream('Summary complete'),
    });

    const client = createSendClient({
      message: 'summarize this text',
      fromStdin: true,
      socketPath: '/tmp/test.sock',
      stdout: mockStdout,
      stdin: 'Long text to summarize',
      fetch: mockFetch as any,
    });

    await client.send();

    expect(mockFetch).toHaveBeenCalledOnce();
    const call = mockFetch.mock.calls[0];
    const body = JSON.parse(call[1].body);
    expect(body.messages[0].content).toBe('summarize this text');
  });

  it('should output JSON when --json flag', async () => {
    let stdoutData = '';
    const mockStdout = new Writable({
      write(chunk, _encoding, callback) {
        stdoutData += chunk.toString();
        callback();
      },
    });

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'req_123',
        object: 'chat.completion',
        choices: [{ message: { content: 'Paris' } }],
      }),
    });

    const client = createSendClient({
      message: 'capital of France',
      socketPath: '/tmp/test.sock',
      json: true,
      noStream: true,
      stdout: mockStdout,
      fetch: mockFetch as any,
    });

    await client.send();

    const output = JSON.parse(stdoutData);
    expect(output.id).toBe('req_123');
    expect(output.choices[0].message.content).toBe('Paris');
  });

  it('should include session_id when provided', async () => {
    let stdoutData = '';
    const mockStdout = new Writable({
      write(chunk, _encoding, callback) {
        stdoutData += chunk.toString();
        callback();
      },
    });

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      body: createMockSSEStream('response'),
    });

    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const client = createSendClient({
      message: 'hello',
      socketPath: '/tmp/test.sock',
      stdout: mockStdout,
      fetch: mockFetch as any,
      sessionId,
    });

    await client.send();

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.session_id).toBe(sessionId);
  });

  it('should not include session_id when not provided', async () => {
    let stdoutData = '';
    const mockStdout = new Writable({
      write(chunk, _encoding, callback) {
        stdoutData += chunk.toString();
        callback();
      },
    });

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      body: createMockSSEStream('response'),
    });

    const client = createSendClient({
      message: 'hello',
      socketPath: '/tmp/test.sock',
      stdout: mockStdout,
      fetch: mockFetch as any,
    });

    await client.send();

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.session_id).toBeUndefined();
  });

  it('should handle connection errors', async () => {
    const mockStdout = new Writable({ write(_c, _e, cb) { cb(); } });
    const mockFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const client = createSendClient({
      message: 'hello',
      socketPath: '/tmp/test.sock',
      stdout: mockStdout,
      fetch: mockFetch as any,
    });

    await expect(client.send()).rejects.toThrow();
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
