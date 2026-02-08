import Anthropic from '@anthropic-ai/sdk';
import type { LLMProvider, ChatRequest, ChatChunk, Config } from './types.js';

export async function create(_config: Config): Promise<LLMProvider> {
  // API key is injected via ANTHROPIC_API_KEY env var by the SDK automatically.
  // In production, the credential provider supplies it before sandbox launch.
  const client = new Anthropic();

  return {
    name: 'anthropic',

    async *chat(req: ChatRequest): AsyncIterable<ChatChunk> {
      const systemMessages = req.messages.filter(m => m.role === 'system');
      const nonSystemMessages = req.messages.filter(m => m.role !== 'system');

      const stream = client.messages.stream({
        model: req.model || 'claude-sonnet-4-20250514',
        max_tokens: req.maxTokens ?? 4096,
        system: systemMessages.map(m => m.content).join('\n\n') || undefined,
        messages: nonSystemMessages.map(m => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        })),
      });

      for await (const event of stream) {
        if (event.type === 'content_block_delta') {
          const delta = event.delta;
          if ('text' in delta) {
            yield { type: 'text', content: delta.text };
          }
        }
      }

      const finalMessage = await stream.finalMessage();
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
