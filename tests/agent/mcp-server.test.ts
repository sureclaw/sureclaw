import { describe, test, expect, vi } from 'vitest';
import { createIPCMcpServer } from '../../src/agent/mcp-server.js';
import type { IPCClient } from '../../src/agent/ipc-client.js';

/** Create a mock IPC client with a spied call() method. */
function createMockClient(response: unknown = { ok: true }): IPCClient {
  return {
    call: vi.fn().mockResolvedValue(response),
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
  } as unknown as IPCClient;
}

/** Create a mock IPC client that throws errors. */
function createErrorClient(message: string): IPCClient {
  return {
    call: vi.fn().mockRejectedValue(new Error(message)),
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
  } as unknown as IPCClient;
}

/** Get the tool registry from a McpServer instance (plain object, not Map). */
function getTools(server: ReturnType<typeof createIPCMcpServer>): Record<string, any> {
  return (server.instance as any)._registeredTools;
}

describe('IPC MCP Server', () => {
  test('has correct structure (type, name, instance)', () => {
    const client = createMockClient();
    const server = createIPCMcpServer(client);

    expect(server.type).toBe('sdk');
    expect(server.name).toBe('ax-tools');
    expect(server.instance).toBeDefined();
  });

  test('memory_write calls IPC client with correct action', async () => {
    const client = createMockClient({ id: 'mem_1' });
    const server = createIPCMcpServer(client);
    const tools = getTools(server);

    expect(tools['memory_write']).toBeDefined();

    const result = await tools['memory_write'].handler(
      { scope: 'test', content: 'hello', tags: ['a'] },
      {},
    );

    expect(client.call).toHaveBeenCalledWith({
      action: 'memory_write',
      scope: 'test',
      content: 'hello',
      tags: ['a'],
    });
    expect(result.content[0].text).toContain('"id":"mem_1"');
  });

  test('memory_query calls IPC client with correct action', async () => {
    const client = createMockClient([{ id: 'mem_1', content: 'hi' }]);
    const server = createIPCMcpServer(client);
    const tools = getTools(server);

    const result = await tools['memory_query'].handler(
      { scope: 'test', query: 'search term', limit: 5 },
      {},
    );

    expect(client.call).toHaveBeenCalledWith({
      action: 'memory_query',
      scope: 'test',
      query: 'search term',
      limit: 5,
    });
    expect(result.content[0].text).toContain('mem_1');
  });

  test('web_search calls IPC client with correct action', async () => {
    const client = createMockClient({ results: [] });
    const server = createIPCMcpServer(client);
    const tools = getTools(server);

    await tools['web_search'].handler({ query: 'test query', maxResults: 3 }, {});

    expect(client.call).toHaveBeenCalledWith({
      action: 'web_search',
      query: 'test query',
      maxResults: 3,
    });
  });

  test('error from IPC returns error content', async () => {
    const client = createErrorClient('connection refused');
    const server = createIPCMcpServer(client);
    const tools = getTools(server);

    const result = await tools['memory_read'].handler({ id: 'nonexistent' }, {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('connection refused');
  });

  test('strips taint from top-level web_fetch response', async () => {
    const client = createMockClient({
      status: 200,
      headers: { 'content-type': 'text/html' },
      body: '<h1>Hello</h1>',
      taint: { source: 'web_fetch', trust: 'external', timestamp: '2026-01-01T00:00:00Z' },
    });
    const server = createIPCMcpServer(client);
    const tools = getTools(server);

    const result = await tools['web_fetch'].handler({ url: 'https://example.com' }, {});
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.body).toBe('<h1>Hello</h1>');
    expect(parsed.taint).toBeUndefined();
  });

  test('strips taint from nested objects in web_search results array', async () => {
    const client = createMockClient([
      { title: 'Result 1', url: 'https://a.com', snippet: 'A', taint: { source: 'web_search', trust: 'external' } },
      { title: 'Result 2', url: 'https://b.com', snippet: 'B', taint: { source: 'web_search', trust: 'external' } },
    ]);
    const server = createIPCMcpServer(client);
    const tools = getTools(server);

    const result = await tools['web_search'].handler({ query: 'test' }, {});
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed).toHaveLength(2);
    expect(parsed[0].title).toBe('Result 1');
    expect(parsed[0].taint).toBeUndefined();
    expect(parsed[1].taint).toBeUndefined();
  });

  test('does not include skill_read or skill_list tools', () => {
    const client = createMockClient();
    const server = createIPCMcpServer(client);
    const tools = getTools(server);
    const names = Object.keys(tools);

    expect(names).not.toContain('skill_read');
    expect(names).not.toContain('skill_list');
  });

  test('identity_write calls IPC client with correct action', async () => {
    const client = createMockClient({ ok: true, queued: false });
    const server = createIPCMcpServer(client);
    const tools = getTools(server);

    expect(tools['identity_write']).toBeDefined();

    const result = await tools['identity_write'].handler(
      { file: 'SOUL.md', content: '# Witty Bot', reason: 'User asked to be more witty', origin: 'user_request' },
      {},
    );

    expect(client.call).toHaveBeenCalledWith({
      action: 'identity_write',
      file: 'SOUL.md',
      content: '# Witty Bot',
      reason: 'User asked to be more witty',
      origin: 'user_request',
    });
    expect(result.content[0].text).toContain('"ok":true');
  });

  test('all 10 IPC tools are registered', () => {
    const client = createMockClient();
    const server = createIPCMcpServer(client);
    const tools = getTools(server);

    const expectedTools = [
      'memory_write', 'memory_query', 'memory_read', 'memory_delete', 'memory_list',
      'web_search', 'web_fetch',
      'audit_query',
      'identity_write',
      'user_write',
    ];

    const registeredNames = Object.keys(tools);
    for (const name of expectedTools) {
      expect(registeredNames, `expected tool "${name}" to be registered`).toContain(name);
    }
    expect(registeredNames.length).toBe(10);
  });

  test('user_write calls IPC client with userId from options', async () => {
    const client = createMockClient({ ok: true, applied: true });
    const server = createIPCMcpServer(client, { userId: 'U12345' });
    const tools = getTools(server);

    expect(tools['user_write']).toBeDefined();

    const result = await tools['user_write'].handler(
      { content: '# User prefs', reason: 'Learned from chat', origin: 'agent_initiated' },
      {},
    );

    expect(client.call).toHaveBeenCalledWith({
      action: 'user_write',
      content: '# User prefs',
      reason: 'Learned from chat',
      origin: 'agent_initiated',
      userId: 'U12345',
    });
    expect(result.content[0].text).toContain('"ok":true');
  });
});
