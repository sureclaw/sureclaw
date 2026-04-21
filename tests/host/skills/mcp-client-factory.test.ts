import { describe, test, expect, vi, beforeEach } from 'vitest';
import type { SkillSnapshotEntry } from '../../../src/host/skills/types.js';
import type { McpConnectionManager } from '../../../src/plugins/mcp-manager.js';

// Mock the MCP client module — `buildTurnMcpClientFactory` calls
// `connectAndListTools` directly, and we don't want real network I/O in
// a unit test. Mock factory is hoisted above the import for vitest.
vi.mock('../../../src/plugins/mcp-client.js', () => ({
  connectAndListTools: vi.fn(),
}));

const { buildTurnMcpClientFactory } = await import('../../../src/host/skills/mcp-client-factory.js');
const { connectAndListTools } = await import('../../../src/plugins/mcp-client.js');
const mockConnectAndListTools = vi.mocked(connectAndListTools);

function validSnapshotEntry(
  name: string,
  servers: Array<{ name: string; url: string; transport?: 'http' | 'sse'; credential?: string }>,
): SkillSnapshotEntry {
  return {
    name,
    ok: true,
    frontmatter: {
      name,
      description: `${name} skill`,
      credentials: [],
      mcpServers: servers.map(s => ({
        name: s.name,
        url: s.url,
        transport: s.transport ?? 'http',
        ...(s.credential ? { credential: s.credential } : {}),
      })),
      domains: [],
    },
    body: '',
  };
}

function mockMcpManager(
  meta?: { source?: string; headers?: Record<string, string>; transport?: 'http' | 'sse' },
): McpConnectionManager {
  return {
    getServerMeta: vi.fn().mockReturnValue(meta),
  } as unknown as McpConnectionManager;
}

