import { describe, it, expect, beforeEach } from 'vitest';
import { initLogger } from '../../src/logger.js';
import { McpConnectionManager } from '../../src/plugins/mcp-manager.js';
import { loadDatabaseMcpServers } from '../../src/plugins/startup.js';

// ---------------------------------------------------------------------------
// loadDatabaseMcpServers
// ---------------------------------------------------------------------------

describe('loadDatabaseMcpServers', () => {
  beforeEach(() => {
    initLogger({ file: false, level: 'silent' });
  });

  it('registers DB servers in the manager with source: database', async () => {
    const manager = new McpConnectionManager();

    // Mock a minimal database provider with a db that has selectFrom
    const mockDb = {
      selectFrom: () => ({
        selectAll: () => ({
          where: (_col: string, _op: string, _val: any) => ({
            execute: async () => [
              { agent_id: 'pi', name: 'linear', url: 'https://linear.example.com', headers: JSON.stringify({ Authorization: 'Bearer {KEY}' }) },
              { agent_id: 'pi', name: 'github', url: 'https://github.example.com', headers: null },
            ],
          }),
        }),
      }),
    };

    await loadDatabaseMcpServers({ db: mockDb } as any, manager);

    const servers = manager.listServersWithMeta('pi');
    expect(servers).toHaveLength(2);
    const linear = servers.find(s => s.name === 'linear');
    expect(linear?.source).toBe('database');
    expect(linear?.headers).toEqual({ Authorization: 'Bearer {KEY}' });
    const github = servers.find(s => s.name === 'github');
    expect(github?.source).toBe('database');
    expect(github?.headers).toBeUndefined();
  });

  it('handles missing mcp_servers table gracefully', async () => {
    const manager = new McpConnectionManager();
    const mockDb = {
      selectFrom: () => { throw new Error('no such table: mcp_servers'); },
    };
    // Should not throw
    await loadDatabaseMcpServers({ db: mockDb } as any, manager);
    expect(manager.listServers('pi')).toEqual([]);
  });

  it('skips when database is undefined', async () => {
    const manager = new McpConnectionManager();
    // Should not throw
    await loadDatabaseMcpServers(undefined, manager);
    expect(manager.listServers('pi')).toEqual([]);
  });
});
