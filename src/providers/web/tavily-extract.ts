import { tavily } from '@tavily/core';
import type { WebExtractProvider, ExtractResult } from './types.js';
import type { Config, TaintTag } from '../../types.js';

function taintTag(): TaintTag {
  return { source: 'web_extract', trust: 'external', timestamp: new Date() };
}

function requireApiKey(): string {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    throw new Error(
      'TAVILY_API_KEY environment variable is required.\n' +
      'Get an API key at https://tavily.com/',
    );
  }
  return apiKey;
}

export async function create(_config: Config): Promise<WebExtractProvider> {
  return {
    async extract(url: string): Promise<ExtractResult> {
      const apiKey = requireApiKey();
      const client = tavily({ apiKey });
      const response = await client.extract([url], {
        extractDepth: 'basic',
        format: 'markdown',
      });

      if (response.failedResults?.length && !response.results?.length) {
        const err = response.failedResults[0];
        throw new Error(err.error || 'Extraction failed');
      }

      const result = response.results?.[0];
      return {
        url,
        content: result?.rawContent ?? '',
        taint: taintTag(),
      };
    },
  };
}
