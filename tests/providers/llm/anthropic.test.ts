import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { create, toAnthropicContent } from '../../../src/providers/llm/anthropic.js';
import type { Config, ContentBlock } from '../../../src/types.js';

const config = {} as Config;

describe('toAnthropicContent', () => {
  test('passes plain string through unchanged', async () => {
    const result = await toAnthropicContent('Hello world');
    expect(result).toBe('Hello world');
  });

  test('converts image_data block to Anthropic base64 image source', async () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'Look at this:' },
      { type: 'image_data', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
    ];
    const result = await toAnthropicContent(blocks);
    expect(result).toEqual([
      { type: 'text', text: 'Look at this:' },
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: 'iVBORw0KGgo=',
        },
      },
    ]);
  });

  test('converts image block without resolver to fallback text', async () => {
    const blocks: ContentBlock[] = [
      { type: 'image', fileId: 'files/test.png', mimeType: 'image/png' },
    ];
    const result = await toAnthropicContent(blocks);
    expect(result).toEqual([
      { type: 'text', text: '[Image: files/test.png (could not be loaded)]' },
    ]);
  });

  test('converts image block with resolver to base64 source', async () => {
    const resolver = async (fileId: string) => ({
      mimeType: 'image/jpeg',
      data: Buffer.from('fake-jpeg-data'),
    });
    const blocks: ContentBlock[] = [
      { type: 'image', fileId: 'files/photo.jpg', mimeType: 'image/jpeg' },
    ];
    const result = await toAnthropicContent(blocks, resolver);
    expect(result).toEqual([
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/jpeg',
          data: Buffer.from('fake-jpeg-data').toString('base64'),
        },
      },
    ]);
  });
});

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
