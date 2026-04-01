/**
 * Shared proxy-based LLM stream function.
 *
 * Routes LLM calls through the credential-injecting Anthropic SDK proxy.
 * Used by the pi-coding-agent runner (pi-session.ts).
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
import { convertPiMessages, emitStreamEvents, createLazyAnthropicClient, injectFileBlocks } from './stream-utils.js';
import { getLogger } from '../logger.js';
import type { ContentBlock } from '../types.js';

const DEFAULT_MODEL_ID = 'claude-sonnet-4-5-20250929';

const logger = getLogger().child({ component: 'proxy-stream' });

const DOCUMENT_MIME_TYPES = new Set([
  'application/pdf', 'text/plain', 'text/csv', 'text/html',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

/** Convert internal file_data and image_data blocks to Anthropic content blocks. */
function fileBlocksToAnthropicDocs(blocks: ContentBlock[]): Array<{ type: string; [k: string]: unknown }> {
  return blocks
    .filter(b => b.type === 'file_data' || b.type === 'image_data')
    .map(b => {
      if (b.type === 'image_data') {
        const ib = b as { type: 'image_data'; data: string; mimeType: string };
        return {
          type: 'image',
          source: { type: 'base64', media_type: ib.mimeType, data: ib.data },
        };
      }
      const fb = b as { type: 'file_data'; data: string; mimeType: string; filename: string };
      if (DOCUMENT_MIME_TYPES.has(fb.mimeType)) {
        return {
          type: 'document',
          source: { type: 'base64', media_type: fb.mimeType, data: fb.data },
        };
      }
      // Non-document files: inline as text
      const text = Buffer.from(fb.data, 'base64').toString('utf-8');
      return { type: 'text', text: `--- ${fb.filename} ---\n${text}\n--- end ---` };
    });
}

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
 * StreamFn — pi-coding-agent accepts either.
 */
export function createProxyStreamFn(proxySocket: string, fileBlocks: ContentBlock[] = []) {
  const getClient = createLazyAnthropicClient(proxySocket);
  let fileBlocksInjected = false;

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
    // Inject file_data blocks (PDFs, etc.) into the user message on the first LLM call.
    // The proxy sends directly to the Anthropic API, so convert to Anthropic document format.
    if (!fileBlocksInjected && fileBlocks.length > 0) {
      const anthropicBlocks = fileBlocksToAnthropicDocs(fileBlocks);
      injectFileBlocks(messages as any[], anthropicBlocks as any[]);
      fileBlocksInjected = true;
    }

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
