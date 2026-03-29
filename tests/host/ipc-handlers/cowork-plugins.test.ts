import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createCoworkPluginHandlers } from '../../../src/host/ipc-handlers/cowork-plugins.js';
import { McpConnectionManager } from '../../../src/plugins/mcp-manager.js';
import type { ProviderRegistry } from '../../../src/types.js';
import type { IPCContext } from '../../../src/host/ipc-server.js';

// In-memory DocumentStore mock (same pattern as skills-crud.test.ts)
function createMockDocStore() {
  const store = new Map<string, Map<string, string>>();
  return {
    async put(collection: string, key: string, value: string) {
      if (!store.has(collection)) store.set(collection, new Map());
      store.get(collection)!.set(key, value);
    },
    async get(collection: string, key: string) {
      return store.get(collection)?.get(key) ?? null;
    },
    async list(collection: string) {
      return [...(store.get(collection)?.keys() ?? [])];
    },
    async delete(collection: string, key: string) {
      return store.get(collection)?.delete(key) ?? false;
    },
  };
}

function makeCtx(agentId = 'test-agent', sessionId = 'sess-1'): IPCContext {
  return { agentId, sessionId } as IPCContext;
}

function makeMockProviders(docs: ReturnType<typeof createMockDocStore>): ProviderRegistry {
  return {
    storage: { documents: docs },
    audit: {
      log: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
    },
  } as unknown as ProviderRegistry;
}

describe('cowork plugin handlers', () => {
  let docs: ReturnType<typeof createMockDocStore>;
  let providers: ProviderRegistry;
  let mcpManager: McpConnectionManager;

  beforeEach(() => {
    docs = createMockDocStore();
    providers = makeMockProviders(docs);
    mcpManager = new McpConnectionManager();
  });

  describe('plugin_list_cowork', () => {
    it('returns empty list for a fresh agent', async () => {
      const handlers = createCoworkPluginHandlers(providers, { mcpManager });
      const result = await handlers.plugin_list_cowork({}, makeCtx());
      expect(result.plugins).toEqual([]);
    });

    it('returns empty list when no storage provider', async () => {
      const noStorage = { audit: providers.audit } as unknown as ProviderRegistry;
      const handlers = createCoworkPluginHandlers(noStorage, { mcpManager });
      const result = await handlers.plugin_list_cowork({}, makeCtx());
      expect(result.plugins).toEqual([]);
    });

    it('returns plugins stored for the agent', async () => {
      // Manually insert a plugin record
      const record = {
        pluginName: 'test-plugin',
        source: 'github:test-org/test-plugin',
        version: '1.0.0',
        description: 'A test plugin',
        agentId: 'test-agent',
        skillCount: 2,
        commandCount: 1,
        mcpServers: [{ name: 'test-mcp', type: 'http', url: 'https://example.com/mcp' }],
        installedAt: '2026-03-29T00:00:00.000Z',
      };
      await docs.put('plugins', 'test-agent/test-plugin', JSON.stringify(record));

      const handlers = createCoworkPluginHandlers(providers, { mcpManager });
      const result = await handlers.plugin_list_cowork({}, makeCtx());

      expect(result.plugins).toHaveLength(1);
      expect(result.plugins[0]).toEqual({
        name: 'test-plugin',
        version: '1.0.0',
        description: 'A test plugin',
        source: 'github:test-org/test-plugin',
        skills: 2,
        commands: 1,
        mcpServers: ['test-mcp'],
        installedAt: '2026-03-29T00:00:00.000Z',
      });
    });

    it('only returns plugins for the requesting agent', async () => {
      const record = {
        pluginName: 'other-plugin',
        source: 'github:other/plugin',
        version: '1.0.0',
        description: 'Other',
        agentId: 'other-agent',
        skillCount: 0,
        commandCount: 0,
        mcpServers: [],
        installedAt: '2026-03-29T00:00:00.000Z',
      };
      await docs.put('plugins', 'other-agent/other-plugin', JSON.stringify(record));

      const handlers = createCoworkPluginHandlers(providers, { mcpManager });
      const result = await handlers.plugin_list_cowork({}, makeCtx('test-agent'));
      expect(result.plugins).toEqual([]);
    });
  });

  describe('plugin_install_cowork', () => {
    it('returns error when no storage provider', async () => {
      const noStorage = { audit: providers.audit } as unknown as ProviderRegistry;
      const handlers = createCoworkPluginHandlers(noStorage, { mcpManager });
      const result = await handlers.plugin_install_cowork(
        { source: 'github:test/plugin' },
        makeCtx(),
      );
      expect(result.installed).toBe(false);
      expect(result.reason).toContain('No storage provider');
    });
  });

  describe('plugin_uninstall_cowork', () => {
    it('returns error when no storage provider', async () => {
      const noStorage = { audit: providers.audit } as unknown as ProviderRegistry;
      const handlers = createCoworkPluginHandlers(noStorage, { mcpManager });
      const result = await handlers.plugin_uninstall_cowork(
        { pluginName: 'test-plugin' },
        makeCtx(),
      );
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('No storage provider');
    });

    it('returns error when plugin not installed', async () => {
      const handlers = createCoworkPluginHandlers(providers, { mcpManager });
      const result = await handlers.plugin_uninstall_cowork(
        { pluginName: 'nonexistent' },
        makeCtx(),
      );
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('not installed');
    });
  });
});
