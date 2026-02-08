import type { LLMProvider, ChatRequest, ChatChunk, Config } from './types.js';

export async function create(_config: Config): Promise<LLMProvider> {
  return {
    name: 'mock',

    async *chat(req: ChatRequest): AsyncIterable<ChatChunk> {
      const lastMsg = req.messages[req.messages.length - 1]?.content ?? '';

      // Simple canned responses for testing
      let response = 'Hello from mock LLM.';

      if (lastMsg.includes('remember')) {
        response = 'I will remember that for you.';
      } else if (lastMsg.includes('hello') || lastMsg.includes('hi')) {
        response = 'Hello! How can I help you today?';
      }

      yield { type: 'text', content: response };
      yield {
        type: 'done',
        usage: { inputTokens: 10, outputTokens: response.split(' ').length },
      };
    },

    async models(): Promise<string[]> {
      return ['mock-model'];
    },
  };
}
