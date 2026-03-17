import type { LLMProvider, ChatRequest, ChatChunk } from '../../src/providers/llm/types.js';

export interface LLMTurn {
  chunks: ChatChunk[];
  match?: RegExp;
}

export function createScriptableLLM(
  turns: LLMTurn[],
  fallback?: LLMTurn,
): LLMProvider & { callCount: number; calls: ChatRequest[] } {
  let nextIndex = 0;
  const calls: ChatRequest[] = [];

  return {
    name: 'scriptable-mock',
    callCount: 0,
    calls,

    async *chat(req: ChatRequest): AsyncIterable<ChatChunk> {
      calls.push(req);

      const lastMsg = req.messages[req.messages.length - 1];
      const lastText = typeof lastMsg?.content === 'string' ? lastMsg.content : '';

      let turn: LLMTurn | undefined;
      while (nextIndex < turns.length) {
        const candidate = turns[nextIndex];
        if (!candidate.match || candidate.match.test(lastText)) {
          turn = candidate;
          nextIndex++;
          break;
        }
        nextIndex++;
      }

      if (!turn) {
        turn = fallback ?? {
          chunks: [
            { type: 'text', content: 'No more scripted turns.' },
            { type: 'done', usage: { inputTokens: 10, outputTokens: 5 } },
          ],
        };
      }

      (this as { callCount: number }).callCount++;
      for (const chunk of turn.chunks) {
        yield chunk;
      }
    },

    async models() {
      return ['scriptable-mock'];
    },
  };
}

export function textTurn(content: string, match?: RegExp): LLMTurn {
  return {
    match,
    chunks: [
      { type: 'text', content },
      { type: 'done', usage: { inputTokens: 10, outputTokens: content.split(' ').length } },
    ],
  };
}

export function toolUseTurn(
  toolName: string,
  args: Record<string, unknown>,
  opts?: { id?: string; match?: RegExp },
): LLMTurn {
  return {
    match: opts?.match,
    chunks: [
      {
        type: 'tool_use',
        toolCall: {
          id: opts?.id ?? `tc-${Date.now()}`,
          name: toolName,
          args,
        },
      },
      { type: 'done', usage: { inputTokens: 15, outputTokens: 10 } },
    ],
  };
}

export function toolThenTextTurn(
  toolName: string,
  args: Record<string, unknown>,
  text: string,
  opts?: { id?: string; match?: RegExp },
): LLMTurn {
  return {
    match: opts?.match,
    chunks: [
      { type: 'text', content: text },
      {
        type: 'tool_use',
        toolCall: {
          id: opts?.id ?? `tc-${Date.now()}`,
          name: toolName,
          args,
        },
      },
      { type: 'done', usage: { inputTokens: 15, outputTokens: 10 } },
    ],
  };
}
