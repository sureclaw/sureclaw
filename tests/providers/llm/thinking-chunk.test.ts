/**
 * Tests that the ChatChunk type accepts thinking chunks
 * and that the mock provider can yield them.
 */
import { describe, it, expect } from 'vitest';
import type { ChatChunk } from '../../../src/providers/llm/types.js';

describe('ChatChunk thinking type', () => {
  it('accepts thinking chunks', () => {
    const chunk: ChatChunk = { type: 'thinking', content: 'Let me think...' };
    expect(chunk.type).toBe('thinking');
    expect(chunk.content).toBe('Let me think...');
  });

  it('thinking chunks flow through async generators', async () => {
    async function* thinkingChat(): AsyncIterable<ChatChunk> {
      yield { type: 'thinking', content: 'Step 1: analyze the problem' };
      yield { type: 'thinking', content: 'Step 2: formulate solution' };
      yield { type: 'text', content: 'Here is the answer.' };
      yield { type: 'done', usage: { inputTokens: 20, outputTokens: 10 } };
    }

    const chunks: ChatChunk[] = [];
    for await (const chunk of thinkingChat()) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(4);
    expect(chunks[0].type).toBe('thinking');
    expect(chunks[1].type).toBe('thinking');
    expect(chunks[2].type).toBe('text');
    expect(chunks[3].type).toBe('done');
  });
});
