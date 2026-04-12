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

  test('exports consolidated tools (memory, web, audit, etc.)', () => {
    const client = createMockClient();
    const tools = createIPCTools(client as any);
    const names = tools.map((t) => t.name);
    expect(names).toContain('memory');
    expect(names).toContain('web');
    expect(names).toContain('audit');
    expect(names).toContain('identity');
    expect(names).toContain('agent');

  });

  test('memory write sends IPC call with correct action', async () => {
    const client = createMockClient();
    const tools = createIPCTools(client as any);
    const tool = findTool(tools, 'memory');
    await tool.execute('tc1', { type: 'write', scope: 'test', content: 'hello', tags: ['a'] });
    expect(client.call).toHaveBeenCalledWith({
      action: 'memory_write',
      scope: 'test',
      content: 'hello',
      tags: ['a'],
    }, undefined);
  });

  test('memory query sends IPC call with correct action', async () => {
    const client = createMockClient();
    const tools = createIPCTools(client as any);
    const tool = findTool(tools, 'memory');
    await tool.execute('tc2', { type: 'query', scope: 'test', query: 'search term', limit: 5 });
    expect(client.call).toHaveBeenCalledWith({
      action: 'memory_query',
      scope: 'test',
      query: 'search term',
      limit: 5,
    }, undefined);
  });

  test('web fetch sends IPC call with correct action', async () => {
    const client = createMockClient();
    const tools = createIPCTools(client as any);
    const tool = findTool(tools, 'web');
    await tool.execute('tc3', { type: 'fetch', url: 'https://example.com' });
    expect(client.call).toHaveBeenCalledWith({
      action: 'web_fetch',
      url: 'https://example.com',
    }, undefined);
  });

  test('returns IPC response as text content', async () => {
    const client = createMockClient();
    client.call.mockResolvedValueOnce({ ok: true, data: 'response data' });
    const tools = createIPCTools(client as any);
    const tool = findTool(tools, 'web');
    const result = await tool.execute('tc5', { type: 'search', query: 'test' });
    expect(result.content[0]).toEqual({
      type: 'text',
      text: JSON.stringify({ ok: true, data: 'response data' }),
    });
  });

  test('handles IPC errors gracefully', async () => {
    const client = createMockClient();
    client.call.mockRejectedValueOnce(new Error('IPC connection lost'));
    const tools = createIPCTools(client as any);
    const tool = findTool(tools, 'memory');
    const result = await tool.execute('tc6', { type: 'list', scope: 'test' });
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).toMatch(/error|failed/i);
  });

  test('exports identity tool', () => {
    const client = createMockClient();
    const tools = createIPCTools(client as any);
    const names = tools.map((t) => t.name);
    expect(names).toContain('identity');
  });

  test('identity write sends IPC call with correct action', async () => {
    const client = createMockClient();
    const tools = createIPCTools(client as any);
    const tool = findTool(tools, 'identity');
    await tool.execute('tc7', {
      type: 'write',
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
    }, undefined);
  });

  test('identity tool has description mentioning identity files', () => {
    const client = createMockClient();
    const tools = createIPCTools(client as any);
    const tool = findTool(tools, 'identity');
    expect(tool.description).toContain('SOUL.md');
    expect(tool.description).toContain('IDENTITY.md');
  });

  test('identity user_write sends IPC call with userId from options', async () => {
    const client = createMockClient();
    const tools = createIPCTools(client as any, { userId: 'U12345' });
    const tool = findTool(tools, 'identity');
    await tool.execute('tc8', {
      type: 'user_write',
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
    }, undefined);
  });

  test('includes scheduler tool', () => {
    const client = createMockClient();
    const tools = createIPCTools(client as any);
    const tool = tools.find((t) => t.name === 'scheduler');
    expect(tool).toBeDefined();
    expect(tool!.description).toContain('cron');
  });

  test('total tool count is 20 without filter', () => {
    const client = createMockClient();
    const tools = createIPCTools(client as any);
    expect(tools.length).toBe(16);
  });

  test('filter excludes scheduler tool when hasHeartbeat is false', () => {
    const client = createMockClient();
    const tools = createIPCTools(client as any, {
      filter: { hasHeartbeat: false, skillInstallEnabled: true, hasGovernance: true },
    });
    const names = tools.map((t) => t.name);
    expect(names).not.toContain('scheduler');
    // Core tools still present
    expect(names).toContain('memory');
    expect(names).toContain('web');
  });

  test('filter excludes enterprise tools when flags are false', () => {
    const client = createMockClient();
    const tools = createIPCTools(client as any, {
      filter: { hasHeartbeat: true, skillInstallEnabled: true, hasGovernance: false },
    });
    const names = tools.map((t) => t.name);
    expect(names).not.toContain('governance');
    // Core tools still present
    expect(names).toContain('memory');
    expect(names).toContain('identity');
  });

  test('delegate uses default timeout (heartbeat-based)', async () => {
    const client = createMockClient();
    const tools = createIPCTools(client as any);
    const tool = findTool(tools, 'agent');
    await tool.execute('tc-delegate', { type: 'delegate', task: 'research X', context: 'some context' });
    expect(client.call).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'agent_delegate', task: 'research X' }),
      600000,  // delegate has timeoutMs: 600_000
    );
  });


  test('filter with all flags false returns only core tools', () => {
    const client = createMockClient();
    const tools = createIPCTools(client as any, {
      filter: { hasHeartbeat: false, skillInstallEnabled: false, hasGovernance: false },
    });
    const names = tools.map((t) => t.name);
    // memory(1) + web(1) + audit(1) + identity(1) + agent(1) + image(1) + credential(1) + sandbox(6) = 14 tools
    expect(names).toContain('memory');
    expect(names).toContain('web');
    expect(names).toContain('audit');
    expect(names).toContain('identity');
    expect(names).toContain('agent');

    expect(names).toContain('request_credential'); // always available
    expect(names).toContain('skill'); // always available — delete/update don't require install intent
    expect(names).toContain('bash');
    expect(names).toContain('read_file');
    expect(names).toContain('write_file');
    expect(names).toContain('edit_file');
    expect(names).toContain('grep');
    expect(names).toContain('glob');
    expect(tools.length).toBe(14);
  });
});
