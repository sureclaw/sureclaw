import Anthropic from '@anthropic-ai/sdk';
import type { LLMProvider, ChatRequest, ChatChunk } from './types.js';
import type { Config, ContentBlock } from '../../types.js';
import { debug } from '../../logger.js';

const SRC = 'host:anthropic';

/** Convert a Message.content (string or ContentBlock[]) to Anthropic API format. */
function toAnthropicContent(
  content: string | ContentBlock[],
): string | Anthropic.ContentBlockParam[] {
  if (typeof content === 'string') return content;
  return content.map((block): Anthropic.ContentBlockParam => {
    if (block.type === 'text') return { type: 'text', text: block.text };
    if (block.type === 'tool_use') {
      return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
    }
    // tool_result
    return { type: 'tool_result', tool_use_id: block.tool_use_id, content: block.content };
  });
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
      debug(SRC, 'chat_start', {
        model: req.model,
        maxTokens,
        toolCount: tools?.length ?? 0,
        toolNames: tools?.map(t => t.name),
        messageCount: nonSystemMessages.length,
        hasSystem: !!systemText,
      });

      const stream = client.messages.stream({
        model: req.model || 'claude-sonnet-4-20250514',
        max_tokens: maxTokens,
        system: systemText || undefined,
        messages: nonSystemMessages.map(m => ({
          role: m.role as 'user' | 'assistant',
          content: toAnthropicContent(m.content),
        })),
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
          debug(SRC, 'content_block_stop', {
            index: event.index,
            blockType: block?.type,
            stopReason: finalMsg.stop_reason,
            contentBlockCount: finalMsg.content.length,
          });
          if (block?.type === 'tool_use') {
            toolUseCount++;
            debug(SRC, 'tool_use_yield', { toolName: block.name, toolId: block.id });
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
      debug(SRC, 'chat_done', {
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
