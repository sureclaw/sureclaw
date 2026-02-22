/**
 * Shared proxy-based LLM stream function.
 *
 * Both runner.ts (pi-agent-core) and pi-session.ts (pi-coding-agent) need
 * to route LLM calls through the credential-injecting Anthropic SDK proxy.
 * This module provides a single implementation.
 */

import { createAssistantMessageEventStream } from '@mariozechner/pi-ai';
import type {
  Model,
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  SimpleStreamOptions,
  TextContent,
  ToolCall,
} from '@mariozechner/pi-ai';
import type { MessageParam, Tool as AnthropicTool } from '@anthropic-ai/sdk/resources/messages';
import { convertPiMessages, emitStreamEvents, createLazyAnthropicClient } from './stream-utils.js';
import { getLogger } from '../logger.js';

const DEFAULT_MODEL_ID = 'claude-sonnet-4-5-20250929';

const logger = getLogger().child({ component: 'proxy-stream' });

/**
 * Create a stub AssistantMessage for error reporting.
 */
export function makeProxyErrorMessage(errorText: string, api = 'anthropic-messages'): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: errorText }],
    api,
    provider: 'anthropic',
    model: 'unknown',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop',
    errorMessage: errorText,
    timestamp: Date.now(),
  };
}

/**
 * Create a StreamFn that routes LLM calls through the credential-injecting
 * proxy via the Anthropic SDK. The proxy injects real API credentials — the
 * container never sees them.
 *
 * Works as both sync (returns stream) and async (returns Promise<stream>)
 * StreamFn — pi-agent-core and pi-coding-agent both accept either.
 */
export function createProxyStreamFn(proxySocket: string) {
  const getClient = createLazyAnthropicClient(proxySocket);

  return (model: Model<any>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream => {
    const stream = createAssistantMessageEventStream();

    const msgCount = context.messages.length;
    const toolCount = context.tools?.length ?? 0;
    logger.debug('proxy_stream_start', {
      model: model?.id,
      messageCount: msgCount,
      toolCount,
      hasSystemPrompt: !!context.systemPrompt,
    });

    const messages = convertPiMessages(context.messages) as MessageParam[];

    // Convert pi-ai tools to Anthropic SDK Tool[] format.
    const tools: AnthropicTool[] | undefined = context.tools?.map((t: any) => ({
      name: t.name,
      description: t.description ?? '',
      input_schema: (t.parameters ?? { type: 'object', properties: {} }) as unknown as AnthropicTool['input_schema'],
    }));

    const maxTokens = options?.maxTokens ?? model?.maxTokens ?? 8192;

    (async () => {
      try {
        const anthropic = await getClient();

        logger.debug('proxy_call', { messageCount: messages.length, toolCount: tools?.length ?? 0, maxTokens });

        const sdkStream = anthropic.messages.stream({
          model: model?.id ?? DEFAULT_MODEL_ID,
          max_tokens: maxTokens,
          system: context.systemPrompt || undefined,
          messages,
          tools: tools && tools.length > 0 ? tools : undefined,
        });

        const finalMessage = await sdkStream.finalMessage();

        // Build pi-ai AssistantMessage from the final response.
        const contentArr: (TextContent | ToolCall)[] = [];
        const toolCalls: ToolCall[] = [];
        const textParts: string[] = [];

        for (const block of finalMessage.content) {
          if (block.type === 'text') {
            textParts.push(block.text);
          } else if (block.type === 'tool_use') {
            toolCalls.push({
              type: 'toolCall',
              id: block.id,
              name: block.name,
              arguments: block.input as Record<string, unknown>,
            });
          }
        }

        const fullText = textParts.join('');
        if (fullText) contentArr.push({ type: 'text', text: fullText });
        contentArr.push(...toolCalls);

        const stopReason = finalMessage.stop_reason === 'tool_use' ? 'toolUse' : 'stop';
        const usage = {
          input: finalMessage.usage?.input_tokens ?? 0,
          output: finalMessage.usage?.output_tokens ?? 0,
          cacheRead: (finalMessage.usage as Record<string, number>)?.cache_read_input_tokens ?? 0,
          cacheWrite: (finalMessage.usage as Record<string, number>)?.cache_creation_input_tokens ?? 0,
          totalTokens: (finalMessage.usage?.input_tokens ?? 0) + (finalMessage.usage?.output_tokens ?? 0),
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        };

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

        logger.debug('proxy_stream_done', {
          stopReason,
          textLength: fullText.length,
          toolCallCount: toolCalls.length,
          toolNames: toolCalls.map(t => t.name),
          usage,
        });
        emitStreamEvents(stream, msg, fullText, toolCalls, stopReason as 'stop' | 'toolUse');
      } catch (err: unknown) {
        logger.debug('proxy_stream_error', { error: (err as Error).message, stack: (err as Error).stack });
        const errMsg = makeProxyErrorMessage((err as Error).message);
        stream.push({ type: 'start', partial: errMsg });
        stream.push({ type: 'error', reason: 'error', error: errMsg });
      }
    })();

    return stream;
  };
}
