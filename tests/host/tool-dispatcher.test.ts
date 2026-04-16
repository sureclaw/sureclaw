// tests/host/tool-dispatcher.test.ts
import { describe, it, expect, vi } from 'vitest';
import { ToolDispatcher } from '../../src/host/tool-dispatcher.js';
import { initLogger } from '../../src/logger.js';

initLogger({ file: false, level: 'silent' });

describe('ToolDispatcher', () => {
  it('dispatches to MCP server when resolver finds a match', async () => {
    const callTool = vi.fn().mockResolvedValue({ content: '{"ok":true}' });
    const dispatcher = new ToolDispatcher({
      resolveServer: (_agentId, toolName) =>
        toolName === 'linear_list_issues' ? 'http://mcp.linear' : undefined,
      callTool,
    });

    const result = await dispatcher.dispatch(
      { tool: 'linear_list_issues', args: { limit: 5 } },
      { agentId: 'a1', sessionId: 's1', userId: 'u1' },
    );

    expect(callTool).toHaveBeenCalledWith(
      'http://mcp.linear',
      'linear_list_issues',
      { limit: 5 },
      undefined,
    );
    expect(result.content).toBe('{"ok":true}');
    expect(result.isError).toBeFalsy();
  });

  it('returns error for unknown tools', async () => {
    const dispatcher = new ToolDispatcher({
      resolveServer: () => undefined,
      callTool: vi.fn(),
    });

    const result = await dispatcher.dispatch(
      { tool: 'nonexistent', args: {} },
      { agentId: 'a1', sessionId: 's1', userId: 'u1' },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('nonexistent');
  });

  it('enforces per-result size limit', async () => {
    const bigContent = 'x'.repeat(2_000_000);
    const dispatcher = new ToolDispatcher({
      resolveServer: () => 'http://mcp.test',
      callTool: vi.fn().mockResolvedValue({ content: bigContent }),
    });

    const result = await dispatcher.dispatch(
      { tool: 'big_tool', args: {} },
      { agentId: 'a1', sessionId: 's1', userId: 'u1' },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('too large');
  });

  it('taint-tags all results as external', async () => {
    const dispatcher = new ToolDispatcher({
      resolveServer: () => 'http://mcp.test',
      callTool: vi.fn().mockResolvedValue({ content: '{}' }),
    });

    const result = await dispatcher.dispatch(
      { tool: 'some_tool', args: {} },
      { agentId: 'a1', sessionId: 's1', userId: 'u1' },
    );

    expect(result.taint).toBeDefined();
    expect(result.taint?.trust).toBe('external');
  });

  it('catches handler errors and returns error result', async () => {
    const dispatcher = new ToolDispatcher({
      resolveServer: () => 'http://mcp.test',
      callTool: vi.fn().mockRejectedValue(new Error('connection refused')),
    });

    const result = await dispatcher.dispatch(
      { tool: 'failing_tool', args: {} },
      { agentId: 'a1', sessionId: 's1', userId: 'u1' },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('connection refused');
  });
});
