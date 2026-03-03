import { describe, test, expect } from 'vitest';
import { createWebhookTransform } from '../../src/host/webhook-transform.js';
import type { LLMProvider } from '../../src/providers/llm/types.js';

// Mock LLM provider that returns predictable JSON
function mockLlm(responseJson: string): LLMProvider {
  return {
    name: 'mock',
    async *chat() {
      yield { type: 'text' as const, content: responseJson };
      yield { type: 'done' as const, usage: { inputTokens: 10, outputTokens: 10 } };
    },
    async models() { return ['mock']; },
  };
}

describe('webhook transform', () => {
  test('returns structured result from LLM response', async () => {
    const llm = mockLlm('{"message":"New push to main by alice","agentId":"devops"}');
    const transform = createWebhookTransform(llm, 'mock-model');
    const result = await transform(
      '# GitHub\nExtract push info',
      { 'x-github-event': 'push' },
      { ref: 'refs/heads/main', pusher: { name: 'alice' } },
    );
    expect(result).toEqual({
      message: 'New push to main by alice',
      agentId: 'devops',
    });
  });

  test('returns null when LLM returns null', async () => {
    const llm = mockLlm('null');
    const transform = createWebhookTransform(llm, 'mock-model');
    const result = await transform('# Skip stars', {}, { action: 'starred' });
    expect(result).toBeNull();
  });

  test('throws on invalid LLM output', async () => {
    const llm = mockLlm('not json');
    const transform = createWebhookTransform(llm, 'mock-model');
    await expect(
      transform('# Test', {}, {}),
    ).rejects.toThrow();
  });

  test('throws when message field is missing', async () => {
    const llm = mockLlm('{"agentId":"main"}');
    const transform = createWebhookTransform(llm, 'mock-model');
    await expect(
      transform('# Test', {}, {}),
    ).rejects.toThrow(/message/);
  });

  test('accepts all optional fields', async () => {
    const llm = mockLlm('{"message":"test","agentId":"main","sessionKey":"s1","model":"m1","timeoutSec":60}');
    const transform = createWebhookTransform(llm, 'mock-model');
    const result = await transform('# Test', {}, {});
    expect(result).toEqual({
      message: 'test',
      agentId: 'main',
      sessionKey: 's1',
      model: 'm1',
      timeoutSec: 60,
    });
  });

  test('uses model override when provided', async () => {
    let capturedModel = '';
    const llm: LLMProvider = {
      name: 'mock',
      async *chat(req) {
        capturedModel = req.model;
        yield { type: 'text' as const, content: '{"message":"test"}' };
        yield { type: 'done' as const, usage: { inputTokens: 10, outputTokens: 10 } };
      },
      async models() { return ['mock']; },
    };
    const transform = createWebhookTransform(llm, 'default-model');
    await transform('# Test', {}, {}, 'override-model');
    expect(capturedModel).toBe('override-model');
  });
});
