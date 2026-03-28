/**
 * IPC handler for batched tool execution with dependency pipelining.
 *
 * The agent sends an ordered array of tool calls. Each call's args may
 * contain { $ref: N, path: "[0].id" } references to prior results.
 * The host executes calls in order, substituting refs with real values.
 *
 * One IPC round trip for N tool calls, including dependent chains.
 */

import type { McpProvider, McpToolCall, McpToolSchema } from '../../providers/mcp/types.js';
import type { IPCContext } from '../ipc-server.js';
import { getLogger } from '../../logger.js';

const logger = getLogger().child({ component: 'tool-batch' });

// ---------------------------------------------------------------------------
// $ref resolution
// ---------------------------------------------------------------------------

/**
 * Evaluate a dot/bracket path on a value: "[0].id" → value[0].id
 */
function evaluatePath(value: unknown, path: string): unknown {
  if (!path) return value;
  const segments = path.match(/\.([^.[]+)|\[(\d+)\]/g);
  if (!segments) return value;
  let current: any = value;
  for (const seg of segments) {
    if (current == null) return undefined;
    if (seg.startsWith('[')) {
      current = current[parseInt(seg.slice(1, -1))];
    } else {
      current = current[seg.slice(1)];
    }
  }
  return current;
}

/**
 * Deep-resolve { $ref, path } markers in args using prior results.
 */
function resolveRefs(value: unknown, results: unknown[]): unknown {
  if (value && typeof value === 'object' && '$ref' in (value as any)) {
    const ref = value as { $ref: number; path?: string };
    const resolved = results[ref.$ref];
    return ref.path ? evaluatePath(resolved, ref.path) : resolved;
  }
  if (Array.isArray(value)) {
    return value.map(v => resolveRefs(v, results));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = resolveRefs(v, results);
    }
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export interface ToolBatchProvider {
  callTool(call: McpToolCall): Promise<{ content: string | Record<string, unknown>; isError?: boolean }>;
}

/**
 * Create tool_batch IPC handler.
 *
 * @param getProvider - Returns the MCP provider for executing tools in this session.
 *   Returns null if tool batching is not configured.
 */
export function createToolBatchHandlers(
  getProvider: (ctx: IPCContext) => ToolBatchProvider | null,
) {
  return {
    tool_batch: async (
      req: { calls: Array<{ tool: string; args: Record<string, unknown> }> },
      ctx: IPCContext,
    ) => {
      const provider = getProvider(ctx);
      if (!provider) {
        throw new Error('Tool batching not available for this session');
      }

      logger.debug('tool_batch', { sessionId: ctx.sessionId, callCount: req.calls.length });

      const results: unknown[] = [];

      for (const call of req.calls) {
        const resolvedArgs = resolveRefs(call.args, results) as Record<string, unknown>;

        try {
          const result = await provider.callTool({
            tool: call.tool,
            arguments: resolvedArgs,
            agentId: ctx.agentId,
            userId: ctx.userId ?? '',
            sessionId: ctx.sessionId,
          });

          if (result.isError) {
            results.push({ $error: typeof result.content === 'string' ? result.content : JSON.stringify(result.content) });
          } else {
            results.push(result.content);
          }
        } catch (err) {
          results.push({ $error: (err as Error).message });
        }
      }

      return { results };
    },
  };
}

// Exported for testing
export { evaluatePath, resolveRefs };
