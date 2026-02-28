/**
 * IPC handler: LLM calls.
 */
import { existsSync, readFileSync } from 'node:fs';
import { extname } from 'node:path';
import type { ProviderRegistry } from '../../types.js';
import type { IPCContext } from '../ipc-server.js';
import type { ResolveImageFile } from '../../providers/llm/types.js';
import { userWorkspaceDir, workspaceDir } from '../../paths.js';
import { safePath } from '../../utils/safe-path.js';
import { getLogger } from '../../logger.js';
import type { EventBus } from '../event-bus.js';

const logger = getLogger().child({ component: 'ipc' });

/** Map file extensions to MIME types for resolved images. */
const EXT_TO_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/** Create a file resolver that reads images from user workspace (primary) or session workspace (fallback). */
function createImageResolver(ctx: IPCContext, agentName: string): ResolveImageFile {
  return async (fileId: string) => {
    const segments = fileId.split('/').filter(Boolean);

    // Primary: check enterprise user workspace using configured agent name
    if (ctx.userId) {
      const userWsDir = userWorkspaceDir(agentName, ctx.userId);
      const userPath = safePath(userWsDir, ...segments);
      if (existsSync(userPath)) {
        const ext = extname(userPath).toLowerCase();
        const mimeType = EXT_TO_MIME[ext] ?? 'application/octet-stream';
        return { data: readFileSync(userPath), mimeType };
      }
    }

    // Fallback: session workspace (agent sandbox CWD)
    const wsDir = workspaceDir(ctx.sessionId);
    const filePath = safePath(wsDir, ...segments);
    if (!existsSync(filePath)) return null;
    const ext = extname(filePath).toLowerCase();
    const mimeType = EXT_TO_MIME[ext] ?? 'application/octet-stream';
    return { data: readFileSync(filePath), mimeType };
  };
}

export function createLLMHandlers(providers: ProviderRegistry, configModel?: string, agentName?: string, eventBus?: EventBus) {
  const resolvedAgentName = agentName ?? 'main';
  return {
    llm_call: async (req: any, ctx: IPCContext) => {
      const effectiveModel = configModel ?? req.model;
      logger.debug('llm_call_start', {
        model: effectiveModel,
        taskType: req.taskType,
        maxTokens: req.maxTokens,
        toolCount: req.tools?.length ?? 0,
        toolNames: req.tools?.map((t: { name: string }) => t.name),
        messageCount: req.messages?.length ?? 0,
      });
      eventBus?.emit({
        type: 'llm.start',
        requestId: ctx.sessionId,
        timestamp: Date.now(),
        data: {
          model: effectiveModel,
          taskType: req.taskType,
          messageCount: req.messages?.length ?? 0,
          toolCount: req.tools?.length ?? 0,
        },
      });
      const resolveImageFile = createImageResolver(ctx, resolvedAgentName);
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
        // Emit per-chunk event for real-time streaming observers
        const chunkType = (chunk as any).type;
        if (chunkType === 'tool_use') {
          eventBus?.emit({
            type: 'tool.call',
            requestId: ctx.sessionId,
            timestamp: Date.now(),
            data: { toolName: (chunk as any).toolCall?.name },
          });
        } else if (chunkType === 'thinking') {
          eventBus?.emit({
            type: 'llm.thinking',
            requestId: ctx.sessionId,
            timestamp: Date.now(),
            data: { contentLength: ((chunk as any).content ?? '').length },
          });
        } else if (chunkType === 'text') {
          eventBus?.emit({
            type: 'llm.chunk',
            requestId: ctx.sessionId,
            timestamp: Date.now(),
            data: { chunkType: 'text', contentLength: ((chunk as any).content ?? '').length },
          });
        }
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
      // Emit usage stats from the 'done' chunk if present
      const doneChunk = chunks.find((c: any) => c.type === 'done') as any;
      eventBus?.emit({
        type: 'llm.done',
        requestId: ctx.sessionId,
        timestamp: Date.now(),
        data: {
          chunkCount: chunks.length,
          toolUseCount: toolUseChunks.length,
          inputTokens: doneChunk?.usage?.inputTokens,
          outputTokens: doneChunk?.usage?.outputTokens,
        },
      });
      return { chunks };
    },
  };
}
