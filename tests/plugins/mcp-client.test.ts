import { describe, it, expect } from 'vitest';
import { listToolsFromServers, listToolsFromServer } from '../../src/plugins/mcp-client.js';
import { initLogger } from '../../src/logger.js';

describe('mcp-client', () => {
  it('listToolsFromServers returns empty for empty URLs', async () => {
    expect(await listToolsFromServers([])).toEqual([]);
  });

  it('listToolsFromServer returns empty on connection failure', async () => {
    initLogger({ file: false, level: 'silent' });
    // This URL won't have an MCP server — should return [] not throw
    const tools = await listToolsFromServer('http://127.0.0.1:1/mcp');
    expect(tools).toEqual([]);
  });
});
