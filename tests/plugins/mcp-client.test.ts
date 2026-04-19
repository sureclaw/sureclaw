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

  it('listToolsFromServer accepts transport option (default behavior)', async () => {
    initLogger({ file: false, level: 'silent' });
    // Not passing transport — default is http. Bad host, returns [].
    const tools = await listToolsFromServer('http://127.0.0.1:1/mcp');
    expect(tools).toEqual([]);
  });

  it('listToolsFromServer accepts transport: sse without throwing on bad host', async () => {
    initLogger({ file: false, level: 'silent' });
    // SSE transport against an unreachable host — gracefully returns [].
    // Proves the transport: 'sse' branch in createTransport compiles + runs.
    const tools = await listToolsFromServer('http://127.0.0.1:1/sse', { transport: 'sse' });
    expect(tools).toEqual([]);
  });

  it('listToolsFromServer accepts transport: http explicitly', async () => {
    initLogger({ file: false, level: 'silent' });
    const tools = await listToolsFromServer('http://127.0.0.1:1/mcp', {
      transport: 'http',
    });
    expect(tools).toEqual([]);
  });
});
