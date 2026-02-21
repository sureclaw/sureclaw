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
import { convertPiMessages, emitStreamEvents } from './stream-utils.js';
import { getLogger } from '../logger.js';

const logger = getLogger().child({ component: 'ipc-transport' });

// LLM calls can take minutes for complex prompts. The default IPC timeout
// (30s) is far too short. Configurable via AX_LLM_TIMEOUT_MS, defaults to 10 minutes.
const LLM_CALL_TIMEOUT_MS = parseInt(process.env.AX_LLM_TIMEOUT_MS ?? '', 10) || 10 * 60 * 1000;

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
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop',
    errorMessage: errorText,
    timestamp: Date.now(),
  };
}

/**
 * Create a StreamFn that routes LLM calls through AX's IPC protocol.
 *
 * The container holds NO API keys. The host's `llm_call` IPC handler calls the
 * actual LLM provider. This function converts the batch IPC response into
 * pi-ai's AssistantMessageEventStream that the Agent class expects.
 */
export function createIPCStreamFn(client: IPCClient): StreamFn {
  return async (model: Model<any>, context: Context, options?: SimpleStreamOptions): Promise<AssistantMessageEventStream> => {
    const stream = createAssistantMessageEventStream();

    const msgCount = context.messages.length;
    const toolCount = context.tools?.length ?? 0;
    logger.debug('stream_start', {
      model: model?.id,
      messageCount: msgCount,
      toolCount,
      hasSystemPrompt: !!context.systemPrompt,
      maxTokens: options?.maxTokens,
    });

    const messages = convertPiMessages(context.messages);

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

        const maxTokens = options?.maxTokens ?? model?.maxTokens;
        logger.debug('ipc_call', { messageCount: allMessages.length, toolCount: tools?.length ?? 0, maxTokens });
        const response = await client.call({
          action: 'llm_call',
          model: model?.id,
          messages: allMessages,
          tools,
          maxTokens,
        }, LLM_CALL_TIMEOUT_MS) as unknown as IPCResponse;

        if (!response.ok) {
          logger.debug('ipc_error', { error: response.error });
          const errMsg = makeErrorMessage(response.error ?? 'LLM call failed');
          stream.push({ type: 'start', partial: errMsg });
          stream.push({ type: 'error', reason: 'error', error: errMsg });
          return;
        }

        const chunks = response.chunks ?? [];
        logger.debug('ipc_response', { chunkCount: chunks.length, chunkTypes: chunks.map(c => c.type) });
        const textParts: string[] = [];
        const toolCalls: ToolCall[] = [];
        let usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

        for (const chunk of chunks) {
          if (chunk.type === 'text' && chunk.content) {
            textParts.push(chunk.content);
          } else if (chunk.type === 'tool_use' && chunk.toolCall) {
            toolCalls.push({
              type: 'toolCall',
              id: chunk.toolCall.id,
              name: chunk.toolCall.name,
              arguments: chunk.toolCall.args,
            });
          } else if (chunk.type === 'done' && chunk.usage) {
            usage = { ...usage, input: chunk.usage.inputTokens, output: chunk.usage.outputTokens, totalTokens: chunk.usage.inputTokens + chunk.usage.outputTokens };
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
          stopReason: stopReason as 'stop' | 'toolUse',
          timestamp: Date.now(),
        };

        logger.debug('stream_done', {
          stopReason,
          textLength: fullText.length,
          toolCallCount: toolCalls.length,
          toolNames: toolCalls.map(t => t.name),
          usage,
        });
        emitStreamEvents(stream, msg, fullText, toolCalls, stopReason as 'stop' | 'toolUse');
      } catch (err: unknown) {
        logger.debug('stream_error', { error: (err as Error).message, stack: (err as Error).stack });
        const errMsg = makeErrorMessage((err as Error).message);
        stream.push({ type: 'start', partial: errMsg });
        stream.push({ type: 'error', reason: 'error', error: errMsg });
      }
    })();

    return stream;
  };
}
