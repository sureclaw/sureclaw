import { describe, test, expect } from 'vitest';
import { parseCompoundId } from '../../../src/providers/router-utils.js';
import type { Config } from '../../../src/types.js';

// ───────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────

/** Build a minimal Config with models.image array. */
function imageRouterConfig(imageModels: string[]): Config {
  return {
    models: {
      default: ['mock/default'],
      image: imageModels,
    },
    profile: 'balanced',
    providers: {
      memory: 'file', scanner: 'basic',
      channels: [], web: 'none', browser: 'none',
      credentials: 'keychain', skills: 'readonly', audit: 'file',
      sandbox: 'subprocess', scheduler: 'none',
    },
    sandbox: { timeout_sec: 30, memory_mb: 256 },
    scheduler: {
      active_hours: { start: '00:00', end: '23:59', timezone: 'UTC' },
      max_token_budget: 4096,
      heartbeat_interval_min: 30,
    },
    history: { max_turns: 50, thread_context_turns: 5 },
  };
}

// ───────────────────────────────────────────────────────
// Image router
// ───────────────────────────────────────────────────────

describe('Image router', () => {
  test('create() requires config.models.image', async () => {
    const config = imageRouterConfig(['mock/default']);
    delete (config as any).models.image;

    const { create } = await import('../../../src/providers/image/router.js');
    await expect(create(config)).rejects.toThrow('config.models.image is required');
  });

  test('create() loads router with mock provider successfully', async () => {
    const config = imageRouterConfig(['mock/default']);
    const { create } = await import('../../../src/providers/image/router.js');
    const router = await create(config);

    expect(router.name).toContain('image-router');
    expect(router.name).toContain('mock/default');
  });

  test('single candidate generates image from mock provider', async () => {
    const config = imageRouterConfig(['mock/test-model']);
    const { create } = await import('../../../src/providers/image/router.js');
    const router = await create(config);

    const result = await router.generate({
      prompt: 'a cute cat',
      model: 'ignored-by-router',
    });

    expect(result.image).toBeInstanceOf(Buffer);
    expect(result.image.length).toBeGreaterThan(0);
    expect(result.mimeType).toBe('image/png');
    expect(result.model).toBe('test-model');
  });

  test('models() aggregates from child providers', async () => {
    const config = imageRouterConfig(['mock/default']);
    const { create } = await import('../../../src/providers/image/router.js');
    const router = await create(config);

    const models = await router.models();
    expect(models.length).toBeGreaterThan(0);
    expect(models.some(m => m.startsWith('mock/'))).toBe(true);
  });

  test('router name includes all candidates', async () => {
    const config = imageRouterConfig(['mock/primary', 'mock/fallback1']);
    const { create } = await import('../../../src/providers/image/router.js');
    const router = await create(config);

    expect(router.name).toContain('mock/primary');
    expect(router.name).toContain('mock/fallback1');
  });
});

// ───────────────────────────────────────────────────────
// parseCompoundId reuse (shared with LLM router)
// ───────────────────────────────────────────────────────

describe('parseCompoundId for image models', () => {
  test('handles openrouter image model', () => {
    expect(parseCompoundId('openrouter/seedream-5-0')).toEqual({
      provider: 'openrouter',
      model: 'seedream-5-0',
    });
  });

  test('handles openai image model', () => {
    expect(parseCompoundId('openai/gpt-image-1.5')).toEqual({
      provider: 'openai',
      model: 'gpt-image-1.5',
    });
  });

  test('handles gemini image model', () => {
    expect(parseCompoundId('gemini/gemini-2.0-flash-preview-image-generation')).toEqual({
      provider: 'gemini',
      model: 'gemini-2.0-flash-preview-image-generation',
    });
  });
});
