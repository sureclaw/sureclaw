import { describe, it, expect, vi } from 'vitest';
import { routeToolCall, FAST_PATH_LIMITS, type ToolRouterContext } from '../../src/host/tool-router.js';
import type { McpProvider, McpToolResult } from '../../src/providers/mcp/types.js';
import { McpAuthRequiredError } from '../../src/providers/mcp/types.js';
import type { EventBus } from '../../src/host/event-bus.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(overrides: Partial<ToolRouterContext> = {}): ToolRouterContext {
  return {
    requestId: 'req-1',
    agentId: 'agent-1',
    userId: 'user-1',
    sessionId: 'sess-1',
    workspaceBasePath: '/tmp/ax-test-ws',
    totalBytes: 0,
    callCount: 0,
    ...overrides,
  };
}

function mockMcp(handler: McpProvider['callTool']): McpProvider {
  return {
    async listTools() { return []; },
    callTool: handler,
    async credentialStatus() { return { available: true, app: 'test', authType: 'api_key' as const }; },
    async storeCredential() {},
    async listApps() { return []; },
  };
}

// ---------------------------------------------------------------------------
// MCP tool routing
// ---------------------------------------------------------------------------

describe('routeToolCall — MCP', () => {
  it('routes to MCP provider and returns tainted result', async () => {
    const mcp = mockMcp(async () => ({
      content: 'issues data',
      isError: false,
      taint: { source: 'mcp:linear', trust: 'external' as const, timestamp: new Date() },
    }));

    const ctx = makeCtx({ mcp });
    const result = await routeToolCall(
      { id: 'tc-1', name: 'linear_get_issues', args: { query: 'bugs' } },
      ctx,
    );

    expect(result.content).toBe('issues data');
    expect(result.isError).toBe(false);
    expect(result.taint?.trust).toBe('external');
    expect(ctx.callCount).toBe(1);
  });

  it('returns error when MCP not configured', async () => {
    const ctx = makeCtx({ mcp: undefined });
    const result = await routeToolCall(
      { id: 'tc-1', name: 'linear_get_issues', args: {} },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('not configured');
  });

  it('handles McpAuthRequiredError', async () => {
    const emitSpy = vi.fn();
    const eventBus: EventBus = {
      emit: emitSpy,
      subscribe: () => () => {},
      subscribeRequest: () => () => {},
      listenerCount: () => 0,
    };

    const mcp = mockMcp(async () => {
      throw new McpAuthRequiredError({ available: false, app: 'linear', authType: 'api_key' });
    });

    const ctx = makeCtx({ mcp, eventBus });
    const result = await routeToolCall(
      { id: 'tc-1', name: 'linear_get_issues', args: {} },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Not connected to linear');
    expect(emitSpy).toHaveBeenCalledWith(expect.objectContaining({
      type: 'credential.missing',
      data: expect.objectContaining({ app: 'linear' }),
    }));
  });

  it('handles generic MCP errors', async () => {
    const mcp = mockMcp(async () => { throw new Error('gateway timeout'); });
    const ctx = makeCtx({ mcp });
    const result = await routeToolCall(
      { id: 'tc-1', name: 'some_tool', args: {} },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('gateway timeout');
  });
});

// ---------------------------------------------------------------------------
// Resource limits
// ---------------------------------------------------------------------------

describe('routeToolCall — limits', () => {
  it('enforces max tool calls per turn', async () => {
    const mcp = mockMcp(async () => ({
      content: 'ok',
      taint: { source: 'mcp:t', trust: 'external' as const, timestamp: new Date() },
    }));

    const ctx = makeCtx({ mcp, callCount: FAST_PATH_LIMITS.maxToolCallsPerTurn });

    const result = await routeToolCall(
      { id: 'tc-over', name: 'some_tool', args: {} },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('limit exceeded');
  });

  it('enforces max tool result size', async () => {
    const bigContent = 'x'.repeat(FAST_PATH_LIMITS.maxToolResultSizeBytes + 1);
    const mcp = mockMcp(async () => ({
      content: bigContent,
      taint: { source: 'mcp:t', trust: 'external' as const, timestamp: new Date() },
    }));

    const ctx = makeCtx({ mcp });
    const result = await routeToolCall(
      { id: 'tc-big', name: 'some_tool', args: {} },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('too large');
  });

  it('enforces total context size', async () => {
    const mcp = mockMcp(async () => ({
      content: 'ok',
      taint: { source: 'mcp:t', trust: 'external' as const, timestamp: new Date() },
    }));

    const ctx = makeCtx({ mcp, totalBytes: FAST_PATH_LIMITS.maxTotalContextBytes });

    const result = await routeToolCall(
      { id: 'tc-total', name: 'some_tool', args: {} },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('context size limit');
  });
});

// ---------------------------------------------------------------------------
// Sandbox escalation
// ---------------------------------------------------------------------------

describe('routeToolCall — request_sandbox', () => {
  it('emits permission.requested event and returns pending', async () => {
    const emitSpy = vi.fn();
    const eventBus: EventBus = {
      emit: emitSpy,
      subscribe: () => () => {},
      subscribeRequest: () => () => {},
      listenerCount: () => 0,
    };

    const ctx = makeCtx({ eventBus });
    const result = await routeToolCall(
      { id: 'tc-sb', name: 'request_sandbox', args: { reason: 'need git', ttl: 1800 } },
      ctx,
    );

    const parsed = JSON.parse(result.content);
    expect(parsed.status).toBe('pending');
    expect(emitSpy).toHaveBeenCalledWith(expect.objectContaining({
      type: 'permission.requested',
      data: expect.objectContaining({
        permission: 'sandbox',
        reason: 'need git',
        ttl: 1800,
      }),
    }));
  });
});

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

describe('routeToolCall — file_read', () => {
  it('returns error for missing args', async () => {
    const ctx = makeCtx();
    const result = await routeToolCall(
      { id: 'tc-fr', name: 'file_read', args: {} },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Invalid arguments');
  });

  it('returns error for invalid scope', async () => {
    const ctx = makeCtx();
    const result = await routeToolCall(
      { id: 'tc-fr', name: 'file_read', args: { path: 'test.txt', scope: 'invalid' } },
      ctx,
    );
    expect(result.isError).toBe(true);
  });
});

describe('routeToolCall — file_write', () => {
  it('returns error for missing content', async () => {
    const ctx = makeCtx();
    const result = await routeToolCall(
      { id: 'tc-fw', name: 'file_write', args: { path: 'test.txt', scope: 'agent' } },
      ctx,
    );
    expect(result.isError).toBe(true);
  });
});
