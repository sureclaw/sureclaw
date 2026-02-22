/**
 * IPC handler: LLM calls.
 */
import type { ProviderRegistry } from '../../types.js';
import type { IPCContext } from '../ipc-server.js';
import { getLogger } from '../../logger.js';

const logger = getLogger().child({ component: 'ipc' });

export function createLLMHandlers(providers: ProviderRegistry, configModel?: string) {
  return {
    llm_call: async (req: any) => {
      logger.debug('llm_call_start', {
        model: configModel ?? req.model,
        maxTokens: req.maxTokens,
        toolCount: req.tools?.length ?? 0,
        toolNames: req.tools?.map((t: { name: string }) => t.name),
        messageCount: req.messages?.length ?? 0,
      });
      const chunks: unknown[] = [];
      for await (const chunk of providers.llm.chat({
        model: req.model ?? 'claude-sonnet-4-20250514',
        messages: req.messages,
        tools: req.tools,
        maxTokens: req.maxTokens,
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
