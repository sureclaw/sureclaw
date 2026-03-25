/**
 * Tool router for the in-process fast path.
 *
 * Routes tool calls to MCP provider, lazy file I/O, or sandbox escalation.
 * All per-turn state lives in function arguments — no module-level mutable state.
 */

import { safePath } from '../utils/safe-path.js';
import type { McpProvider, McpToolResult } from '../providers/mcp/types.js';
import { McpAuthRequiredError } from '../providers/mcp/types.js';
import type { TaintTag, ProviderRegistry } from '../types.js';
import type { EventBus } from './event-bus.js';

// ---------------------------------------------------------------------------
// Resource limits (Phase 2 launch-blocking)
// ---------------------------------------------------------------------------

export const FAST_PATH_LIMITS = {
  maxToolCallsPerTurn: 50,
  maxTurnDurationMs: 300_000,          // 5 minutes
  maxToolResultSizeBytes: 1_048_576,   // 1 MB per tool result
  maxTotalContextBytes: 10_485_760,    // 10 MB total in-memory
} as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResult {
  toolUseId: string;
  content: string;
  isError?: boolean;
  taint?: TaintTag;
}

export interface ToolRouterContext {
  requestId: string;
  agentId: string;
  userId: string;
  sessionId: string;
  mcp?: McpProvider;
  eventBus?: EventBus;
  workspaceBasePath: string;
  /** Accumulated byte size of all tool results in the current turn. */
  totalBytes: number;
  /** Number of tool calls made so far in the current turn. */
  callCount: number;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export async function routeToolCall(
  call: ToolCall,
  ctx: ToolRouterContext,
): Promise<ToolResult> {
  // Enforce per-turn limits
  ctx.callCount++;
  if (ctx.callCount > FAST_PATH_LIMITS.maxToolCallsPerTurn) {
    return {
      toolUseId: call.id,
      content: `Tool call limit exceeded (max ${FAST_PATH_LIMITS.maxToolCallsPerTurn} per turn).`,
      isError: true,
    };
  }

  switch (call.name) {
    case 'file_read':
      return handleFileRead(call, ctx);
    case 'file_write':
      return handleFileWrite(call, ctx);
    case 'request_sandbox':
      return handleRequestSandbox(call, ctx);
    default:
      return handleMcpToolCall(call, ctx);
  }
}

// ---------------------------------------------------------------------------
// MCP tool calls
// ---------------------------------------------------------------------------

async function handleMcpToolCall(
  call: ToolCall,
  ctx: ToolRouterContext,
): Promise<ToolResult> {
  if (!ctx.mcp) {
    return {
      toolUseId: call.id,
      content: 'MCP gateway not configured. This tool is unavailable.',
      isError: true,
    };
  }

  try {
    const result: McpToolResult = await ctx.mcp.callTool({
      tool: call.name,
      arguments: call.args,
      agentId: ctx.agentId,
      userId: ctx.userId,
      sessionId: ctx.sessionId,
    });

    const content = typeof result.content === 'string'
      ? result.content
      : JSON.stringify(result.content);

    // Enforce per-result size limit
    if (Buffer.byteLength(content) > FAST_PATH_LIMITS.maxToolResultSizeBytes) {
      return {
        toolUseId: call.id,
        content: `Tool result too large (>${FAST_PATH_LIMITS.maxToolResultSizeBytes} bytes). Ask for a smaller response.`,
        isError: true,
      };
    }

    ctx.totalBytes += Buffer.byteLength(content);
    if (ctx.totalBytes > FAST_PATH_LIMITS.maxTotalContextBytes) {
      return {
        toolUseId: call.id,
        content: `Total context size limit exceeded (>${FAST_PATH_LIMITS.maxTotalContextBytes} bytes). Reduce tool usage.`,
        isError: true,
      };
    }

    return {
      toolUseId: call.id,
      content,
      isError: result.isError,
      taint: result.taint,
    };
  } catch (err) {
    if (err instanceof McpAuthRequiredError) {
      // Notify admin asynchronously — do NOT block the turn
      ctx.eventBus?.emit({
        type: 'credential.missing',
        requestId: ctx.requestId,
        timestamp: Date.now(),
        data: {
          agentId: ctx.agentId,
          app: err.status.app,
          authType: err.status.authType,
          triggeredBy: ctx.userId,
        },
      });
      return {
        toolUseId: call.id,
        content: `Not connected to ${err.status.app}. An admin needs to configure this integration.`,
        isError: true,
      };
    }
    return {
      toolUseId: call.id,
      content: `Tool call failed: ${(err as Error).message}`,
      isError: true,
    };
  }
}

// ---------------------------------------------------------------------------
// File I/O (lazy GCS access via safePath)
// ---------------------------------------------------------------------------

function scopeSubdir(scope: string, ctx: ToolRouterContext): string | undefined {
  switch (scope) {
    case 'agent':   return `agent/${ctx.agentId}`;
    case 'user':    return `user/${ctx.userId}`;
    case 'session': return `session/${ctx.sessionId}`;
    default:        return undefined;
  }
}

async function handleFileRead(
  call: ToolCall,
  ctx: ToolRouterContext,
): Promise<ToolResult> {
  const path = call.args.path as string | undefined;
  const scope = call.args.scope as string | undefined;

  const subdir = scope ? scopeSubdir(scope, ctx) : undefined;
  if (!path || !scope || !subdir) {
    return { toolUseId: call.id, content: 'Invalid arguments: path and scope (agent|user|session) required.', isError: true };
  }

  try {
    const resolvedPath = safePath(ctx.workspaceBasePath, subdir, path);
    const { readFile } = await import('node:fs/promises');
    const data = await readFile(resolvedPath, 'utf-8');

    if (Buffer.byteLength(data) > FAST_PATH_LIMITS.maxToolResultSizeBytes) {
      return { toolUseId: call.id, content: 'File too large to read in fast path. Request sandbox for large files.', isError: true };
    }

    const nextTotalBytes = ctx.totalBytes + Buffer.byteLength(data);
    if (nextTotalBytes > FAST_PATH_LIMITS.maxTotalContextBytes) {
      return {
        toolUseId: call.id,
        content: `Total context size limit exceeded (>${FAST_PATH_LIMITS.maxTotalContextBytes} bytes). Request sandbox for large files.`,
        isError: true,
      };
    }
    ctx.totalBytes = nextTotalBytes;
    return {
      toolUseId: call.id,
      content: data,
      taint: { source: `file:${scope}/${path}`, trust: 'external', timestamp: new Date() },
    };
  } catch (err) {
    return { toolUseId: call.id, content: `File read failed: ${(err as Error).message}`, isError: true };
  }
}

async function handleFileWrite(
  call: ToolCall,
  ctx: ToolRouterContext,
): Promise<ToolResult> {
  const path = call.args.path as string | undefined;
  const scope = call.args.scope as string | undefined;
  const content = call.args.content as string | undefined;

  const writeSubdir = scope ? scopeSubdir(scope, ctx) : undefined;
  if (!path || !scope || !writeSubdir || content === undefined) {
    return { toolUseId: call.id, content: 'Invalid arguments: path, scope, and content required.', isError: true };
  }

  try {
    const resolvedPath = safePath(ctx.workspaceBasePath, writeSubdir, path);
    const { writeFile, mkdir } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    await mkdir(dirname(resolvedPath), { recursive: true });
    await writeFile(resolvedPath, content, 'utf-8');
    return { toolUseId: call.id, content: `File written: ${scope}/${path}` };
  } catch (err) {
    return { toolUseId: call.id, content: `File write failed: ${(err as Error).message}`, isError: true };
  }
}

// ---------------------------------------------------------------------------
// Sandbox escalation
// ---------------------------------------------------------------------------

async function handleRequestSandbox(
  call: ToolCall,
  ctx: ToolRouterContext,
): Promise<ToolResult> {
  const reason = call.args.reason as string | undefined;
  const ttl = (call.args.ttl as number) ?? 1800;

  // Emit permission request event — the UI or Slack will display an approval dialog
  ctx.eventBus?.emit({
    type: 'permission.requested',
    requestId: ctx.sessionId,
    timestamp: Date.now(),
    data: {
      permission: 'sandbox',
      agentId: ctx.agentId,
      reason: reason ?? 'Agent requested sandbox access',
      ttl,
      sessionId: ctx.sessionId,
    },
  });

  return {
    toolUseId: call.id,
    content: JSON.stringify({
      status: 'pending',
      message: 'Sandbox access requested. The user will be asked to approve. Your next turn will run in the sandbox if approved.',
    }),
  };
}
