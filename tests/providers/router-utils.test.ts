import { describe, test, expect } from 'vitest';
import { parseCompoundId } from '../../src/providers/router-utils.js';

describe('parseCompoundId (shared router utility)', () => {
  test('splits on first slash', () => {
    expect(parseCompoundId('openrouter/gpt-4.1')).toEqual({
      provider: 'openrouter',
      model: 'gpt-4.1',
    });
  });

  test('handles model with slashes (multi-segment model)', () => {
    expect(parseCompoundId('openrouter/moonshotai/kimi-k2')).toEqual({
      provider: 'openrouter',
      model: 'moonshotai/kimi-k2',
    });
  });

  test('throws on bare model name without slash', () => {
    expect(() => parseCompoundId('claude-sonnet')).toThrow('compound provider/model ID');
  });

  test('throws on empty string', () => {
    expect(() => parseCompoundId('')).toThrow('compound provider/model ID');
  });

  test('handles slash at end (empty model)', () => {
    expect(parseCompoundId('provider/')).toEqual({
      provider: 'provider',
      model: '',
    });
  });
});

describe('re-export from llm/router still works', () => {
  test('llm/router re-exports parseCompoundId for backwards compatibility', async () => {
    const mod = await import('../../src/providers/llm/router.js');
    expect(typeof mod.parseCompoundId).toBe('function');
    expect(mod.parseCompoundId('anthropic/claude-sonnet-4')).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-4',
    });
  });
});
