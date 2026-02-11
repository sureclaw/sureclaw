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

/** Health check response returned for GET /health */
const HEALTH_OK = { ok: true, status: 200, json: async () => ({ status: 'ok' }) };

/** Wrap a mock fetch so GET /health is handled automatically */
function withHealthCheck(handler: (...args: unknown[]) => unknown) {
  return (...args: unknown[]) => {
    const url = args[0] as string;
    if (url.endsWith('/health')) return Promise.resolve(HEALTH_OK);
    return handler(...args);
  };
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
    const mockFetch = vi.fn().mockResolvedValue(HEALTH_OK);
    const { lastFrame } = renderApp({ fetchFn: mockFetch, sessionId: 'test-session' });
    const frame = lastFrame();
    expect(frame).toContain('Type a message');
  });

  it('should call health check on mount', async () => {
    const mockFetch = vi.fn().mockResolvedValue(HEALTH_OK);
    renderApp({ fetchFn: mockFetch, sessionId: 'test-session' });

    await wait(50);

    expect(mockFetch).toHaveBeenCalledWith('http://localhost/health', { method: 'GET' });
  });

  it('should show status bar with model and stats', () => {
    const mockFetch = vi.fn().mockResolvedValue(HEALTH_OK);
    const { lastFrame } = renderApp({ fetchFn: mockFetch, sessionId: 'test-session', model: 'claude-3' });

    const frame = lastFrame();
    expect(frame).toContain('claude-3');
    expect(frame).toContain('stream');
    expect(frame).toContain('0 msgs');
  });

  it('should send message and show response', async () => {
    const mockFetch = vi.fn(withHealthCheck(() => Promise.resolve({
      ok: true,
      body: createMockSSEStream('Hello from agent'),
    })));

    const { lastFrame, submit } = renderApp({
      fetchFn: mockFetch,
      sessionId: 'test-session',
    });

    submit('Hello');
    await wait(100);

    const frame = lastFrame();
    expect(frame).toContain('Hello');
    expect(frame).toContain('Hello from agent');
  });

  it('should clear conversation history on /clear', async () => {
    const mockFetch = vi.fn(withHealthCheck(() => Promise.resolve({
      ok: true,
      body: createMockSSEStream('some response'),
    })));

    const { submit } = renderApp({
      fetchFn: mockFetch,
      sessionId: 'test-session',
    });

    submit('hello');
    await wait(100);

    submit('/clear');
    await wait(50);

    // Send a second message — should NOT include prior history
    submit('second');
    await wait(100);

    const chatCalls = mockFetch.mock.calls.filter(
      (c: unknown[]) => (c[0] as string).includes('/v1/chat/completions')
    );
    // Second chat call should only have 1 message (no prior history)
    const body = JSON.parse((chatCalls[1][1] as { body: string }).body);
    expect(body.messages).toHaveLength(1);
  });

  it('should handle /help command', async () => {
    const { lastFrame, submit } = renderApp({
      fetchFn: vi.fn().mockResolvedValue(HEALTH_OK),
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
      fetchFn: vi.fn().mockResolvedValue(HEALTH_OK),
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

    await wait(50);

    submit('hello');
    await wait(100);

    const frame = lastFrame();
    expect(frame).toContain('Cannot connect');
    expect(frame).toContain('ax serve');
  });

  it('should show API error messages', async () => {
    const mockFetch = vi.fn(withHealthCheck(() => Promise.resolve({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error',
    })));

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
    const mockFetch = vi.fn(withHealthCheck(() => Promise.resolve({
      ok: true,
      body: createMockSSEStream('ok'),
    })));

    const { submit } = renderApp({
      fetchFn: mockFetch,
      sessionId: 'my-session-123',
    });

    submit('hello');
    await wait(100);

    // Find the chat completion call (not the health check)
    const chatCall = mockFetch.mock.calls.find(
      (c: unknown[]) => (c[0] as string).includes('/v1/chat/completions')
    );
    expect(chatCall).toBeDefined();
    const body = JSON.parse((chatCall![1] as { body: string }).body);
    expect(body.session_id).toBe('my-session-123');
  });

  it('should accumulate conversation history', async () => {
    let callCount = 0;
    const mockFetch = vi.fn(withHealthCheck(() => {
      callCount++;
      return Promise.resolve({
        ok: true,
        body: createMockSSEStream(`Response ${callCount}`),
      });
    }));

    const { submit } = renderApp({
      fetchFn: mockFetch,
      sessionId: 'test-session',
    });

    submit('First');
    await wait(150);
    submit('Second');
    await wait(150);

    // Find chat completion calls (excluding health check)
    const chatCalls = mockFetch.mock.calls.filter(
      (c: unknown[]) => (c[0] as string).includes('/v1/chat/completions')
    );
    expect(chatCalls).toHaveLength(2);
    const body = JSON.parse((chatCalls[1][1] as { body: string }).body);
    // Should have: user1, assistant1, user2
    expect(body.messages.length).toBe(3);
  });

  it('should handle non-streaming response', async () => {
    const mockFetch = vi.fn(withHealthCheck(() => Promise.resolve({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'Non-streamed response' } }],
      }),
      body: null,
    })));

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
    const mockFetch = vi.fn(withHealthCheck(() => Promise.resolve({
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
    })));

    const { lastFrame, submit } = renderApp({
      fetchFn: mockFetch,
      sessionId: 'test',
    });

    submit('hi');
    await wait(200);

    expect(lastFrame()).toContain('Hello world');
  });

  it('should show thinking spinner on bottom row while loading', async () => {
    // Use a stream that delays so we can observe the loading state
    const encoder = new TextEncoder();
    const mockFetch = vi.fn(withHealthCheck(() => Promise.resolve({
      ok: true,
      body: new ReadableStream({
        async start(controller) {
          await new Promise(r => setTimeout(r, 200));
          controller.enqueue(encoder.encode(
            `data: ${JSON.stringify({ choices: [{ delta: { content: 'done' } }] })}\n\n`
          ));
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        },
      }),
    })));

    const { lastFrame, submit } = renderApp({
      fetchFn: mockFetch,
      sessionId: 'test',
    });

    submit('hi');
    await wait(50);

    // While loading, should show thinking text
    expect(lastFrame()).toContain('thinking...');
  });
});
