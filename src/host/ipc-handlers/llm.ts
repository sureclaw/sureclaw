/**
 * IPC handler: LLM calls.
 */
import { existsSync, readFileSync } from 'node:fs';
import { extname } from 'node:path';
import type { ProviderRegistry } from '../../types.js';
import type { IPCContext } from '../ipc-server.js';
import type { ResolveImageFile } from '../../providers/llm/types.js';
import { workspaceDir } from '../../paths.js';
import { safePath } from '../../utils/safe-path.js';
import { getLogger } from '../../logger.js';

const logger = getLogger().child({ component: 'ipc' });

/** Map file extensions to MIME types for resolved images. */
const EXT_TO_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/** Create a file resolver that reads images from a session workspace. */
function createImageResolver(sessionId: string): ResolveImageFile {
  return async (fileId: string) => {
    const wsDir = workspaceDir(sessionId);
    const segments = fileId.split('/').filter(Boolean);
    const filePath = safePath(wsDir, ...segments);
    if (!existsSync(filePath)) return null;
    const ext = extname(filePath).toLowerCase();
    const mimeType = EXT_TO_MIME[ext] ?? 'application/octet-stream';
    return { data: readFileSync(filePath), mimeType };
  };
}

export function createLLMHandlers(providers: ProviderRegistry, configModel?: string) {
  return {
    llm_call: async (req: any, ctx: IPCContext) => {
      logger.debug('llm_call_start', {
        model: configModel ?? req.model,
        taskType: req.taskType,
        maxTokens: req.maxTokens,
        toolCount: req.tools?.length ?? 0,
        toolNames: req.tools?.map((t: { name: string }) => t.name),
        messageCount: req.messages?.length ?? 0,
      });
      const resolveImageFile = createImageResolver(ctx.sessionId);
      const chunks: unknown[] = [];
      for await (const chunk of providers.llm.chat({
        model: req.model ?? 'claude-sonnet-4-20250514',
        messages: req.messages,
        tools: req.tools,
        taskType: req.taskType,
        maxTokens: req.maxTokens,
        sessionId: ctx.sessionId,
        resolveImageFile,
      })) {
        chunks.push(chunk);
      }
      const typeCounts: Record<string, number> = {};
      for (const c of chunks) {
        const t = (c as any).type ?? 'unknown';
        typeCounts[t] = (typeCounts[t] ?? 0) + 1;
      }
      const toolUseChunks = chunks.filter((c: any) => c.type === 'tool_use');
      const textChunks = chunks.filter((c: any) => c.type === 'text');
      const textPreview = textChunks
        .map((c: any) => c.content ?? '')
        .join('')
        .slice(0, 300);
      logger.debug('llm_call_result', {
        chunkCount: chunks.length,
        chunkTypes: typeCounts,
        toolUseCount: toolUseChunks.length,
        toolNames: toolUseChunks.map((c: any) => c.toolCall?.name),
        textPreview,
      });
      return { chunks };
    },
  };
}
