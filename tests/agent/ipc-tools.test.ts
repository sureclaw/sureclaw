import { describe, test, expect, vi } from 'vitest';
import { createIPCTools } from '../../src/agent/ipc-tools.js';
import type { AgentTool } from '@mariozechner/pi-agent-core';

// Mock IPC client
function createMockClient() {
  return {
    call: vi.fn(async (req: Record<string, unknown>) => {
      return { ok: true, action: req.action, ...req };
    }),
  };
}

describe('ipc-tools', () => {
  function findTool(tools: AgentTool[], name: string): AgentTool {
    const tool = tools.find((t) => t.name === name);
    if (!tool) throw new Error(`Tool not found: ${name}`);
    return tool;
  }

  test('exports memory, web, and audit tools', () => {
    const client = createMockClient();
    const tools = createIPCTools(client as any);
    const names = tools.map((t) => t.name);
    expect(names).toContain('memory_write');
    expect(names).toContain('memory_query');
    expect(names).toContain('memory_read');
    expect(names).toContain('memory_delete');
    expect(names).toContain('memory_list');
    expect(names).toContain('web_fetch');
    expect(names).toContain('web_search');
    expect(names).toContain('audit_query');
  });

  test('memory_write sends IPC call with correct action', async () => {
    const client = createMockClient();
    const tools = createIPCTools(client as any);
    const tool = findTool(tools, 'memory_write');
    await tool.execute('tc1', { scope: 'test', content: 'hello', tags: ['a'] });
    expect(client.call).toHaveBeenCalledWith({
      action: 'memory_write',
      scope: 'test',
      content: 'hello',
      tags: ['a'],
    });
  });

  test('memory_query sends IPC call with correct action', async () => {
    const client = createMockClient();
    const tools = createIPCTools(client as any);
    const tool = findTool(tools, 'memory_query');
    await tool.execute('tc2', { scope: 'test', query: 'search term', limit: 5 });
    expect(client.call).toHaveBeenCalledWith({
      action: 'memory_query',
      scope: 'test',
      query: 'search term',
      limit: 5,
    });
  });

  test('web_fetch sends IPC call with correct action', async () => {
    const client = createMockClient();
    const tools = createIPCTools(client as any);
    const tool = findTool(tools, 'web_fetch');
    await tool.execute('tc3', { url: 'https://example.com' });
    expect(client.call).toHaveBeenCalledWith({
      action: 'web_fetch',
      url: 'https://example.com',
    });
  });

  test('returns IPC response as text content', async () => {
    const client = createMockClient();
    client.call.mockResolvedValueOnce({ ok: true, data: 'response data' });
    const tools = createIPCTools(client as any);
    const tool = findTool(tools, 'web_search');
    const result = await tool.execute('tc5', { query: 'test' });
    expect(result.content[0]).toEqual({
      type: 'text',
      text: JSON.stringify({ ok: true, data: 'response data' }),
    });
  });

  test('handles IPC errors gracefully', async () => {
    const client = createMockClient();
    client.call.mockRejectedValueOnce(new Error('IPC connection lost'));
    const tools = createIPCTools(client as any);
    const tool = findTool(tools, 'memory_list');
    const result = await tool.execute('tc6', { scope: 'test' });
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).toMatch(/error|failed/i);
  });

  test('exports identity_write tool (no identity_propose)', () => {
    const client = createMockClient();
    const tools = createIPCTools(client as any);
    const names = tools.map((t) => t.name);
    expect(names).toContain('identity_write');
    expect(names).not.toContain('identity_propose');
  });

  test('identity_write sends IPC call with correct action', async () => {
    const client = createMockClient();
    const tools = createIPCTools(client as any);
    const tool = findTool(tools, 'identity_write');
    await tool.execute('tc7', {
      file: 'SOUL.md',
      content: '# Soul\nI am helpful.',
      reason: 'User asked',
      origin: 'user_request',
    });
    expect(client.call).toHaveBeenCalledWith({
      action: 'identity_write',
      file: 'SOUL.md',
      content: '# Soul\nI am helpful.',
      reason: 'User asked',
      origin: 'user_request',
    });
  });

  test('identity_write has updated description mentioning taint-aware behavior', () => {
    const client = createMockClient();
    const tools = createIPCTools(client as any);
    const tool = findTool(tools, 'identity_write');
    expect(tool.description).toContain('Auto-applied');
    expect(tool.description).toContain('queued');
    expect(tool.description).toContain('audited');
  });

  test('exports user_write tool', () => {
    const client = createMockClient();
    const tools = createIPCTools(client as any);
    const names = tools.map((t) => t.name);
    expect(names).toContain('user_write');
  });

  test('user_write sends IPC call with userId from options', async () => {
    const client = createMockClient();
    const tools = createIPCTools(client as any, { userId: 'U12345' });
    const tool = findTool(tools, 'user_write');
    await tool.execute('tc8', {
      content: '# User prefs\nLikes dark mode',
      reason: 'Observed preference',
      origin: 'agent_initiated',
    });
    expect(client.call).toHaveBeenCalledWith({
      action: 'user_write',
      content: '# User prefs\nLikes dark mode',
      reason: 'Observed preference',
      origin: 'agent_initiated',
      userId: 'U12345',
    });
  });

  test('total tool count is 10', () => {
    const client = createMockClient();
    const tools = createIPCTools(client as any);
    expect(tools.length).toBe(10);
  });
});
