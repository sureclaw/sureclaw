import type { ImageProvider, ImageGenerateRequest, ImageGenerateResult } from './types.js';
import type { Config } from '../../types.js';

/** 1x1 transparent PNG for testing. */
const MOCK_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQAB' +
  'Nl7BcQAAAABJRU5ErkJggg==',
  'base64',
);

export async function create(_config: Config): Promise<ImageProvider> {
  return {
    name: 'mock',

    async generate(req: ImageGenerateRequest): Promise<ImageGenerateResult> {
      return {
        image: MOCK_PNG,
        mimeType: 'image/png',
        text: `Mock image generated for: ${req.prompt.slice(0, 100)}`,
        model: req.model || 'mock-image-model',
      };
    },

    async models(): Promise<string[]> {
      return ['mock-image-model'];
    },
  };
}
