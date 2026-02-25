import Anthropic from '@anthropic-ai/sdk';
import type { LLMProvider, ChatRequest, ChatChunk, ResolveImageFile } from './types.js';
import type { Config, ContentBlock } from '../../types.js';
import { getLogger } from '../../logger.js';

const logger = getLogger().child({ component: 'anthropic' });

/**
 * Convert a Message.content (string or ContentBlock[]) to Anthropic API format.
 *
 * Image blocks are resolved to base64 via the resolveFile callback.
 * If resolveFile is not provided or resolution fails, image blocks become
 * a text placeholder so the LLM still sees something useful.
 */
export async function toAnthropicContent(
  content: string | ContentBlock[],
  resolveFile?: ResolveImageFile,
): Promise<string | Anthropic.ContentBlockParam[]> {
  if (typeof content === 'string') return content;
  const result: Anthropic.ContentBlockParam[] = [];
  for (const block of content) {
    if (block.type === 'text') {
      result.push({ type: 'text', text: block.text });
    } else if (block.type === 'tool_use') {
      result.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input });
    } else if (block.type === 'tool_result') {
      result.push({ type: 'tool_result', tool_use_id: block.tool_use_id, content: block.content });
    } else if (block.type === 'image_data') {
      // Inline image data — send directly as base64 source (no disk round-trip)
      result.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: block.mimeType as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp',
          data: block.data,
        },
      });
    } else if (block.type === 'image') {
      if (resolveFile) {
        try {
          const file = await resolveFile(block.fileId);
          if (file) {
            result.push({
              type: 'image',
              source: {
                type: 'base64',
                media_type: file.mimeType as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp',
                data: file.data.toString('base64'),
              },
            });
            continue;
          }
        } catch (err) {
          logger.warn('image_resolve_failed', { fileId: block.fileId, error: (err as Error).message });
        }
      }
      // Fallback: tell the LLM an image was attached but couldn't be loaded
      result.push({ type: 'text', text: `[Image: ${block.fileId} (could not be loaded)]` });
    }
  }
  return result;
}

export async function create(config: Config): Promise<LLMProvider> {
  const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const apiKey = process.env.ANTHROPIC_API_KEY;

  // When using OAuth, all agents route LLM calls through the credential-injecting
  // proxy. This host-side provider is unused. Return a stub so the server can start.
  if (!apiKey && oauthToken) {
    return {
      name: 'anthropic',
      async *chat(): AsyncIterable<ChatChunk> {
        throw new Error('LLM calls route through credential-injecting proxy');
      },
      async models() { return []; },
    };
  }

  // No credentials at all — return a stub. When using the claude-code agent
  // runner, all LLM calls go through the credential-injecting proxy and this
  // provider is never invoked. Defer the error to .chat() so the server can
  // still start.
  if (!apiKey) {
    return {
      name: 'anthropic',
      async *chat(): AsyncIterable<ChatChunk> {
        throw new Error(
          'ANTHROPIC_API_KEY environment variable is required.\n' +
          'Set it with: export ANTHROPIC_API_KEY=sk-ant-...',
        );
      },
      async models() { return []; },
    };
  }

  const client = new Anthropic();

  return {
    name: 'anthropic',

    async *chat(req: ChatRequest): AsyncIterable<ChatChunk> {
      const systemMessages = req.messages.filter(m => m.role === 'system');
      const nonSystemMessages = req.messages.filter(m => m.role !== 'system');

      const tools = req.tools?.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters as Anthropic.Tool['input_schema'],
      }));

      const systemText = systemMessages
        .map(m => typeof m.content === 'string' ? m.content : '')
        .join('\n\n');

      const maxTokens = req.maxTokens ?? 4096;
      logger.debug('chat_start', {
        model: req.model,
        maxTokens,
        toolCount: tools?.length ?? 0,
        toolNames: tools?.map(t => t.name),
        messageCount: nonSystemMessages.length,
        hasSystem: !!systemText,
      });

      // Resolve image content blocks to base64 for the Anthropic API
      const resolvedMessages = await Promise.all(
        nonSystemMessages.map(async (m) => ({
          role: m.role as 'user' | 'assistant',
          content: await toAnthropicContent(m.content, req.resolveImageFile),
        })),
      );

      const stream = client.messages.stream({
        model: req.model || 'claude-sonnet-4-20250514',
        max_tokens: maxTokens,
        system: systemText || undefined,
        messages: resolvedMessages,
        ...(tools?.length ? { tools } : {}),
      });

      let chunkCount = 0;
      let toolUseCount = 0;
      for await (const event of stream) {
        if (event.type === 'content_block_delta') {
          const delta = event.delta;
          if ('text' in delta) {
            chunkCount++;
            yield { type: 'text', content: delta.text };
          }
        } else if (event.type === 'content_block_stop') {
          const finalMsg = await stream.finalMessage();
          const block = finalMsg.content[event.index];
          logger.debug('content_block_stop', {
            index: event.index,
            blockType: block?.type,
            stopReason: finalMsg.stop_reason,
            contentBlockCount: finalMsg.content.length,
          });
          if (block?.type === 'tool_use') {
            toolUseCount++;
            logger.debug('tool_use_yield', { toolName: block.name, toolId: block.id });
            yield {
              type: 'tool_use',
              toolCall: {
                id: block.id,
                name: block.name,
                args: block.input as Record<string, unknown>,
              },
            };
          }
        }
      }

      const finalMessage = await stream.finalMessage();
      logger.debug('chat_done', {
        stopReason: finalMessage.stop_reason,
        contentBlockCount: finalMessage.content.length,
        contentBlockTypes: finalMessage.content.map(b => b.type),
        textChunks: chunkCount,
        toolUseChunks: toolUseCount,
        inputTokens: finalMessage.usage.input_tokens,
        outputTokens: finalMessage.usage.output_tokens,
      });
      yield {
        type: 'done',
        usage: {
          inputTokens: finalMessage.usage.input_tokens,
          outputTokens: finalMessage.usage.output_tokens,
        },
      };
    },

    async models(): Promise<string[]> {
      return [
        'claude-sonnet-4-20250514',
        'claude-opus-4-20250514',
        'claude-haiku-3-5-20241022',
      ];
    },
  };
}
