/**
 * Cap'n Web RPC server — exposes MCP tools as typed RPC methods.
 *
 * Instead of a separate socket, this registers as an internal route on the
 * existing web proxy. The agent reaches it via normal HTTP through the proxy:
 *
 *   Agent: POST http://ax-capnweb/rpc → proxy → internal route → Cap'n Web handler
 *
 * Cap'n Web's HTTP batch mode batches all pending calls (including pipelined
 * dependent calls) into a single HTTP request-response round trip.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { RpcTarget } from 'capnweb';
import { nodeHttpBatchRpcResponse } from 'capnweb';
import type { McpProvider, McpToolSchema, McpToolCall } from '../../providers/mcp/types.js';
import { getLogger } from '../../logger.js';

const logger = getLogger().child({ component: 'capnweb' });

/** Hostname used by the agent to reach the Cap'n Web RPC endpoint via the proxy. */
export const CAPNWEB_INTERNAL_HOST = 'ax-capnweb';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CapnWebHandlerOptions {
  /** MCP provider for executing tool calls. */
  mcpProvider: McpProvider;
  /** Available MCP tools (call mcpProvider.listTools() before creating). */
  tools: McpToolSchema[];
  /** Session context for tool call attribution. */
  context: {
    agentId: string;
    userId: string;
    sessionId: string;
  };
}

// ---------------------------------------------------------------------------
// Dynamic RpcTarget creation
// ---------------------------------------------------------------------------

/**
 * Creates an RpcTarget with a prototype method for each MCP tool.
 *
 * Cap'n Web only exposes prototype methods over RPC (not instance properties),
 * so we dynamically build a class whose prototype has one method per tool.
 *
 * Tool naming: methods use the original MCP tool name (e.g. 'getIssues').
 * The codegen layer maps clean per-file exports to these names.
 */
export function createMcpToolsTarget(
  mcpProvider: McpProvider,
  tools: McpToolSchema[],
  ctx: { agentId: string; userId: string; sessionId: string },
): RpcTarget {
  // Build a new class so each tool becomes a prototype method.
  const ToolsTarget = class extends RpcTarget {
    // Allow dynamic string keys.
    [method: string]: unknown;
  };

  for (const tool of tools) {
    // Arrow function captures mcpProvider and ctx via closure.
    // eslint-disable-next-line @typescript-eslint/no-loop-func
    ToolsTarget.prototype[tool.name] = async function (
      params: Record<string, unknown> | undefined,
    ) {
      logger.debug('capnweb_tool_call', { tool: tool.name });
      const call: McpToolCall = {
        tool: tool.name,
        arguments: params ?? {},
        agentId: ctx.agentId,
        userId: ctx.userId,
        sessionId: ctx.sessionId,
      };
      const result = await mcpProvider.callTool(call);
      if (result.isError) {
        throw new Error(
          typeof result.content === 'string'
            ? result.content
            : JSON.stringify(result.content),
        );
      }
      return result.content;
    };
  }

  return new ToolsTarget();
}

// ---------------------------------------------------------------------------
// HTTP handler (registered as proxy internal route)
// ---------------------------------------------------------------------------

/**
 * Creates an HTTP request handler for Cap'n Web batch RPC.
 *
 * Register this as an internal route on the web proxy:
 * ```ts
 * const capnwebHandler = createCapnWebHandler({ mcpProvider, tools, context });
 * startWebProxy({ ..., internalRoutes: new Map([['ax-capnweb', capnwebHandler]]) });
 * ```
 *
 * The agent then calls tools via:
 * ```ts
 * const api = newHttpBatchRpcSession('http://ax-capnweb/rpc');
 * ```
 */
export function createCapnWebHandler(
  opts: CapnWebHandlerOptions,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const target = createMcpToolsTarget(opts.mcpProvider, opts.tools, opts.context);

  logger.info('capnweb_handler_created', { toolCount: opts.tools.length });

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    logger.debug('capnweb_batch_request');
    try {
      await nodeHttpBatchRpcResponse(req, res, target);
    } catch (err) {
      logger.error('capnweb_batch_error', { error: (err as Error).message });
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Internal Cap\'n Web RPC error');
      }
    }
  };
}
