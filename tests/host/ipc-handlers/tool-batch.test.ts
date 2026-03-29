/**
 * Tests for tool batch IPC handler — __batchRef resolution, pipelining, errors.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  createToolBatchHandlers,
  evaluatePath,
  resolveRefs,
} from '../../../src/host/ipc-handlers/tool-batch.js';
import type { McpToolCall } from '../../../src/providers/mcp/types.js';
import { initLogger } from '../../../src/logger.js';

initLogger({ file: false, level: 'silent' });

// ---------------------------------------------------------------------------
// evaluatePath
// ---------------------------------------------------------------------------

describe('evaluatePath', () => {
  it('should resolve array index', () => {
    expect(evaluatePath([{ id: 'a' }, { id: 'b' }], '[0].id')).toBe('a');
    expect(evaluatePath([{ id: 'a' }, { id: 'b' }], '[1].id')).toBe('b');
  });

  it('should resolve nested properties', () => {
    expect(evaluatePath({ data: { items: [{ name: 'x' }] } }, '.data.items[0].name')).toBe('x');
  });

  it('should return the value itself for empty path', () => {
    expect(evaluatePath('hello', '')).toBe('hello');
  });

  it('should return undefined for missing paths', () => {
    expect(evaluatePath({ a: 1 }, '.b.c')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// resolveRefs
// ---------------------------------------------------------------------------

describe('resolveRefs', () => {
  it('should replace __batchRef with prior result', () => {
    const results = [['team-1', 'team-2'], { name: 'repo' }];
    const resolved = resolveRefs({ __batchRef: 0, path: '[0]' }, results);
    expect(resolved).toBe('team-1');
  });

  it('should recursively resolve refs in nested objects', () => {
    const results = [{ teams: [{ id: 'T1' }] }];
    const args = {
      teamId: { __batchRef: 0, path: '.teams[0].id' },
      limit: 10,
    };
    const resolved = resolveRefs(args, results) as any;
    expect(resolved.teamId).toBe('T1');
    expect(resolved.limit).toBe(10);
  });

  it('should resolve refs in arrays', () => {
    const results = ['a', 'b'];
    const resolved = resolveRefs([{ __batchRef: 0 }, { __batchRef: 1 }], results);
    expect(resolved).toEqual(['a', 'b']);
  });

  it('should pass through non-ref values', () => {
    expect(resolveRefs('hello', [])).toBe('hello');
    expect(resolveRefs(42, [])).toBe(42);
    expect(resolveRefs(null, [])).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// createToolBatchHandlers
// ---------------------------------------------------------------------------

describe('createToolBatchHandlers', () => {
  const ctx = { sessionId: 's', agentId: 'a', userId: 'u' };

  it('should execute independent calls and return results', async () => {
    const calls: McpToolCall[] = [];
    const provider = {
      async callTool(call: McpToolCall) {
        calls.push(call);
        return { content: { tool: call.tool, args: call.arguments } };
      },
    };

    const handlers = createToolBatchHandlers(() => provider);
    const result = await handlers.tool_batch({
      calls: [
        { tool: 'getTeams', args: {} },
        { tool: 'getRepos', args: { org: 'ax' } },
      ],
    }, ctx);

    expect(result.results).toHaveLength(2);
    expect(result.results[0]).toEqual({ tool: 'getTeams', args: {} });
    expect(result.results[1]).toEqual({ tool: 'getRepos', args: { org: 'ax' } });
  });

  it('should resolve __batchRef dependencies between calls', async () => {
    const provider = {
      async callTool(call: McpToolCall) {
        if (call.tool === 'getTeams') {
          return { content: [{ id: 'T1', name: 'Eng' }, { id: 'T2', name: 'Product' }] };
        }
        if (call.tool === 'getIssues') {
          return { content: [{ title: `Issue for ${call.arguments.teamId}` }] };
        }
        return { content: null };
      },
    };

    const handlers = createToolBatchHandlers(() => provider);
    const result = await handlers.tool_batch({
      calls: [
        { tool: 'getTeams', args: {} },
        { tool: 'getIssues', args: { teamId: { __batchRef: 0, path: '[0].id' } } },
      ],
    }, ctx);

    expect(result.results[0]).toEqual([{ id: 'T1', name: 'Eng' }, { id: 'T2', name: 'Product' }]);
    expect(result.results[1]).toEqual([{ title: 'Issue for T1' }]);
  });

  it('should handle errors per-call without aborting the batch', async () => {
    const provider = {
      async callTool(call: McpToolCall) {
        if (call.tool === 'failing') {
          return { content: 'Rate limit exceeded', isError: true };
        }
        return { content: 'ok' };
      },
    };

    const handlers = createToolBatchHandlers(() => provider);
    const result = await handlers.tool_batch({
      calls: [
        { tool: 'failing', args: {} },
        { tool: 'working', args: {} },
      ],
    }, ctx);

    expect(result.results[0]).toEqual({ ok: false, error: 'Rate limit exceeded' });
    expect(result.results[1]).toBe('ok');
  });

  it('should throw when provider is null', async () => {
    const handlers = createToolBatchHandlers(() => null);
    await expect(
      handlers.tool_batch({ calls: [] }, ctx),
    ).rejects.toThrow('not available');
  });

  // ── Unified MCP routing (resolveServer + mcpCallTool) ──

  it('should route unified MCP calls to mcpCallTool', async () => {
    const unifiedCalls: Array<{ url: string; tool: string; args: Record<string, unknown> }> = [];
    const handlers = createToolBatchHandlers({
      getProvider: () => ({
        async callTool(call: McpToolCall) {
          return { content: `default:${call.tool}` };
        },
      }),
      resolveServer: (_agentId, toolName) =>
        toolName.startsWith('slack_') ? 'https://mcp.slack.com/mcp' : undefined,
      mcpCallTool: async (url, tool, args) => {
        unifiedCalls.push({ url, tool, args });
        return { content: `unified:${tool}` };
      },
    });

    const result = await handlers.tool_batch({
      calls: [
        { tool: 'slack_send_message', args: { text: 'hi' } },
        { tool: 'linear_get_issues', args: {} },
      ],
    }, ctx);

    // First call goes to unified MCP
    expect(result.results[0]).toBe('unified:slack_send_message');
    expect(unifiedCalls).toHaveLength(1);
    expect(unifiedCalls[0].url).toBe('https://mcp.slack.com/mcp');
    // Second call goes to default provider
    expect(result.results[1]).toBe('default:linear_get_issues');
  });

  it('should handle unified MCP call errors per-call', async () => {
    const handlers = createToolBatchHandlers({
      getProvider: () => ({
        async callTool() { return { content: 'ok' }; },
      }),
      resolveServer: (_agentId, toolName) =>
        toolName === 'failing_unified' ? 'https://bad.server/mcp' : undefined,
      mcpCallTool: async () => { throw new Error('unified server down'); },
    });

    const result = await handlers.tool_batch({
      calls: [
        { tool: 'failing_unified', args: {} },
        { tool: 'default_tool', args: {} },
      ],
    }, ctx);

    expect(result.results[0]).toEqual({ ok: false, error: 'unified server down' });
    expect(result.results[1]).toBe('ok');
  });

  it('should pass headers from getServerMetaByUrl to mcpCallTool', async () => {
    const mcpCallSpy = vi.fn(async () => ({
      content: 'authed response',
    }));

    const handlers = createToolBatchHandlers({
      getProvider: () => null,
      resolveServer: (_agentId, toolName) =>
        toolName === 'db_query' ? 'https://db.internal/mcp' : undefined,
      mcpCallTool: mcpCallSpy,
      getServerMetaByUrl: (_agentId, url) => url === 'https://db.internal/mcp' ? ({
        source: 'database',
        headers: { Authorization: 'Bearer token123' },
      }) : undefined,
    });

    const result = await handlers.tool_batch({
      calls: [{ tool: 'db_query', args: { sql: 'SELECT 1' } }],
    }, ctx);

    expect(result.results[0]).toBe('authed response');
    expect(mcpCallSpy).toHaveBeenCalledWith(
      'https://db.internal/mcp',
      'db_query',
      { sql: 'SELECT 1' },
      { headers: { Authorization: 'Bearer token123' } },
    );
  });

  it('should call resolveHeaders before passing to mcpCallTool', async () => {
    const mcpCallSpy = vi.fn(async () => ({
      content: 'resolved response',
    }));

    const resolveHeadersSpy = vi.fn(async (h: Record<string, string>) => ({
      ...h,
      Authorization: 'Bearer resolved-token',
    }));

    const handlers = createToolBatchHandlers({
      getProvider: () => null,
      resolveServer: () => 'https://db.internal/mcp',
      mcpCallTool: mcpCallSpy,
      getServerMetaByUrl: (_agentId, url) => url === 'https://db.internal/mcp' ? ({
        source: 'database',
        headers: { Authorization: '{{DB_TOKEN}}' },
      }) : undefined,
      resolveHeaders: resolveHeadersSpy,
    });

    await handlers.tool_batch({
      calls: [{ tool: 'db_query', args: {} }],
    }, ctx);

    expect(resolveHeadersSpy).toHaveBeenCalledWith({ Authorization: '{{DB_TOKEN}}' });
    expect(mcpCallSpy).toHaveBeenCalledWith(
      'https://db.internal/mcp',
      'db_query',
      {},
      { headers: { Authorization: 'Bearer resolved-token' } },
    );
  });

  it('unified path takes priority over deprecated plugin path', async () => {
    const unifiedCallSpy = vi.fn(async () => ({
      content: 'unified response',
    }));
    const pluginCallSpy = vi.fn(async () => ({
      content: 'plugin response',
    }));

    const handlers = createToolBatchHandlers({
      getProvider: () => null,
      resolveServer: () => 'https://unified.server/mcp',
      mcpCallTool: unifiedCallSpy,
      resolvePluginServer: () => 'https://plugin.server/mcp',
      pluginMcpCallTool: pluginCallSpy,
    });

    const result = await handlers.tool_batch({
      calls: [{ tool: 'some_tool', args: {} }],
    }, ctx);

    expect(result.results[0]).toBe('unified response');
    expect(unifiedCallSpy).toHaveBeenCalled();
    expect(pluginCallSpy).not.toHaveBeenCalled();
  });

  it('should not throw when provider is null but mcpCallTool is available', async () => {
    const handlers = createToolBatchHandlers({
      getProvider: () => null,
      resolveServer: () => 'https://server/mcp',
      mcpCallTool: async () => ({ content: 'ok' }),
    });

    const result = await handlers.tool_batch({
      calls: [{ tool: 'some_tool', args: {} }],
    }, ctx);

    expect(result.results[0]).toBe('ok');
  });

  // ── Deprecated plugin MCP routing (backward compat) ──

  it('should route plugin MCP calls to pluginMcpCallTool', async () => {
    const pluginCalls: Array<{ url: string; tool: string; args: Record<string, unknown> }> = [];
    const handlers = createToolBatchHandlers({
      getProvider: () => ({
        async callTool(call: McpToolCall) {
          return { content: `default:${call.tool}` };
        },
      }),
      resolvePluginServer: (_agentId, toolName) =>
        toolName.startsWith('slack_') ? 'https://mcp.slack.com/mcp' : undefined,
      pluginMcpCallTool: async (url, tool, args) => {
        pluginCalls.push({ url, tool, args });
        return { content: `plugin:${tool}` };
      },
    });

    const result = await handlers.tool_batch({
      calls: [
        { tool: 'slack_send_message', args: { text: 'hi' } },
        { tool: 'linear_get_issues', args: {} },
      ],
    }, ctx);

    // First call goes to plugin MCP
    expect(result.results[0]).toBe('plugin:slack_send_message');
    expect(pluginCalls).toHaveLength(1);
    expect(pluginCalls[0].url).toBe('https://mcp.slack.com/mcp');
    // Second call goes to default provider
    expect(result.results[1]).toBe('default:linear_get_issues');
  });

  it('should handle plugin MCP call errors per-call', async () => {
    const handlers = createToolBatchHandlers({
      getProvider: () => ({
        async callTool() { return { content: 'ok' }; },
      }),
      resolvePluginServer: (_agentId, toolName) =>
        toolName === 'failing_plugin' ? 'https://bad.server/mcp' : undefined,
      pluginMcpCallTool: async () => { throw new Error('plugin server down'); },
    });

    const result = await handlers.tool_batch({
      calls: [
        { tool: 'failing_plugin', args: {} },
        { tool: 'default_tool', args: {} },
      ],
    }, ctx);

    expect(result.results[0]).toEqual({ ok: false, error: 'plugin server down' });
    expect(result.results[1]).toBe('ok');
  });

  it('should return error when no default provider for non-plugin tool', async () => {
    const handlers = createToolBatchHandlers({
      getProvider: () => null,
      resolvePluginServer: (_agentId, toolName) =>
        toolName === 'slack_send' ? 'https://mcp.slack.com/mcp' : undefined,
      pluginMcpCallTool: async (_url, tool) => ({ content: `plugin:${tool}` }),
    });

    const result = await handlers.tool_batch({
      calls: [
        { tool: 'slack_send', args: {} },
        { tool: 'unknown_tool', args: {} },
      ],
    }, ctx);

    expect(result.results[0]).toBe('plugin:slack_send');
    expect(result.results[1]).toEqual({ ok: false, error: 'MCP gateway not configured for this tool' });
  });
});
