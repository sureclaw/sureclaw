import { describe, it, expect } from 'vitest';
import {
  upsertPlugin, getPlugin, listPlugins, deletePlugin,
  upsertCommand, listCommands, deleteCommandsByPlugin,
} from '../../src/plugins/store.js';
import type { DocumentStore } from '../../src/providers/storage/types.js';

// ---------------------------------------------------------------------------
// In-memory DocumentStore stub (same pattern as skills.test.ts)
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
// Plugin CRUD
// ---------------------------------------------------------------------------

describe('plugin CRUD (DocumentStore)', () => {
  it('upsert and retrieve a plugin', async () => {
    const docs = memoryDocuments();
    await upsertPlugin(docs, {
      pluginName: 'hubspot-crm',
      source: 'cowork:hubspot-crm',
      version: '1.2.0',
      description: 'HubSpot CRM integration',
      agentId: 'pi',
      skillCount: 3,
      commandCount: 1,
      mcpServers: [{ name: 'hubspot', type: 'http', url: 'https://mcp.hubspot.com' }],
    });

    const plugin = await getPlugin(docs, 'pi', 'hubspot-crm');
    expect(plugin).not.toBeNull();
    expect(plugin!.pluginName).toBe('hubspot-crm');
    expect(plugin!.source).toBe('cowork:hubspot-crm');
    expect(plugin!.version).toBe('1.2.0');
    expect(plugin!.description).toBe('HubSpot CRM integration');
    expect(plugin!.agentId).toBe('pi');
    expect(plugin!.skillCount).toBe(3);
    expect(plugin!.commandCount).toBe(1);
    expect(plugin!.mcpServers).toHaveLength(1);
    expect(plugin!.mcpServers[0].name).toBe('hubspot');
    expect(plugin!.installedAt).toBeTruthy();
  });

  it('upsert overwrites existing plugin', async () => {
    const docs = memoryDocuments();
    await upsertPlugin(docs, {
      pluginName: 'slack-plugin',
      source: 'cowork:slack',
      version: '1.0.0',
      description: 'v1',
      agentId: 'pi',
      skillCount: 1,
      commandCount: 0,
      mcpServers: [],
    });
    await upsertPlugin(docs, {
      pluginName: 'slack-plugin',
      source: 'cowork:slack',
      version: '2.0.0',
      description: 'v2',
      agentId: 'pi',
      skillCount: 2,
      commandCount: 1,
      mcpServers: [{ name: 'slack', type: 'http', url: 'https://mcp.slack.com' }],
    });

    const plugin = await getPlugin(docs, 'pi', 'slack-plugin');
    expect(plugin!.version).toBe('2.0.0');
    expect(plugin!.description).toBe('v2');
    expect(plugin!.skillCount).toBe(2);
    expect(plugin!.mcpServers).toHaveLength(1);
  });

  it('get returns null for non-existent plugin', async () => {
    const docs = memoryDocuments();
    expect(await getPlugin(docs, 'pi', 'nope')).toBeNull();
  });

  it('list plugins scoped to agent (pi vs counsel)', async () => {
    const docs = memoryDocuments();
    await upsertPlugin(docs, {
      pluginName: 'hubspot-crm',
      source: 'cowork:hubspot-crm',
      version: '1.0.0',
      description: 'HubSpot',
      agentId: 'pi',
      skillCount: 2,
      commandCount: 0,
      mcpServers: [],
    });
    await upsertPlugin(docs, {
      pluginName: 'slack-plugin',
      source: 'cowork:slack',
      version: '1.0.0',
      description: 'Slack',
      agentId: 'pi',
      skillCount: 1,
      commandCount: 1,
      mcpServers: [],
    });
    await upsertPlugin(docs, {
      pluginName: 'legal-docs',
      source: 'cowork:legal-docs',
      version: '1.0.0',
      description: 'Legal templates',
      agentId: 'counsel',
      skillCount: 4,
      commandCount: 2,
      mcpServers: [],
    });

    const piPlugins = await listPlugins(docs, 'pi');
    expect(piPlugins).toHaveLength(2);
    expect(piPlugins.map(p => p.pluginName).sort()).toEqual(['hubspot-crm', 'slack-plugin']);

    const counselPlugins = await listPlugins(docs, 'counsel');
    expect(counselPlugins).toHaveLength(1);
    expect(counselPlugins[0].pluginName).toBe('legal-docs');

    // Unknown agent returns empty
    const noPlugins = await listPlugins(docs, 'unknown-agent');
    expect(noPlugins).toHaveLength(0);
  });

  it('delete a plugin', async () => {
    const docs = memoryDocuments();
    await upsertPlugin(docs, {
      pluginName: 'del-me',
      source: 'cowork:del-me',
      version: '1.0.0',
      description: 'Temporary',
      agentId: 'pi',
      skillCount: 0,
      commandCount: 0,
      mcpServers: [],
    });

    expect(await getPlugin(docs, 'pi', 'del-me')).not.toBeNull();
    const deleted = await deletePlugin(docs, 'pi', 'del-me');
    expect(deleted).toBe(true);
    expect(await getPlugin(docs, 'pi', 'del-me')).toBeNull();
  });

  it('delete returns false for non-existent plugin', async () => {
    const docs = memoryDocuments();
    expect(await deletePlugin(docs, 'pi', 'nope')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Command CRUD
// ---------------------------------------------------------------------------

describe('command CRUD (DocumentStore)', () => {
  it('upsert and list commands', async () => {
    const docs = memoryDocuments();
    await upsertCommand(docs, {
      name: 'forecast',
      pluginName: 'hubspot-crm',
      agentId: 'pi',
      content: 'Generate a sales forecast based on pipeline data.',
    });
    await upsertCommand(docs, {
      name: 'deal-summary',
      pluginName: 'hubspot-crm',
      agentId: 'pi',
      content: 'Summarize the current deal status.',
    });

    const commands = await listCommands(docs, 'pi');
    expect(commands).toHaveLength(2);
    expect(commands.map(c => c.name).sort()).toEqual(['deal-summary', 'forecast']);

    const forecast = commands.find(c => c.name === 'forecast')!;
    expect(forecast.pluginName).toBe('hubspot-crm');
    expect(forecast.agentId).toBe('pi');
    expect(forecast.content).toContain('sales forecast');
    expect(forecast.installedAt).toBeTruthy();
  });

  it('commands are scoped to agent', async () => {
    const docs = memoryDocuments();
    await upsertCommand(docs, {
      name: 'forecast',
      pluginName: 'hubspot-crm',
      agentId: 'pi',
      content: 'Pi forecast',
    });
    await upsertCommand(docs, {
      name: 'brief',
      pluginName: 'legal-docs',
      agentId: 'counsel',
      content: 'Counsel brief',
    });

    const piCommands = await listCommands(docs, 'pi');
    expect(piCommands).toHaveLength(1);
    expect(piCommands[0].name).toBe('forecast');

    const counselCommands = await listCommands(docs, 'counsel');
    expect(counselCommands).toHaveLength(1);
    expect(counselCommands[0].name).toBe('brief');
  });

  it('deleteCommandsByPlugin removes only that plugin commands', async () => {
    const docs = memoryDocuments();

    // Two commands from hubspot-crm plugin
    await upsertCommand(docs, {
      name: 'forecast',
      pluginName: 'hubspot-crm',
      agentId: 'pi',
      content: 'forecast content',
    });
    await upsertCommand(docs, {
      name: 'deal-summary',
      pluginName: 'hubspot-crm',
      agentId: 'pi',
      content: 'deal summary content',
    });

    // One command from a different plugin
    await upsertCommand(docs, {
      name: 'standup',
      pluginName: 'slack-plugin',
      agentId: 'pi',
      content: 'standup content',
    });

    // Delete only hubspot-crm commands
    await deleteCommandsByPlugin(docs, 'pi', 'hubspot-crm');

    const remaining = await listCommands(docs, 'pi');
    expect(remaining).toHaveLength(1);
    expect(remaining[0].name).toBe('standup');
    expect(remaining[0].pluginName).toBe('slack-plugin');
  });

  it('deleteCommandsByPlugin does not affect other agents', async () => {
    const docs = memoryDocuments();

    await upsertCommand(docs, {
      name: 'forecast',
      pluginName: 'hubspot-crm',
      agentId: 'pi',
      content: 'pi forecast',
    });
    await upsertCommand(docs, {
      name: 'forecast',
      pluginName: 'hubspot-crm',
      agentId: 'counsel',
      content: 'counsel forecast',
    });

    // Delete pi's hubspot-crm commands only
    await deleteCommandsByPlugin(docs, 'pi', 'hubspot-crm');

    const piCommands = await listCommands(docs, 'pi');
    expect(piCommands).toHaveLength(0);

    // counsel's command is untouched
    const counselCommands = await listCommands(docs, 'counsel');
    expect(counselCommands).toHaveLength(1);
    expect(counselCommands[0].name).toBe('forecast');
  });
});
