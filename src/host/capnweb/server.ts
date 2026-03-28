/**
 * Cap'n Web RPC server — exposes MCP tools as typed RPC methods.
 *
 * The host creates a Unix socket server. When the sandboxed agent connects,
 * a Cap'n Web RpcSession is established with an RpcTarget whose methods
 * wrap McpProvider.callTool(). Promise pipelining lets the agent batch
 * multiple tool calls into fewer round trips.
 *
 * Socket path: /tmp/.ax-ipc-<uuid>/capnweb.sock (alongside proxy.sock)
 */

import { createServer, type Server, type Socket } from 'node:net';
import { RpcTarget, RpcSession } from 'capnweb';
import { SocketRpcTransport } from '../../capnweb/transport.js';
import type { McpProvider, McpToolSchema, McpToolCall } from '../../providers/mcp/types.js';
import { getLogger } from '../../logger.js';

const logger = getLogger().child({ component: 'capnweb' });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CapnWebServerOptions {
  /** Unix socket path for the Cap'n Web RPC server. */
  socketPath: string;
  /** MCP provider for executing tool calls. */
  mcpProvider: McpProvider;
  /** Available MCP tools (call mcpProvider.listTools() before creating the server). */
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
// Server
// ---------------------------------------------------------------------------

export class CapnWebServer {
  private server: Server | null = null;
  private sessions = new Set<RpcSession<unknown>>();
  private target: RpcTarget;

  constructor(private readonly opts: CapnWebServerOptions) {
    this.target = createMcpToolsTarget(
      opts.mcpProvider,
      opts.tools,
      opts.context,
    );
  }

  /** Start listening on the Unix socket. */
  async start(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.server = createServer((socket: Socket) => this.onConnection(socket));
      this.server.on('error', reject);
      this.server.listen(this.opts.socketPath, () => {
        logger.info('capnweb_server_started', {
          socketPath: this.opts.socketPath,
          toolCount: this.opts.tools.length,
        });
        resolve();
      });
    });
  }

  private onConnection(socket: Socket): void {
    const transport = new SocketRpcTransport(socket);
    const session = new RpcSession(transport as any, this.target);
    this.sessions.add(session);

    socket.on('close', () => {
      this.sessions.delete(session);
    });

    logger.debug('capnweb_client_connected');
  }

  /** Gracefully shut down: drain all sessions and close the server. */
  async stop(): Promise<void> {
    const drains = [...this.sessions].map((s) =>
      s.drain().catch(() => {}),
    );
    await Promise.all(drains);
    this.sessions.clear();

    return new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
  }

  /** The RpcTarget instance (useful for testing). */
  get rpcTarget(): RpcTarget {
    return this.target;
  }
}
