import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { create } from '../../../src/providers/llm/anthropic.js';
import type { Config } from '../../../src/types.js';

const config = {} as Config;

describe('anthropic LLM provider', () => {
  let savedApiKey: string | undefined;
  let savedOauthToken: string | undefined;

  beforeEach(() => {
    savedApiKey = process.env.ANTHROPIC_API_KEY;
    savedOauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  });

  afterEach(() => {
    if (savedApiKey !== undefined) process.env.ANTHROPIC_API_KEY = savedApiKey;
    else delete process.env.ANTHROPIC_API_KEY;
    if (savedOauthToken !== undefined) process.env.CLAUDE_CODE_OAUTH_TOKEN = savedOauthToken;
    else delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  });

  test('returns stub when no credentials are set (does not throw)', async () => {
    const provider = await create(config);
    expect(provider.name).toBe('anthropic');
  });

  test('stub chat() throws when actually called', async () => {
    const provider = await create(config);
    const iter = provider.chat({ model: 'test', messages: [] });
    await expect(iter.next()).rejects.toThrow('ANTHROPIC_API_KEY');
  });

  test('returns stub when only OAuth token is set', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-token';
    const provider = await create(config);
    expect(provider.name).toBe('anthropic');
    const iter = provider.chat({ model: 'test', messages: [] });
    await expect(iter.next()).rejects.toThrow('credential-injecting proxy');
  });
});
