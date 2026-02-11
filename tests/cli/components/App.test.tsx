// tests/cli/components/App.test.tsx
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { App } from '../../../src/cli/components/App.js';

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

function wait(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Render App and wait for the submit function to be exposed via onReady */
function renderApp(props: Partial<React.ComponentProps<typeof App>> & { fetchFn: typeof fetch; sessionId: string }) {
  let submitFn: (value: string) => void = () => {};
  const result = render(
    <App
      {...props}
      onReady={(fn) => { submitFn = fn; }}
    />
  );
  const submit = (value: string) => submitFn(value);
  return { ...result, submit };
}

describe('App', () => {
  it('should render input area on start', () => {
    const mockFetch = vi.fn();
    const { lastFrame } = renderApp({ fetchFn: mockFetch, sessionId: 'test-session' });
    const frame = lastFrame();
    expect(frame).toContain('Type a message');
  });

  it('should send message and show response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      body: createMockSSEStream('Hello from agent'),
    });

    const { lastFrame, submit } = renderApp({
      fetchFn: mockFetch,
      sessionId: 'test-session',
    });

    submit('Hello');
    await wait(100);

    const frame = lastFrame();
    expect(frame).toContain('Hello');
    expect(frame).toContain('Hello from agent');
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it('should handle /clear command', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      body: createMockSSEStream('some response'),
    });

    const { lastFrame, submit } = renderApp({
      fetchFn: mockFetch,
      sessionId: 'test-session',
    });

    submit('hello');
    await wait(100);

    // Verify response appeared
    expect(lastFrame()).toContain('some response');

    submit('/clear');
    await wait(50);

    // After clear, previous messages should be gone
    expect(lastFrame()).not.toContain('some response');
  });

  it('should handle /help command', async () => {
    const { lastFrame, submit } = renderApp({
      fetchFn: vi.fn(),
      sessionId: 'test-session',
    });

    submit('/help');
    await wait(50);

    const frame = lastFrame();
    expect(frame).toContain('/quit');
    expect(frame).toContain('/clear');
    expect(frame).toContain('/help');
  });

  it('should show error for unknown commands', async () => {
    const { lastFrame, submit } = renderApp({
      fetchFn: vi.fn(),
      sessionId: 'test-session',
    });

    submit('/foo');
    await wait(50);

    const frame = lastFrame();
    expect(frame).toContain('Unknown command');
    expect(frame).toContain('/foo');
  });

  it('should show connection error when server is down', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const { lastFrame, submit } = renderApp({
      fetchFn: mockFetch,
      sessionId: 'test-session',
    });

    submit('hello');
    await wait(100);

    const frame = lastFrame();
    expect(frame).toContain('Cannot connect');
    expect(frame).toContain('ax serve');
  });

  it('should show API error messages', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error',
    });

    const { lastFrame, submit } = renderApp({
      fetchFn: mockFetch,
      sessionId: 'test-session',
    });

    submit('hello');
    await wait(100);

    const frame = lastFrame();
    expect(frame).toContain('Internal Server Error');
  });

  it('should include session_id in requests', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      body: createMockSSEStream('ok'),
    });

    const { submit } = renderApp({
      fetchFn: mockFetch,
      sessionId: 'my-session-123',
    });

    submit('hello');
    await wait(100);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.session_id).toBe('my-session-123');
  });

  it('should accumulate conversation history', async () => {
    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(() => {
      callCount++;
      return Promise.resolve({
        ok: true,
        body: createMockSSEStream(`Response ${callCount}`),
      });
    });

    const { submit } = renderApp({
      fetchFn: mockFetch,
      sessionId: 'test-session',
    });

    submit('First');
    await wait(150);
    submit('Second');
    await wait(150);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    const body = JSON.parse(mockFetch.mock.calls[1][1].body);
    // Should have: user1, assistant1, user2
    expect(body.messages.length).toBe(3);
  });

  it('should handle non-streaming response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'Non-streamed response' } }],
      }),
      body: null,
    });

    const { lastFrame, submit } = renderApp({
      fetchFn: mockFetch,
      sessionId: 'test',
      stream: false,
    });

    submit('hello');
    await wait(100);

    expect(lastFrame()).toContain('Non-streamed response');
  });

  it('should handle multi-chunk streaming response', async () => {
    const encoder = new TextEncoder();
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      body: new ReadableStream({
        async start(controller) {
          controller.enqueue(encoder.encode(
            `data: ${JSON.stringify({ choices: [{ delta: { content: 'Hello' } }] })}\n\n`
          ));
          await new Promise(r => setTimeout(r, 20));
          controller.enqueue(encoder.encode(
            `data: ${JSON.stringify({ choices: [{ delta: { content: ' world' } }] })}\n\n`
          ));
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        },
      }),
    });

    const { lastFrame, submit } = renderApp({
      fetchFn: mockFetch,
      sessionId: 'test',
    });

    submit('hi');
    await wait(200);

    expect(lastFrame()).toContain('Hello world');
  });
});
