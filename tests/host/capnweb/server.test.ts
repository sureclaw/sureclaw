/**
 * Tests for Cap'n Web RPC handler.
 *
 * Creates a real HTTP server with the Cap'n Web handler registered,
 * connects with Cap'n Web's HTTP batch client, and verifies that MCP
 * tool calls are proxied correctly with batching.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createCapnWebHandler, createMcpToolsTarget } from '../../../src/host/capnweb/server.js';
import { newHttpBatchRpcSession } from 'capnweb';
import type { McpProvider, McpToolSchema, McpToolCall, McpToolResult, McpCredentialStatus } from '../../../src/providers/mcp/types.js';
import { initLogger } from '../../../src/logger.js';

// Silence logs in tests
initLogger({ file: false, level: 'silent' });

// ---------------------------------------------------------------------------
// Mock MCP provider
// ---------------------------------------------------------------------------

function createMockMcpProvider(responses: Record<string, unknown>): McpProvider & { calls: McpToolCall[] } {
  const calls: McpToolCall[] = [];
  return {
    calls,
    async listTools() {
      return Object.keys(responses).map((name) => ({
        name,
        description: `Mock tool: ${name}`,
        inputSchema: { type: 'object', properties: {} },
      }));
    },
    async callTool(call: McpToolCall): Promise<McpToolResult> {
      calls.push(call);
      const content = responses[call.tool];
      if (content === undefined) {
        return { content: `Unknown tool: ${call.tool}`, isError: true, taint: 'external' };
      }
      return { content: content as string | Record<string, unknown>, taint: 'external' };
    },
    async credentialStatus(_agentId: string, app: string): Promise<McpCredentialStatus> {
      return { available: true, app, authType: 'api_key' };
    },
    async storeCredential() {},
    async listApps() { return []; },
  };
}

// ---------------------------------------------------------------------------
// Helper: start an HTTP server with the Cap'n Web handler
// ---------------------------------------------------------------------------

async function startTestServer(handler: (req: any, res: any) => Promise<void>): Promise<{ url: string; close: () => void }> {
  const server: Server = createServer((req, res) => {
    handler(req, res).catch((err) => {
      res.writeHead(500);
      res.end(String(err));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${addr.port}/rpc`,
        close: () => server.close(),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createCapnWebHandler', () => {
  let serverInfo: { url: string; close: () => void } | null = null;

  afterEach(() => {
    serverInfo?.close();
    serverInfo = null;
  });

  it('should serve MCP tool calls via HTTP batch RPC', async () => {
    const mcpProvider = createMockMcpProvider({
      getTeams: [{ id: 'team-1', name: 'Engineering' }],
      getIssues: [{ id: 'issue-1', title: 'Fix bug' }],
    });

    const tools: McpToolSchema[] = await mcpProvider.listTools();
    const handler = createCapnWebHandler({
      mcpProvider,
      tools,
      context: { agentId: 'test-agent', userId: 'test-user', sessionId: 'test-session' },
    });

    serverInfo = await startTestServer(handler);

    const api = newHttpBatchRpcSession<any>(serverInfo.url);
    const teams = await api.getTeams({});

    expect(teams).toEqual([{ id: 'team-1', name: 'Engineering' }]);
    expect(mcpProvider.calls).toHaveLength(1);
    expect(mcpProvider.calls[0].tool).toBe('getTeams');
    expect(mcpProvider.calls[0].agentId).toBe('test-agent');
  });

  it('should batch independent calls into a single HTTP request', async () => {
    const mcpProvider = createMockMcpProvider({});
    mcpProvider.callTool = async (call: McpToolCall) => {
      return { content: { tool: call.tool }, taint: 'external' as const };
    };

    const tools: McpToolSchema[] = [
      { name: 'getTeams', description: 'Get teams', inputSchema: {} },
      { name: 'getRepos', description: 'Get repos', inputSchema: {} },
    ];

    const handler = createCapnWebHandler({
      mcpProvider,
      tools,
      context: { agentId: 'a', userId: 'u', sessionId: 's' },
    });

    serverInfo = await startTestServer(handler);

    // newHttpBatchRpcSession batches all calls made before the microtask
    // boundary into a single HTTP POST. Both calls below resolve from
    // one round trip.
    const api = newHttpBatchRpcSession<any>(serverInfo.url);
    const teamsPromise = api.getTeams({});
    const reposPromise = api.getRepos({});

    const [teams, repos] = await Promise.all([teamsPromise, reposPromise]);

    expect(teams).toEqual({ tool: 'getTeams' });
    expect(repos).toEqual({ tool: 'getRepos' });
  });

  it('should propagate errors from MCP tool calls', async () => {
    const mcpProvider = createMockMcpProvider({});
    mcpProvider.callTool = async () => ({
      content: 'Rate limit exceeded',
      isError: true,
      taint: 'external' as const,
    });

    const tools: McpToolSchema[] = [
      { name: 'failingTool', description: 'Always fails', inputSchema: {} },
    ];

    const handler = createCapnWebHandler({
      mcpProvider,
      tools,
      context: { agentId: 'a', userId: 'u', sessionId: 's' },
    });

    serverInfo = await startTestServer(handler);

    const api = newHttpBatchRpcSession<any>(serverInfo.url);
    await expect(api.failingTool({})).rejects.toThrow('Rate limit exceeded');
  });
});

describe('createMcpToolsTarget', () => {
  it('should create an RpcTarget with a method per tool', () => {
    const mcpProvider = createMockMcpProvider({
      tool_a: 'result_a',
      tool_b: 'result_b',
    });

    const tools: McpToolSchema[] = [
      { name: 'tool_a', description: 'Tool A', inputSchema: {} },
      { name: 'tool_b', description: 'Tool B', inputSchema: {} },
    ];

    const target = createMcpToolsTarget(mcpProvider, tools, {
      agentId: 'a',
      userId: 'u',
      sessionId: 's',
    });

    expect(typeof (target as any).tool_a).toBe('function');
    expect(typeof (target as any).tool_b).toBe('function');
  });
});
