/**
 * IPC handler for batched tool execution with dependency pipelining.
 *
 * The agent sends an ordered array of tool calls. Each call's args may
 * contain { __batchRef: N, path: "[0].id" } references to prior results.
 * The host executes calls in order, substituting refs with real values.
 *
 * One IPC round trip for N tool calls, including dependent chains.
 */

import type { McpProvider, McpToolCall, McpToolSchema } from '../../providers/mcp/types.js';
import type { IPCContext } from '../ipc-server.js';
import { getLogger } from '../../logger.js';

const logger = getLogger().child({ component: 'tool-batch' });

// ---------------------------------------------------------------------------
// __batchRef resolution
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
 * Deep-resolve { __batchRef, path } markers in args using prior results.
 */
function resolveRefs(value: unknown, results: unknown[]): unknown {
  if (value && typeof value === 'object' && '__batchRef' in (value as any)) {
    const ref = value as { __batchRef: number; path?: string };
    const idx = ref.__batchRef;
    if (idx < 0 || idx >= results.length) {
      throw new Error(`Batch ref index ${idx} out of range (${results.length} results available)`);
    }
    const resolved = results[idx];
    if (resolved && typeof resolved === 'object' && 'ok' in (resolved as any) && !(resolved as any).ok) {
      throw new Error(`Batch ref index ${idx} references a failed call`);
    }
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

/** Callback for executing a tool call on a plugin MCP server (by URL). */
export type PluginMcpCallTool = (
  serverUrl: string,
  toolName: string,
  args: Record<string, unknown>,
) => Promise<{ content: string | Record<string, unknown>; isError?: boolean }>;

export interface ToolBatchOptions {
  /** Returns the MCP provider for executing tools in this session. Returns null if not configured. */
  getProvider: (ctx: IPCContext) => ToolBatchProvider | null;
  /** Resolve a tool name to a plugin MCP server URL (returns undefined for non-plugin tools). */
  resolvePluginServer?: (agentId: string, toolName: string) => string | undefined;
  /** Execute a tool call on a plugin MCP server (by URL). */
  pluginMcpCallTool?: PluginMcpCallTool;
}

/**
 * Create tool_batch IPC handler.
 *
 * @param getProvider - Returns the MCP provider for executing tools in this session.
 *   Returns null if tool batching is not configured.
 */
export function createToolBatchHandlers(
  getProviderOrOpts: ((ctx: IPCContext) => ToolBatchProvider | null) | ToolBatchOptions,
) {
  const opts: ToolBatchOptions = typeof getProviderOrOpts === 'function'
    ? { getProvider: getProviderOrOpts }
    : getProviderOrOpts;

  return {
    tool_batch: async (
      req: { calls: Array<{ tool: string; args: Record<string, unknown> }> },
      ctx: IPCContext,
    ) => {
      const provider = opts.getProvider(ctx);
      if (!provider && !opts.pluginMcpCallTool) {
        throw new Error('Tool batching not available for this session');
      }

      logger.debug('tool_batch', { sessionId: ctx.sessionId, callCount: req.calls.length });

      const results: unknown[] = [];

      for (const call of req.calls) {
        const resolvedArgs = resolveRefs(call.args, results) as Record<string, unknown>;

        try {
          // Check if this tool belongs to a plugin MCP server
          const pluginUrl = opts.resolvePluginServer?.(ctx.agentId, call.tool);
          if (pluginUrl && opts.pluginMcpCallTool) {
            const result = await opts.pluginMcpCallTool(pluginUrl, call.tool, resolvedArgs);
            if (result.isError) {
              results.push({ ok: false, error: typeof result.content === 'string' ? result.content : JSON.stringify(result.content) });
            } else {
              results.push(result.content);
            }
            continue;
          }

          // Fall through to default MCP provider
          if (!provider) {
            results.push({ ok: false, error: 'MCP gateway not configured for this tool' });
            continue;
          }

          const result = await provider.callTool({
            tool: call.tool,
            arguments: resolvedArgs,
            agentId: ctx.agentId,
            userId: ctx.userId ?? '',
            sessionId: ctx.sessionId,
          });

          if (result.isError) {
            results.push({ ok: false, error: typeof result.content === 'string' ? result.content : JSON.stringify(result.content) });
          } else {
            results.push(result.content);
          }
        } catch (err) {
          results.push({ ok: false, error: (err as Error).message });
        }
      }

      return { results };
    },
  };
}

// Exported for testing
export { evaluatePath, resolveRefs };
