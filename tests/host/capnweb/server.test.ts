/**
 * Tests for Cap'n Web RPC server.
 *
 * Creates a real Unix socket server, connects with a Cap'n Web client,
 * and verifies that MCP tool calls are proxied correctly with
 * promise pipelining / batching.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { connect } from 'node:net';
import { RpcSession } from 'capnweb';
import { CapnWebServer, createMcpToolsTarget } from '../../../src/host/capnweb/server.js';
import { SocketRpcTransport } from '../../../src/capnweb/transport.js';
import type { McpProvider, McpToolSchema, McpToolCall, McpToolResult, McpCredentialStatus } from '../../../src/providers/mcp/types.js';
import { initLogger } from '../../../src/logger.js';

// Silence logs in tests
initLogger({ file: false, level: 'silent' });

// ---------------------------------------------------------------------------
// Mock MCP provider
// ---------------------------------------------------------------------------

function createMockMcpProvider(responses: Record<string, unknown>): McpProvider {
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
    async listApps() {
      return [];
    },
  } as McpProvider & { calls: McpToolCall[] };
}

// ---------------------------------------------------------------------------
// Helper: create a client session connected to the server
// ---------------------------------------------------------------------------

async function createClient<T>(socketPath: string): Promise<{ stub: T; close: () => void }> {
  return new Promise((resolve) => {
    const socket = connect(socketPath, () => {
      const transport = new SocketRpcTransport(socket);
      const session = new RpcSession<T>(transport as any);
      const stub = session.getRemoteMain() as T;
      resolve({
        stub,
        close: () => {
          socket.destroy();
        },
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CapnWebServer', () => {
  let tempDir: string;
  let server: CapnWebServer;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'ax-capnweb-test-'));
  });

  afterEach(async () => {
    if (server) await server.stop();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should serve MCP tool calls via Cap\'n Web RPC', async () => {
    const socketPath = join(tempDir, 'capnweb.sock');
    const mcpProvider = createMockMcpProvider({
      getTeams: [{ id: 'team-1', name: 'Engineering' }],
      getIssues: [{ id: 'issue-1', title: 'Fix bug' }],
    }) as McpProvider & { calls: McpToolCall[] };

    const tools: McpToolSchema[] = await mcpProvider.listTools();

    server = new CapnWebServer({
      socketPath,
      mcpProvider,
      tools,
      context: { agentId: 'test-agent', userId: 'test-user', sessionId: 'test-session' },
    });
    await server.start();

    const { stub, close } = await createClient<any>(socketPath);

    try {
      // Call a tool
      const teams = await stub.getTeams({});
      expect(teams).toEqual([{ id: 'team-1', name: 'Engineering' }]);

      // Verify the MCP provider received the correct call
      expect(mcpProvider.calls).toHaveLength(1);
      expect(mcpProvider.calls[0].tool).toBe('getTeams');
      expect(mcpProvider.calls[0].agentId).toBe('test-agent');
    } finally {
      close();
    }
  });

  it('should batch independent calls via promise pipelining', async () => {
    const socketPath = join(tempDir, 'capnweb.sock');
    const callOrder: string[] = [];
    const mcpProvider = createMockMcpProvider({}) as McpProvider & { calls: McpToolCall[] };

    // Override callTool to track timing
    mcpProvider.callTool = async (call: McpToolCall) => {
      callOrder.push(call.tool);
      return { content: { tool: call.tool }, taint: 'external' as const };
    };

    const tools: McpToolSchema[] = [
      { name: 'getTeams', description: 'Get teams', inputSchema: {} },
      { name: 'getRepos', description: 'Get repos', inputSchema: {} },
    ];

    server = new CapnWebServer({
      socketPath,
      mcpProvider,
      tools,
      context: { agentId: 'a', userId: 'u', sessionId: 's' },
    });
    await server.start();

    const { stub, close } = await createClient<any>(socketPath);

    try {
      // Fire both calls without awaiting — Cap'n Web should batch them
      const teamsPromise = stub.getTeams({});
      const reposPromise = stub.getRepos({});

      const [teams, repos] = await Promise.all([teamsPromise, reposPromise]);

      expect(teams).toEqual({ tool: 'getTeams' });
      expect(repos).toEqual({ tool: 'getRepos' });
      // Both tools were called
      expect(callOrder).toContain('getTeams');
      expect(callOrder).toContain('getRepos');
    } finally {
      close();
    }
  });

  it('should propagate errors from MCP tool calls', async () => {
    const socketPath = join(tempDir, 'capnweb.sock');
    const mcpProvider = createMockMcpProvider({}) as McpProvider & { calls: McpToolCall[] };

    mcpProvider.callTool = async () => ({
      content: 'Rate limit exceeded',
      isError: true,
      taint: 'external' as const,
    });

    const tools: McpToolSchema[] = [
      { name: 'failingTool', description: 'Always fails', inputSchema: {} },
    ];

    server = new CapnWebServer({
      socketPath,
      mcpProvider,
      tools,
      context: { agentId: 'a', userId: 'u', sessionId: 's' },
    });
    await server.start();

    const { stub, close } = await createClient<any>(socketPath);

    try {
      await expect(stub.failingTool({})).rejects.toThrow('Rate limit exceeded');
    } finally {
      close();
    }
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

    // Verify prototype methods exist
    expect(typeof (target as any).tool_a).toBe('function');
    expect(typeof (target as any).tool_b).toBe('function');
  });
});
