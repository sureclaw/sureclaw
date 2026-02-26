/**
 * Google Gemini image generation provider.
 *
 * Uses the Gemini generateContent endpoint with responseModalities: ["TEXT", "IMAGE"]
 * for models like gemini-2.0-flash-preview-image-generation.
 */

import type { ImageProvider, ImageGenerateRequest, ImageGenerateResult } from './types.js';
import type { Config } from '../../types.js';
import { getLogger } from '../../logger.js';

const logger = getLogger().child({ component: 'gemini-images' });

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

export async function create(config: Config, providerName?: string): Promise<ImageProvider> {
  const name = providerName || 'gemini';
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return {
      name,
      async generate(): Promise<ImageGenerateResult> {
        throw new Error(
          'GEMINI_API_KEY environment variable is required.\n' +
          'Set it with: export GEMINI_API_KEY=your-api-key',
        );
      },
      async models() { return []; },
    };
  }

  const baseURL = process.env.GEMINI_BASE_URL || DEFAULT_BASE_URL;

  logger.debug('create', { provider: name, baseURL });

  return {
    name,

    async generate(req: ImageGenerateRequest): Promise<ImageGenerateResult> {
      logger.debug('generate_start', { provider: name, model: req.model });

      const parts: Array<Record<string, unknown>> = [{ text: req.prompt }];

      // Add input image for editing workflows
      if (req.inputImage) {
        parts.push({
          inline_data: {
            mime_type: req.inputImage.mimeType,
            data: req.inputImage.data.toString('base64'),
          },
        });
      }

      const body = {
        contents: [{ parts }],
        generationConfig: {
          responseModalities: ['TEXT', 'IMAGE'],
        },
      };

      const url = `${baseURL}/models/${req.model}:generateContent?key=${apiKey}`;

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Gemini image generation failed (${response.status}): ${text}`);
      }

      const json = await response.json() as {
        candidates?: Array<{
          content?: {
            parts?: Array<{
              text?: string;
              inlineData?: { mimeType: string; data: string };
            }>;
          };
        }>;
      };

      const responseParts = json.candidates?.[0]?.content?.parts ?? [];

      // Extract image and text from response parts
      let imageBuffer: Buffer | undefined;
      let mimeType = 'image/png';
      let text: string | undefined;

      for (const part of responseParts) {
        if (part.inlineData) {
          imageBuffer = Buffer.from(part.inlineData.data, 'base64');
          mimeType = part.inlineData.mimeType;
        } else if (part.text) {
          text = (text ? text + '\n' : '') + part.text;
        }
      }

      if (!imageBuffer) {
        throw new Error('Gemini returned no image data in response');
      }

      logger.debug('generate_done', { provider: name, model: req.model, bytes: imageBuffer.length });

      return {
        image: imageBuffer,
        mimeType,
        text,
        model: req.model,
      };
    },

    async models(): Promise<string[]> {
      return ['gemini-2.0-flash-preview-image-generation'];
    },
  };
}
