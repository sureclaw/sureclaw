/**
 * OpenAI-compatible image generation provider.
 *
 * Works with OpenAI (gpt-image-1.5, dall-e-3), OpenRouter, Groq,
 * and any provider that implements the /v1/images/generations endpoint
 * (including Seedream hosts).
 */

import type { ImageProvider, ImageGenerateRequest, ImageGenerateResult } from './types.js';
import type { Config } from '../../types.js';
import { getLogger } from '../../logger.js';

const logger = getLogger().child({ component: 'openai-images' });

/** Default base URLs for known OpenAI-compatible providers. */
const DEFAULT_BASE_URLS: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  groq: 'https://api.groq.com/openai/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  fireworks: 'https://api.fireworks.ai/inference/v1',
};

function envKey(providerName: string): string {
  return `${providerName.toUpperCase()}_API_KEY`;
}

function envBaseUrl(providerName: string): string {
  return `${providerName.toUpperCase()}_BASE_URL`;
}

export async function create(config: Config, providerName?: string): Promise<ImageProvider> {
  const name = providerName || 'openai';
  const apiKeyEnv = envKey(name);
  const apiKey = process.env[apiKeyEnv];

  if (!apiKey) {
    return {
      name,
      async generate(): Promise<ImageGenerateResult> {
        throw new Error(
          `${apiKeyEnv} environment variable is required.\n` +
          `Set it with: export ${apiKeyEnv}=your-api-key`,
        );
      },
      async models() { return []; },
    };
  }

  const baseUrlEnv = envBaseUrl(name);
  const baseURL = process.env[baseUrlEnv] || DEFAULT_BASE_URLS[name] || 'https://api.openai.com/v1';

  logger.debug('create', { provider: name, baseURL });

  return {
    name,

    async generate(req: ImageGenerateRequest): Promise<ImageGenerateResult> {
      logger.debug('generate_start', { provider: name, model: req.model, size: req.size, quality: req.quality });

      const body: Record<string, unknown> = {
        model: req.model,
        prompt: req.prompt,
        n: 1,
        response_format: 'b64_json',
      };
      if (req.size) body.size = req.size;
      if (req.quality) body.quality = req.quality;

      const response = await fetch(`${baseURL}/images/generations`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Image generation failed (${response.status}): ${text}`);
      }

      const json = await response.json() as {
        data: Array<{ b64_json?: string; url?: string; revised_prompt?: string }>;
      };

      const item = json.data?.[0];
      if (!item) {
        throw new Error('Image generation returned no data');
      }

      let imageBuffer: Buffer;
      if (item.b64_json) {
        imageBuffer = Buffer.from(item.b64_json, 'base64');
      } else if (item.url) {
        const imgResp = await fetch(item.url);
        imageBuffer = Buffer.from(await imgResp.arrayBuffer());
      } else {
        throw new Error('Image generation returned neither b64_json nor url');
      }

      logger.debug('generate_done', { provider: name, model: req.model, bytes: imageBuffer.length });

      return {
        image: imageBuffer,
        mimeType: 'image/png',
        text: item.revised_prompt,
        model: req.model,
      };
    },

    async models(): Promise<string[]> {
      // The images endpoint doesn't have a standard model listing.
      // Return known models for the provider.
      if (name === 'openai') return ['gpt-image-1.5', 'gpt-image-1', 'dall-e-3'];
      return [];
    },
  };
}
