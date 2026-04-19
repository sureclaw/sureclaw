/**
 * Unified tool dispatch bottleneck for all external tools (MCP + OpenAPI).
 *
 * Both tool_batch IPC (from toolgen scripts) and tool-router.ts (from
 * pi-agent tool_use) call into this single dispatcher. Handles server
 * resolution, header injection, size limits, taint tagging, and errors.
 */

import type { TaintTag } from '../types.js';
import { getLogger } from '../logger.js';

const logger = getLogger().child({ component: 'tool-dispatcher' });

export const DISPATCH_LIMITS = {
  maxResultSizeBytes: 1_048_576,   // 1 MB per result
} as const;

export interface DispatchCall {
  tool: string;
  args: Record<string, unknown>;
}

export interface DispatchContext {
  agentId: string;
  sessionId: string;
  userId: string;
}

export interface DispatchResult {
  content: string;
  isError?: boolean;
  taint?: TaintTag;
}

export interface ToolDispatcherOptions {
  /** Resolve tool name → MCP/API server URL. */
  resolveServer: (agentId: string, toolName: string) => string | undefined;
  /** Execute tool on resolved server. */
  callTool: (
    serverUrl: string,
    toolName: string,
    args: Record<string, unknown>,
    opts?: { headers?: Record<string, string> },
  ) => Promise<{ content: string | Record<string, unknown>; isError?: boolean }>;
  /** Get server metadata for credential resolution. */
  getServerMeta?: (agentId: string, serverUrl: string) =>
    { name?: string; headers?: Record<string, string> } | undefined;
  /** Resolve credential placeholders in headers. */
  resolveHeaders?: (headers: Record<string, string>) => Promise<Record<string, string>>;
  /** Auto-discover auth for servers without explicit headers. Receives the
   *  per-request agentId + userId so the implementation can look up
   *  tuple-keyed skill credentials. */
  authForServer?: (server: {
    name: string;
    url: string;
    agentId: string;
    userId: string;
  }) => Promise<Record<string, string> | undefined>;
}

export class ToolDispatcher {
  constructor(private readonly opts: ToolDispatcherOptions) {}

  async dispatch(call: DispatchCall, ctx: DispatchContext): Promise<DispatchResult> {
    const serverUrl = this.opts.resolveServer(ctx.agentId, call.tool);
    if (!serverUrl) {
      return {
        content: `Unknown tool: "${call.tool}". No MCP server or API endpoint registered for this tool.`,
        isError: true,
      };
    }

    // Resolve auth headers
    let headers: Record<string, string> | undefined;
    try {
      if (this.opts.getServerMeta) {
        const meta = this.opts.getServerMeta(ctx.agentId, serverUrl);
        if (meta?.headers) {
          headers = this.opts.resolveHeaders
            ? await this.opts.resolveHeaders(meta.headers)
            : meta.headers;
        }
        if (!headers && this.opts.authForServer && meta?.name) {
          headers = await this.opts.authForServer({
            name: meta.name,
            url: serverUrl,
            agentId: ctx.agentId,
            userId: ctx.userId,
          });
        }
      }
    } catch {
      // Header resolution failure should not block the tool call
    }

    try {
      const result = await this.opts.callTool(
        serverUrl, call.tool, call.args,
        headers ? { headers } : undefined,
      );

      const content = typeof result.content === 'string'
        ? result.content
        : JSON.stringify(result.content);

      if (Buffer.byteLength(content) > DISPATCH_LIMITS.maxResultSizeBytes) {
        return {
          content: `Tool result too large (>${DISPATCH_LIMITS.maxResultSizeBytes} bytes). Ask for a smaller response.`,
          isError: true,
        };
      }

      return {
        content,
        isError: result.isError,
        taint: { source: `external:${serverUrl}`, trust: 'external' as const, timestamp: new Date() },
      };
    } catch (err) {
      logger.warn('dispatch_error', { tool: call.tool, error: (err as Error).message });
      return {
        content: `Tool call failed: ${(err as Error).message}`,
        isError: true,
      };
    }
  }

  /** Batch dispatch with dependency resolution (for tool_batch IPC). */
  async dispatchBatch(
    calls: DispatchCall[],
    ctx: DispatchContext,
  ): Promise<unknown[]> {
    const results: unknown[] = [];
    for (const call of calls) {
      try {
        const resolved = this.resolveRefs(call.args, results);
        const result = await this.dispatch({ tool: call.tool, args: resolved }, ctx);
        if (result.isError) {
          results.push({ ok: false, error: result.content });
        } else {
          try { results.push(JSON.parse(result.content)); }
          catch { results.push(result.content); }
        }
      } catch (err) {
        results.push({ ok: false, error: (err as Error).message });
      }
    }
    return results;
  }

  /** Resolve __batchRef markers in args using prior results. */
  private resolveRefs(value: unknown, results: unknown[]): Record<string, unknown> {
    return this.deepResolve(value, results) as Record<string, unknown>;
  }

  private deepResolve(value: unknown, results: unknown[]): unknown {
    if (value && typeof value === 'object' && '__batchRef' in (value as Record<string, unknown>)) {
      const ref = value as { __batchRef: number; path?: string };
      if (ref.__batchRef < 0 || ref.__batchRef >= results.length) {
        throw new Error(`Batch ref index ${ref.__batchRef} out of range (${results.length} results available)`);
      }
      const resolved = results[ref.__batchRef];
      if (resolved && typeof resolved === 'object' && 'ok' in (resolved as Record<string, unknown>) && !(resolved as Record<string, unknown>).ok) {
        throw new Error(`Batch ref index ${ref.__batchRef} references a failed call`);
      }
      return ref.path ? this.evaluatePath(resolved, ref.path) : resolved;
    }
    if (Array.isArray(value)) return value.map(v => this.deepResolve(v, results));
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        out[k] = this.deepResolve(v, results);
      }
      return out;
    }
    return value;
  }

  private evaluatePath(value: unknown, path: string): unknown {
    if (!path) return value;
    const segments = path.match(/\.([^.[]+)|\[(\d+)\]/g);
    if (!segments) return value;
    let current: any = value;
    for (const seg of segments) {
      if (current == null) return undefined;
      if (seg.startsWith('[')) {
        current = (current as unknown[])[parseInt(seg.slice(1, -1))];
      } else {
        current = (current as Record<string, unknown>)[seg.slice(1)];
      }
    }
    return current;
  }
}
