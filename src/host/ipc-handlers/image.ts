/**
 * IPC handler: Image generation.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ProviderRegistry } from '../../types.js';
import type { IPCContext } from '../ipc-server.js';
import { workspaceDir } from '../../paths.js';
import { safePath } from '../../utils/safe-path.js';
import { getLogger } from '../../logger.js';

const logger = getLogger().child({ component: 'ipc' });

const MIME_TO_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

export function createImageHandlers(providers: ProviderRegistry) {
  return {
    image_generate: async (req: any, ctx: IPCContext) => {
      if (!providers.image) {
        throw new Error(
          'No image provider configured. Add models.image to ax.yaml ' +
          '(e.g. models: { default: [...], image: ["openai/gpt-image-1.5"] })',
        );
      }

      logger.debug('image_generate_start', {
        model: req.model,
        promptLength: req.prompt?.length,
      });

      const result = await providers.image.generate({
        prompt: req.prompt,
        model: req.model ?? 'gpt-image-1.5',
        size: req.size,
        quality: req.quality,
      });

      // Write generated image to session workspace and return a fileId
      const ext = MIME_TO_EXT[result.mimeType] ?? '.png';
      const fileId = `generated-${randomUUID().slice(0, 8)}${ext}`;
      const wsDir = workspaceDir(ctx.sessionId);
      const filePath = safePath(wsDir, fileId);
      writeFileSync(filePath, result.image);

      logger.debug('image_generate_done', {
        model: result.model,
        bytes: result.image.length,
        fileId,
      });

      return {
        fileId,
        mimeType: result.mimeType,
        text: result.text,
        model: result.model,
        bytes: result.image.length,
      };
    },
  };
}
