import { createAssistantMessageEventStream } from '@mariozechner/pi-ai';
import type {
  AssistantMessageEventStream,
  AssistantMessage,
  Model,
  Context,
  SimpleStreamOptions,
  TextContent,
  ToolCall,
} from '@mariozechner/pi-ai';
import type { StreamFn } from '@mariozechner/pi-agent-core';
import type { IPCClient } from './ipc-client.js';

interface IPCChunk {
  type: 'text' | 'tool_use' | 'done';
  content?: string;
  toolCall?: { id: string; name: string; args: Record<string, unknown> };
  usage?: { inputTokens: number; outputTokens: number };
}

interface IPCResponse {
  ok: boolean;
  chunks?: IPCChunk[];
  error?: string;
}

function makeErrorMessage(errorText: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: errorText }],
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'unknown',
    usage: { inputTokens: 0, outputTokens: 0, inputCachedTokens: 0, reasoningTokens: 0, totalCost: 0 },
    stopReason: 'stop',
    errorMessage: errorText,
    timestamp: Date.now(),
  };
}

/**
 * Create a StreamFn that routes LLM calls through Sureclaw's IPC protocol.
 *
 * The container holds NO API keys. The host's `llm_call` IPC handler calls the
 * actual LLM provider. This function converts the batch IPC response into
 * pi-ai's AssistantMessageEventStream that the Agent class expects.
 */
export function createIPCStreamFn(client: IPCClient): StreamFn {
  return async (model: Model<any>, context: Context, options?: SimpleStreamOptions): Promise<AssistantMessageEventStream> => {
    const stream = createAssistantMessageEventStream();

    // Convert pi-ai messages to Sureclaw's simpler format for IPC
    const messages = context.messages.map((m) => {
      if (m.role === 'user') {
        const content = typeof m.content === 'string'
          ? m.content
          : m.content.filter((c): c is TextContent => c.type === 'text').map((c) => c.text).join('');
        return { role: 'user', content };
      }
      if (m.role === 'assistant') {
        const content = m.content
          .filter((c): c is TextContent => c.type === 'text')
          .map((c) => c.text)
          .join('');
        return { role: 'assistant', content };
      }
      if (m.role === 'toolResult') {
        const content = m.content
          .filter((c): c is TextContent => c.type === 'text')
          .map((c) => c.text)
          .join('');
        return { role: 'user', content: `Tool result for ${m.toolName} (id: ${m.toolCallId}):\n${content}` };
      }
      return { role: 'user', content: '' };
    });

    // Convert tools
    const tools = context.tools?.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));

    // Fire IPC call asynchronously and push events to stream
    (async () => {
      try {
        // Prepend system prompt as a system message (IPC schema expects it in messages array)
        const allMessages = context.systemPrompt
          ? [{ role: 'system', content: context.systemPrompt }, ...messages]
          : messages;

        const response = await client.call({
          action: 'llm_call',
          model: model?.id,
          messages: allMessages,
          tools,
          maxTokens: options?.maxTokens,
        }) as IPCResponse;

        if (!response.ok) {
          const errMsg = makeErrorMessage(response.error ?? 'LLM call failed');
          stream.push({ type: 'start', partial: errMsg });
          stream.push({ type: 'error', reason: 'error', error: errMsg });
          return;
        }

        const chunks = response.chunks ?? [];
        const textParts: string[] = [];
        const toolCalls: ToolCall[] = [];
        let usage = { inputTokens: 0, outputTokens: 0, inputCachedTokens: 0, reasoningTokens: 0, totalCost: 0 };

        for (const chunk of chunks) {
          if (chunk.type === 'text' && chunk.content) {
            textParts.push(chunk.content);
          } else if (chunk.type === 'tool_use' && chunk.toolCall) {
            toolCalls.push({
              type: 'toolCall',
              id: chunk.toolCall.id,
              name: chunk.toolCall.name,
              args: JSON.stringify(chunk.toolCall.args),
            });
          } else if (chunk.type === 'done' && chunk.usage) {
            usage = { ...usage, inputTokens: chunk.usage.inputTokens, outputTokens: chunk.usage.outputTokens };
          }
        }

        // Build the complete assistant message
        const contentArr: (TextContent | ToolCall)[] = [];
        const fullText = textParts.join('');
        if (fullText) contentArr.push({ type: 'text', text: fullText });
        contentArr.push(...toolCalls);

        const stopReason = toolCalls.length > 0 ? 'toolUse' : 'stop';
        const msg: AssistantMessage = {
          role: 'assistant',
          content: contentArr,
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage,
          stopReason,
          timestamp: Date.now(),
        };

        // Emit start
        stream.push({ type: 'start', partial: msg });

        // Emit text deltas
        if (fullText) {
          stream.push({ type: 'text_start', contentIndex: 0, partial: msg });
          stream.push({ type: 'text_delta', contentIndex: 0, delta: fullText, partial: msg });
          stream.push({ type: 'text_end', contentIndex: 0, content: fullText, partial: msg });
        }

        // Emit tool call events
        for (let i = 0; i < toolCalls.length; i++) {
          const idx = fullText ? i + 1 : i;
          stream.push({ type: 'toolcall_start', contentIndex: idx, partial: msg });
          stream.push({ type: 'toolcall_delta', contentIndex: idx, delta: toolCalls[i].args, partial: msg });
          stream.push({ type: 'toolcall_end', contentIndex: idx, toolCall: toolCalls[i], partial: msg });
        }

        // Done
        stream.push({ type: 'done', reason: stopReason as 'stop' | 'toolUse', message: msg });
      } catch (err: unknown) {
        const errMsg = makeErrorMessage((err as Error).message);
        stream.push({ type: 'start', partial: errMsg });
        stream.push({ type: 'error', reason: 'error', error: errMsg });
      }
    })();

    return stream;
  };
}