describe('buildTurnMcpClientFactory', () => {
  beforeEach(() => {
    mockConnectAndListTools.mockReset();
  });

  test('listTools delegates to connectAndListTools with URL + injected auth headers when meta has no headers', async () => {
    mockConnectAndListTools.mockResolvedValue([
      { name: 'list_issues', description: 'List', inputSchema: { type: 'object' } },
    ]);
    const resolveAuthHeaders = vi.fn().mockResolvedValue({ Authorization: 'Bearer fallback-token' });
    const factory = buildTurnMcpClientFactory({
      mcpManager: mockMcpManager({ source: 'skill', transport: 'sse' }),
      agentId: 'agent-1',
      snapshot: [validSnapshotEntry('linear', [{ name: 'linear', url: 'https://mcp.linear.app/sse', transport: 'sse' }])],
      resolveAuthHeaders,
    });

    const client = factory('linear', 'linear');
    const tools = await client.listTools();

    expect(tools).toEqual([{ name: 'list_issues', description: 'List', inputSchema: { type: 'object' } }]);
    expect(mockConnectAndListTools).toHaveBeenCalledWith('https://mcp.linear.app/sse', {
      headers: { Authorization: 'Bearer fallback-token' },
      transport: 'sse',
    });
    expect(resolveAuthHeaders).toHaveBeenCalledWith('linear');
  });

  test('returns empty array (no throw) when URL map has no entry for the server', async () => {
    const resolveAuthHeaders = vi.fn();
    const factory = buildTurnMcpClientFactory({
      mcpManager: mockMcpManager(undefined),
      agentId: 'agent-1',
      // Snapshot declares `linear`, but caller asks for `unknown` — factory
      // must no-op (no network, no exception).
      snapshot: [validSnapshotEntry('linear', [{ name: 'linear', url: 'https://mcp.linear.app/sse' }])],
      resolveAuthHeaders,
    });

    const client = factory('whatever', 'unknown');
    const tools = await client.listTools();

    expect(tools).toEqual([]);
    expect(mockConnectAndListTools).not.toHaveBeenCalled();
    expect(resolveAuthHeaders).not.toHaveBeenCalled();
  });

  test('prefers explicit meta.headers over the auth resolver', async () => {
    mockConnectAndListTools.mockResolvedValue([]);
    const resolveAuthHeaders = vi.fn().mockResolvedValue({ Authorization: 'Bearer fallback' });
    const factory = buildTurnMcpClientFactory({
      mcpManager: mockMcpManager({ headers: { 'X-Explicit': 'yes' }, transport: 'http' }),
      agentId: 'agent-1',
      snapshot: [validSnapshotEntry('gh', [{ name: 'gh', url: 'https://api.github.com/mcp' }])],
      resolveAuthHeaders,
    });

    await factory('gh', 'gh').listTools();

    expect(mockConnectAndListTools).toHaveBeenCalledWith('https://api.github.com/mcp', {
      headers: { 'X-Explicit': 'yes' },
      transport: 'http',
    });
    expect(resolveAuthHeaders).not.toHaveBeenCalled();
  });

  test('applies urlRewrites to the MCP URL before dispatch', async () => {
    mockConnectAndListTools.mockResolvedValue([]);
    const factory = buildTurnMcpClientFactory({
      mcpManager: mockMcpManager({ transport: 'http' }),
      agentId: 'agent-1',
      snapshot: [
        validSnapshotEntry('linear-mcp', [
          { name: 'linear', url: 'https://mock-target.test/mcp/linear', transport: 'http' },
        ]),
      ],
      resolveAuthHeaders: vi.fn().mockResolvedValue(undefined),
      urlRewrites: { 'mock-target.test': 'http://127.0.0.1:9999' },
    });

    await factory('linear-mcp', 'linear').listTools();

    // The factory must rewrite the hostname before calling connectAndListTools,
    // preserving the /mcp/linear path.
    expect(mockConnectAndListTools).toHaveBeenCalledWith(
      'http://127.0.0.1:9999/mcp/linear',
      expect.any(Object),
    );
  });

  test('leaves URL unchanged when urlRewrites is undefined (production default)', async () => {
    mockConnectAndListTools.mockResolvedValue([]);
    const factory = buildTurnMcpClientFactory({
      mcpManager: mockMcpManager({ transport: 'http' }),
      agentId: 'agent-1',
      snapshot: [validSnapshotEntry('linear-mcp', [{ name: 'linear', url: 'https://mcp.linear.app/mcp' }])],
      resolveAuthHeaders: vi.fn().mockResolvedValue(undefined),
    });

    await factory('linear-mcp', 'linear').listTools();

    expect(mockConnectAndListTools).toHaveBeenCalledWith(
      'https://mcp.linear.app/mcp',
      expect.any(Object),
    );
  });

  // Regression: the bug that shipped with Test-&-Enable v1. Admin-approved
  // skills whose server name didn't match a <SERVER>_<SUFFIX> prefix pattern
  // would succeed at probe time (probe uses the explicit credential ref)
  // then 401 on every turn (catalog population used pattern-based lookup).
  // The factory now prefers the `mcpServers[].credential` ref over the
  // legacy pattern, matching the probe path.

  test('prefers resolveAuthHeadersByCredential over the pattern resolver when frontmatter pins a credential ref', async () => {
    mockConnectAndListTools.mockResolvedValue([]);
    const resolveAuthHeaders = vi.fn().mockResolvedValue({ Authorization: 'Bearer wrong' });
    const resolveAuthHeadersByCredential = vi
      .fn()
      .mockResolvedValue({ Authorization: 'Bearer ref-resolved' });
    const factory = buildTurnMcpClientFactory({
      mcpManager: mockMcpManager(undefined),
      agentId: 'agent-1',
      snapshot: [
        validSnapshotEntry('linear', [
          {
            name: 'linear-mcp-server',
            url: 'https://mcp.linear.app/mcp',
            transport: 'http',
            credential: 'LINEAR_API_KEY',
          },
        ]),
      ],
      resolveAuthHeaders,
      resolveAuthHeadersByCredential,
    });

    await factory('linear', 'linear-mcp-server').listTools();

    expect(resolveAuthHeadersByCredential).toHaveBeenCalledWith('LINEAR_API_KEY');
    expect(resolveAuthHeaders).not.toHaveBeenCalled();
    expect(mockConnectAndListTools).toHaveBeenCalledWith('https://mcp.linear.app/mcp', {
      headers: { Authorization: 'Bearer ref-resolved' },
      transport: 'http',
    });
  });

  test('falls through to the pattern resolver when the credential-ref resolver returns undefined', async () => {
    mockConnectAndListTools.mockResolvedValue([]);
    const resolveAuthHeaders = vi.fn().mockResolvedValue({ Authorization: 'Bearer from-pattern' });
    const resolveAuthHeadersByCredential = vi.fn().mockResolvedValue(undefined);
    const factory = buildTurnMcpClientFactory({
      mcpManager: mockMcpManager(undefined),
      agentId: 'agent-1',
      snapshot: [
        validSnapshotEntry('linear', [
          {
            name: 'linear',
            url: 'https://mcp.linear.app/mcp',
            transport: 'http',
            credential: 'LINEAR_API_KEY',
          },
        ]),
      ],
      resolveAuthHeaders,
      resolveAuthHeadersByCredential,
    });

    await factory('linear', 'linear').listTools();

    expect(resolveAuthHeadersByCredential).toHaveBeenCalledWith('LINEAR_API_KEY');
    expect(resolveAuthHeaders).toHaveBeenCalledWith('linear');
    expect(mockConnectAndListTools).toHaveBeenCalledWith('https://mcp.linear.app/mcp', {
      headers: { Authorization: 'Bearer from-pattern' },
      transport: 'http',
    });
  });

  test('uses the pattern resolver when frontmatter did not pin a credential ref', async () => {
    mockConnectAndListTools.mockResolvedValue([]);
    const resolveAuthHeaders = vi.fn().mockResolvedValue({ Authorization: 'Bearer pattern' });
    const resolveAuthHeadersByCredential = vi.fn();
    const factory = buildTurnMcpClientFactory({
      mcpManager: mockMcpManager(undefined),
      agentId: 'agent-1',
      // No `credential:` on the server — the classic shape.
      snapshot: [validSnapshotEntry('gh', [{ name: 'gh', url: 'https://api.github.com/mcp' }])],
      resolveAuthHeaders,
      resolveAuthHeadersByCredential,
    });

    await factory('gh', 'gh').listTools();

    expect(resolveAuthHeadersByCredential).not.toHaveBeenCalled();
    expect(resolveAuthHeaders).toHaveBeenCalledWith('gh');
  });

  test('skips parse-failure snapshot entries when building the URL map', async () => {
    mockConnectAndListTools.mockResolvedValue([]);
    const factory = buildTurnMcpClientFactory({
      mcpManager: mockMcpManager(undefined),
      agentId: 'agent-1',
      snapshot: [
        { name: 'broken', ok: false, error: 'bad frontmatter' },
        validSnapshotEntry('good', [{ name: 'good', url: 'https://good.example/mcp' }]),
      ],
      resolveAuthHeaders: vi.fn().mockResolvedValue(undefined),
    });

    const brokenClient = factory('broken', 'missing');
    expect(await brokenClient.listTools()).toEqual([]);

    const goodClient = factory('good', 'good');
    await goodClient.listTools();
    expect(mockConnectAndListTools).toHaveBeenCalledWith('https://good.example/mcp', expect.any(Object));
  });
});
