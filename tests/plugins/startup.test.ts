import { describe, it, expect, beforeEach } from 'vitest';
import { initLogger } from '../../src/logger.js';
import { McpConnectionManager } from '../../src/plugins/mcp-manager.js';
import { reloadPluginMcpServers, autoInstallDeclaredPlugins } from '../../src/plugins/startup.js';
import type { DocumentStore } from '../../src/providers/storage/types.js';

// ---------------------------------------------------------------------------
// In-memory DocumentStore stub (same pattern as store.test.ts)
// ---------------------------------------------------------------------------

function memoryDocuments(): DocumentStore {
  const store = new Map<string, Map<string, string>>();

  return {
    async get(collection: string, key: string) {
      return store.get(collection)?.get(key);
    },
    async put(collection: string, key: string, content: string) {
      if (!store.has(collection)) store.set(collection, new Map());
      store.get(collection)!.set(key, content);
    },
    async delete(collection: string, key: string) {
      return store.get(collection)?.delete(key) ?? false;
    },
    async list(collection: string) {
      return [...(store.get(collection)?.keys() ?? [])];
    },
  };
}

// ---------------------------------------------------------------------------
// reloadPluginMcpServers
// ---------------------------------------------------------------------------

describe('reloadPluginMcpServers', () => {
  beforeEach(() => {
    initLogger({ file: false, level: 'silent' });
  });

  it('populates manager from stored plugin records', async () => {
    const docs = memoryDocuments();
    const manager = new McpConnectionManager();

    // Simulate a stored plugin with MCP servers
    await docs.put('plugins', 'pi/sales', JSON.stringify({
      pluginName: 'sales',
      source: 'anthropics/sales',
      version: '1.0.0',
      description: 'Sales',
      agentId: 'pi',
      skillCount: 1,
      commandCount: 0,
      mcpServers: [
        { name: 'slack', type: 'http', url: 'https://mcp.slack.com/mcp' },
        { name: 'hubspot', type: 'http', url: 'https://mcp.hubspot.com/mcp' },
      ],
      installedAt: '2026-03-29T00:00:00.000Z',
    }));

    await reloadPluginMcpServers(docs, manager);
    expect(manager.listServers('pi')).toHaveLength(2);
    expect(manager.listServers('pi').map(s => s.name)).toContain('slack');
    expect(manager.listServers('pi').map(s => s.name)).toContain('hubspot');
  });

  it('handles multiple agents', async () => {
    const docs = memoryDocuments();
    const manager = new McpConnectionManager();

    await docs.put('plugins', 'pi/sales', JSON.stringify({
      pluginName: 'sales',
      source: 'anthropics/sales',
      version: '1.0.0',
      description: 'Sales',
      agentId: 'pi',
      skillCount: 0,
      commandCount: 0,
      mcpServers: [
        { name: 'slack', type: 'http', url: 'https://mcp.slack.com/mcp' },
      ],
      installedAt: '2026-03-29T00:00:00.000Z',
    }));

    await docs.put('plugins', 'counsel/legal', JSON.stringify({
      pluginName: 'legal',
      source: 'anthropics/legal',
      version: '1.0.0',
      description: 'Legal',
      agentId: 'counsel',
      skillCount: 0,
      commandCount: 0,
      mcpServers: [
        { name: 'docusign', type: 'http', url: 'https://mcp.docusign.com/mcp' },
      ],
      installedAt: '2026-03-29T00:00:00.000Z',
    }));

    await reloadPluginMcpServers(docs, manager);
    expect(manager.listServers('pi')).toHaveLength(1);
    expect(manager.listServers('pi')[0].name).toBe('slack');
    expect(manager.listServers('counsel')).toHaveLength(1);
    expect(manager.listServers('counsel')[0].name).toBe('docusign');
  });

  it('handles empty DB gracefully', async () => {
    const docs = memoryDocuments();
    const manager = new McpConnectionManager();
    await reloadPluginMcpServers(docs, manager);
    expect(manager.listServers('pi')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// autoInstallDeclaredPlugins
// ---------------------------------------------------------------------------

describe('autoInstallDeclaredPlugins', () => {
  beforeEach(() => {
    initLogger({ file: false, level: 'silent' });
  });

  it('skips when config.plugins is empty', async () => {
    const docs = memoryDocuments();
    const manager = new McpConnectionManager();
    await autoInstallDeclaredPlugins({ plugins: [] } as any, docs, manager);
    // No error, no installs
  });

  it('skips when config.plugins is undefined', async () => {
    const docs = memoryDocuments();
    const manager = new McpConnectionManager();
    await autoInstallDeclaredPlugins({} as any, docs, manager);
    // No error, no installs
  });

  it('skips already installed plugins', async () => {
    const docs = memoryDocuments();
    const manager = new McpConnectionManager();

    // Pre-install a plugin
    await docs.put('plugins', 'pi/sales', JSON.stringify({
      pluginName: 'sales',
      source: 'anthropics/sales',
      version: '1.0.0',
      description: 'Sales',
      agentId: 'pi',
      skillCount: 0,
      commandCount: 0,
      mcpServers: [],
      installedAt: '2026-03-29T00:00:00.000Z',
    }));

    // autoInstallDeclaredPlugins should not attempt to install again
    const config = {
      plugins: [{ source: 'anthropics/sales', agents: ['pi'] }],
    } as any;

    // This should not throw or call installPlugin for the already-installed source
    await autoInstallDeclaredPlugins(config, docs, manager);
    // Plugin still exists, no duplicate
    const keys = await docs.list('plugins');
    expect(keys.filter(k => k.startsWith('pi/'))).toHaveLength(1);
  });
});
