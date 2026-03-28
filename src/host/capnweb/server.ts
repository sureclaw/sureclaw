/**
 * Cap'n Web RPC target — exposes MCP tools as typed RPC methods.
 *
 * Creates an RpcTarget whose methods wrap McpProvider.callTool().
 * The target is used by the capnweb_batch IPC handler (see ipc-handlers/capnweb.ts)
 * which processes Cap'n Web batches over the existing IPC socket.
 */

import { RpcTarget } from 'capnweb';
import type { McpProvider, McpToolSchema, McpToolCall } from '../../providers/mcp/types.js';
import { getLogger } from '../../logger.js';

const logger = getLogger().child({ component: 'capnweb' });

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
    [method: string]: unknown;
  };

  for (const tool of tools) {
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
