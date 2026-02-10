import { describe, test, expect, vi } from 'vitest';
import { createIPCStreamFn } from '../../src/container/ipc-transport.js';
import type { IPCClient } from '../../src/container/ipc-client.js';
import type { Model, Context } from '@mariozechner/pi-ai';

// Minimal model mock matching the Model interface
const mockModel: Model<any> = {
  id: 'claude-sonnet-4-5-20250929',
  name: 'Claude Sonnet 4.5',
  api: 'anthropic-messages',
  provider: 'anthropic',
  baseUrl: 'https://api.anthropic.com',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200000,
  maxTokens: 8192,
};

describe('ipc-transport', () => {
  test('routes LLM call through IPC and returns event stream', async () => {
    const client = {
      call: vi.fn().mockResolvedValue({
        ok: true,
        chunks: [
          { type: 'text', content: 'Hello ' },
          { type: 'text', content: 'world' },
          { type: 'done', usage: { inputTokens: 10, outputTokens: 5 } },
        ],
      }),
    } as unknown as IPCClient;

    const streamFn = createIPCStreamFn(client);
    const context: Context = {
      systemPrompt: 'You are helpful.',
      messages: [{ role: 'user', content: 'Hi', timestamp: Date.now() }],
    };

    const stream = await streamFn(mockModel, context);

    // Collect all events
    const events = [];
    for await (const event of stream) {
      events.push(event);
    }

    // Should have start, text events, and done
    expect(events.length).toBeGreaterThan(0);
    const doneEvent = events.find((e) => e.type === 'done');
    expect(doneEvent).toBeTruthy();
    expect(doneEvent!.type).toBe('done');

    // Verify IPC was called with the right data (+ LLM timeout)
    expect(client.call).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'llm_call',
      }),
      expect.any(Number),
    );
  });

  test('sends model, messages, and system prompt to IPC', async () => {
    const client = {
      call: vi.fn().mockResolvedValue({
        ok: true,
        chunks: [{ type: 'done', usage: { inputTokens: 0, outputTokens: 0 } }],
      }),
    } as unknown as IPCClient;

    const streamFn = createIPCStreamFn(client);
    const context: Context = {
      systemPrompt: 'Be helpful.',
      messages: [
        { role: 'user', content: 'Hello', timestamp: Date.now() },
      ],
      tools: [],
    };

    const stream = await streamFn(mockModel, context);
    for await (const _ of stream) { /* drain */ }

    const callArg = client.call.mock.calls[0][0];
    expect(callArg.action).toBe('llm_call');
    expect(callArg.model).toBe('claude-sonnet-4-5-20250929');
    expect(callArg.messages).toBeDefined();
    // System prompt should be prepended as first message in the array
    expect(callArg.messages[0]).toEqual({ role: 'system', content: 'Be helpful.' });
    expect(callArg.messages[1]).toEqual(expect.objectContaining({ role: 'user', content: 'Hello' }));
  });

  test('handles IPC error response', async () => {
    const client = {
      call: vi.fn().mockResolvedValue({
        ok: false,
        error: 'API key expired',
      }),
    } as unknown as IPCClient;

    const streamFn = createIPCStreamFn(client);
    const context: Context = {
      messages: [{ role: 'user', content: 'Hi', timestamp: Date.now() }],
    };

    const stream = await streamFn(mockModel, context);
    const events = [];
    for await (const event of stream) {
      events.push(event);
    }

    const errorEvent = events.find((e) => e.type === 'error');
    expect(errorEvent).toBeTruthy();
  });

  test('handles IPC connection failure', async () => {
    const client = {
      call: vi.fn().mockRejectedValue(new Error('Connection refused')),
    } as unknown as IPCClient;

    const streamFn = createIPCStreamFn(client);
    const context: Context = {
      messages: [{ role: 'user', content: 'Hi', timestamp: Date.now() }],
    };

    const stream = await streamFn(mockModel, context);
    const events = [];
    for await (const event of stream) {
      events.push(event);
    }

    const errorEvent = events.find((e) => e.type === 'error');
    expect(errorEvent).toBeTruthy();
  });

  test('includes tool calls in IPC request when tools present', async () => {
    const client = {
      call: vi.fn().mockResolvedValue({
        ok: true,
        chunks: [{ type: 'done', usage: { inputTokens: 0, outputTokens: 0 } }],
      }),
    } as unknown as IPCClient;

    const streamFn = createIPCStreamFn(client);
    const context: Context = {
      systemPrompt: 'test',
      messages: [{ role: 'user', content: 'Hi', timestamp: Date.now() }],
      tools: [
        { name: 'bash', description: 'Run command', parameters: {} as any },
      ],
    };

    const stream = await streamFn(mockModel, context);
    for await (const _ of stream) { /* drain */ }

    const callArg = client.call.mock.calls[0][0];
    expect(callArg.tools).toBeDefined();
    expect(callArg.tools).toHaveLength(1);
    expect(callArg.tools[0].name).toBe('bash');
  });

  test('preserves tool_use blocks in assistant messages', async () => {
    const client = {
      call: vi.fn().mockResolvedValue({
        ok: true,
        chunks: [{ type: 'done', usage: { inputTokens: 0, outputTokens: 0 } }],
      }),
    } as unknown as IPCClient;

    const streamFn = createIPCStreamFn(client);
    const context: Context = {
      messages: [
        { role: 'user', content: 'list files', timestamp: Date.now() },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'I\'ll list the files.' },
            { type: 'toolCall', id: 'call_1', name: 'bash', arguments: { command: 'ls' } },
          ],
          api: 'anthropic-messages',
          provider: 'anthropic',
          model: 'test',
          usage: { inputTokens: 0, outputTokens: 0, inputCachedTokens: 0, reasoningTokens: 0, totalCost: 0 },
          stopReason: 'toolUse',
          timestamp: Date.now(),
        },
        {
          role: 'toolResult',
          toolCallId: 'call_1',
          toolName: 'bash',
          content: [{ type: 'text', text: 'file1.txt\nfile2.txt' }],
          timestamp: Date.now(),
        },
      ],
    };

    const stream = await streamFn(mockModel, context);
    for await (const _ of stream) { /* drain */ }

    const callArg = client.call.mock.calls[0][0];
    const messages = callArg.messages;

    // Assistant message should have structured content with tool_use block
    const assistantMsg = messages.find((m: any) => m.role === 'assistant');
    expect(Array.isArray(assistantMsg.content)).toBe(true);
    const toolUseBlock = assistantMsg.content.find((b: any) => b.type === 'tool_use');
    expect(toolUseBlock).toBeDefined();
    expect(toolUseBlock.id).toBe('call_1');
    expect(toolUseBlock.name).toBe('bash');
    expect(toolUseBlock.input).toEqual({ command: 'ls' });

    // Tool result should be a structured tool_result block, not plain text
    const toolResultMsg = messages.find((m: any) =>
      m.role === 'user' && Array.isArray(m.content)
    );
    expect(toolResultMsg).toBeDefined();
    const toolResultBlock = toolResultMsg.content.find((b: any) => b.type === 'tool_result');
    expect(toolResultBlock).toBeDefined();
    expect(toolResultBlock.tool_use_id).toBe('call_1');
    expect(toolResultBlock.content).toBe('file1.txt\nfile2.txt');
  });

  test('assistant message without tool calls sends plain string content', async () => {
    const client = {
      call: vi.fn().mockResolvedValue({
        ok: true,
        chunks: [{ type: 'done', usage: { inputTokens: 0, outputTokens: 0 } }],
      }),
    } as unknown as IPCClient;

    const streamFn = createIPCStreamFn(client);
    const context: Context = {
      messages: [
        { role: 'user', content: 'Hi', timestamp: Date.now() },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Hello there!' }],
          api: 'anthropic-messages',
          provider: 'anthropic',
          model: 'test',
          usage: { inputTokens: 0, outputTokens: 0, inputCachedTokens: 0, reasoningTokens: 0, totalCost: 0 },
          stopReason: 'stop',
          timestamp: Date.now(),
        },
        { role: 'user', content: 'How are you?', timestamp: Date.now() },
      ],
    };

    const stream = await streamFn(mockModel, context);
    for await (const _ of stream) { /* drain */ }

    const callArg = client.call.mock.calls[0][0];
    const assistantMsg = callArg.messages.find((m: any) => m.role === 'assistant');
    // Text-only assistant messages should be plain strings (backward compat)
    expect(typeof assistantMsg.content).toBe('string');
    expect(assistantMsg.content).toBe('Hello there!');
  });

  test('emits tool_use events from IPC response with tool calls', async () => {
    const client = {
      call: vi.fn().mockResolvedValue({
        ok: true,
        chunks: [
          { type: 'text', content: 'Let me check.' },
          { type: 'tool_use', toolCall: { id: 'call_99', name: 'bash', args: { command: 'ls' } } },
          { type: 'done', usage: { inputTokens: 10, outputTokens: 5 } },
        ],
      }),
    } as unknown as IPCClient;

    const streamFn = createIPCStreamFn(client);
    const context: Context = {
      messages: [{ role: 'user', content: 'list files', timestamp: Date.now() }],
    };

    const stream = await streamFn(mockModel, context);
    const events = [];
    for await (const event of stream) {
      events.push(event);
    }

    // Should have toolcall events
    const toolCallEnd = events.find(e => e.type === 'toolcall_end');
    expect(toolCallEnd).toBeDefined();
    expect(toolCallEnd!.toolCall.name).toBe('bash');
    expect(toolCallEnd!.toolCall.id).toBe('call_99');

    // Done event should indicate toolUse stop reason
    const doneEvent = events.find(e => e.type === 'done');
    expect(doneEvent).toBeDefined();
    expect(doneEvent!.reason).toBe('toolUse');
  });
});
