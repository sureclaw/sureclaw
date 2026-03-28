/**
 * Tests for Cap'n Web RPC target + IPC handler.
 *
 * Uses Cap'n Web's HTTP batch mode to test the RpcTarget end-to-end
 * (same batch protocol used by the IPC handler, just over HTTP for simplicity).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createMcpToolsTarget } from '../../../src/host/capnweb/server.js';
import { createCapnWebHandlers } from '../../../src/host/ipc-handlers/capnweb.js';
import { newHttpBatchRpcSession, newHttpBatchRpcResponse } from 'capnweb';
import type { McpProvider, McpToolSchema, McpToolCall, McpToolResult, McpCredentialStatus } from '../../../src/providers/mcp/types.js';
import { initLogger } from '../../../src/logger.js';

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
// Helper: HTTP server wrapping newHttpBatchRpcResponse for testing
// ---------------------------------------------------------------------------

async function startTestServer(target: any): Promise<{ url: string; close: () => void }> {
  const server: Server = createServer(async (req, res) => {
    try {
      const response = await newHttpBatchRpcResponse(new Request('http://localhost/rpc', {
        method: 'POST',
        body: await new Promise<string>((resolve) => {
          let data = '';
          req.on('data', (c: Buffer) => { data += c.toString(); });
          req.on('end', () => resolve(data));
        }),
      }), target);
      const body = await response.text();
      res.writeHead(response.status, { 'Content-Type': 'text/plain' });
      res.end(body);
    } catch (err) {
      res.writeHead(500);
      res.end(String(err));
    }
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

describe('createMcpToolsTarget', () => {
  let serverInfo: { url: string; close: () => void } | null = null;

  afterEach(() => {
    serverInfo?.close();
    serverInfo = null;
  });

  it('should create an RpcTarget with a method per tool', () => {
    const mcpProvider = createMockMcpProvider({ tool_a: 'a', tool_b: 'b' });
    const tools: McpToolSchema[] = [
      { name: 'tool_a', description: 'A', inputSchema: {} },
      { name: 'tool_b', description: 'B', inputSchema: {} },
    ];

    const target = createMcpToolsTarget(mcpProvider, tools, { agentId: 'a', userId: 'u', sessionId: 's' });
    expect(typeof (target as any).tool_a).toBe('function');
    expect(typeof (target as any).tool_b).toBe('function');
  });

  it('should proxy tool calls to McpProvider via HTTP batch', async () => {
    const mcpProvider = createMockMcpProvider({
      getTeams: [{ id: 'team-1', name: 'Engineering' }],
    });

    const tools: McpToolSchema[] = await mcpProvider.listTools();
    const target = createMcpToolsTarget(mcpProvider, tools, {
      agentId: 'test-agent', userId: 'test-user', sessionId: 'test-session',
    });

    serverInfo = await startTestServer(target);
    const api = newHttpBatchRpcSession<any>(serverInfo.url);
    const teams = await api.getTeams({});

    expect(teams).toEqual([{ id: 'team-1', name: 'Engineering' }]);
    expect(mcpProvider.calls).toHaveLength(1);
    expect(mcpProvider.calls[0].tool).toBe('getTeams');
    expect(mcpProvider.calls[0].agentId).toBe('test-agent');
  });

  it('should batch independent calls', async () => {
    const mcpProvider = createMockMcpProvider({});
    mcpProvider.callTool = async (call: McpToolCall) => ({
      content: { tool: call.tool }, taint: 'external' as const,
    });

    const tools: McpToolSchema[] = [
      { name: 'getTeams', description: 'Get teams', inputSchema: {} },
      { name: 'getRepos', description: 'Get repos', inputSchema: {} },
    ];

    const target = createMcpToolsTarget(mcpProvider, tools, { agentId: 'a', userId: 'u', sessionId: 's' });
    serverInfo = await startTestServer(target);

    const api = newHttpBatchRpcSession<any>(serverInfo.url);
    const [teams, repos] = await Promise.all([api.getTeams({}), api.getRepos({})]);

    expect(teams).toEqual({ tool: 'getTeams' });
    expect(repos).toEqual({ tool: 'getRepos' });
  });

  it('should propagate errors', async () => {
    const mcpProvider = createMockMcpProvider({});
    mcpProvider.callTool = async () => ({
      content: 'Rate limit exceeded', isError: true, taint: 'external' as const,
    });

    const tools: McpToolSchema[] = [
      { name: 'failingTool', description: 'Fails', inputSchema: {} },
    ];

    const target = createMcpToolsTarget(mcpProvider, tools, { agentId: 'a', userId: 'u', sessionId: 's' });
    serverInfo = await startTestServer(target);

    const api = newHttpBatchRpcSession<any>(serverInfo.url);
    await expect(api.failingTool({})).rejects.toThrow('Rate limit exceeded');
  });
});

describe('createCapnWebHandlers', () => {
  it('should process a batch via the IPC handler', async () => {
    const mcpProvider = createMockMcpProvider({
      getTeams: [{ id: 'team-1' }],
    });

    const tools: McpToolSchema[] = await mcpProvider.listTools();
    const target = createMcpToolsTarget(mcpProvider, tools, {
      agentId: 'a', userId: 'u', sessionId: 's',
    });

    const handlers = createCapnWebHandlers(() => target);

    // Simulate what the agent's IPC batch transport does:
    // 1. Create an HTTP batch request to get the batch body
    // 2. Send it through the IPC handler
    // 3. Get back the response body

    // Use Cap'n Web's HTTP batch to generate a real batch payload
    let capturedBody = '';
    const mockServer = createServer(async (req, res) => {
      capturedBody = await new Promise<string>((resolve) => {
        let data = '';
        req.on('data', (c: Buffer) => { data += c.toString(); });
        req.on('end', () => resolve(data));
      });
      // Process through the IPC handler
      const result = await handlers.capnweb_batch(
        { body: capturedBody },
        { sessionId: 's', agentId: 'a' },
      );
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(result.body);
    });

    await new Promise<void>(resolve => mockServer.listen(0, '127.0.0.1', resolve));
    const port = (mockServer.address() as { port: number }).port;

    try {
      const api = newHttpBatchRpcSession<any>(`http://127.0.0.1:${port}/rpc`);
      const teams = await api.getTeams({});
      expect(teams).toEqual([{ id: 'team-1' }]);
    } finally {
      mockServer.close();
    }
  });

  it('should throw when target is null', async () => {
    const handlers = createCapnWebHandlers(() => null);
    await expect(
      handlers.capnweb_batch({ body: '' }, { sessionId: 's', agentId: 'a' }),
    ).rejects.toThrow('not available');
  });
});
