import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DocumentStore } from '../../src/providers/storage/types.js';
import { McpConnectionManager } from '../../src/plugins/mcp-manager.js';
import { installPlugin, uninstallPlugin } from '../../src/plugins/install.js';
import type { AuditProvider } from '../../src/providers/audit/types.js';

// ---------------------------------------------------------------------------
// Mock fetcher — avoid real git clones / filesystem reads
// ---------------------------------------------------------------------------

vi.mock('../../src/plugins/fetcher.js', () => ({
  parsePluginSource: vi.fn((input: string) => ({ type: 'local', path: input })),
  fetchPluginFiles: vi.fn(),
}));

// Suppress logger output during tests
vi.mock('../../src/logger.js', () => {
  const noop = () => {};
  const noopLogger = {
    debug: noop, info: noop, warn: noop, error: noop, fatal: noop,
    child: () => noopLogger,
  };
  return { getLogger: () => noopLogger };
});

import { fetchPluginFiles } from '../../src/plugins/fetcher.js';
const mockFetchPluginFiles = vi.mocked(fetchPluginFiles);

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
// Test fixtures
// ---------------------------------------------------------------------------

function validPluginFiles(): Map<string, string> {
  const files = new Map<string, string>();

  files.set('.claude-plugin/plugin.json', JSON.stringify({
    name: 'hubspot-crm',
    version: '1.2.0',
    description: 'HubSpot CRM integration for sales teams',
  }));

  files.set('skills/call-prep/SKILL.md', [
    '# Call Prep',
    'Use hubspot_get_contacts to find contacts.',
    'Use hubspot_custom_api_call for advanced queries.',
  ].join('\n'));

  files.set('skills/deal-review/SKILL.md', [
    '# Deal Review',
    'Summarize deals using hubspot_get_deals.',
  ].join('\n'));

  files.set('commands/forecast.md', 'Generate a sales forecast based on pipeline data.');
  files.set('commands/deal-summary.md', 'Summarize the current deal status.');

  files.set('.mcp.json', JSON.stringify({
    mcpServers: {
      hubspot: { type: 'http', url: 'https://mcp.hubspot.com/v1' },
      slack: { type: 'http', url: 'https://mcp.slack.com/api' },
    },
  }));

  return files;
}

function pluginFilesNoManifest(): Map<string, string> {
  const files = new Map<string, string>();
  files.set('skills/call-prep/SKILL.md', '# Call Prep');
  return files;
}

function mockAuditProvider(): AuditProvider & { entries: Array<Record<string, unknown>> } {
  const entries: Array<Record<string, unknown>> = [];
  return {
    entries,
    async log(entry) { entries.push(entry as Record<string, unknown>); },
    async query() { return []; },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('installPlugin', () => {
  let docs: DocumentStore;
  let mcpManager: McpConnectionManager;

  beforeEach(() => {
    docs = memoryDocuments();
    mcpManager = new McpConnectionManager();
    vi.clearAllMocks();
  });

  it('installs a valid plugin — stores skills, commands, registers MCP servers, returns correct counts', async () => {
    mockFetchPluginFiles.mockResolvedValue(validPluginFiles());

    const result = await installPlugin({
      source: './fixtures/hubspot-crm',
      agentId: 'pi',
      documents: docs,
      mcpManager,
    });

    // Verify result
    expect(result.installed).toBe(true);
    expect(result.pluginName).toBe('hubspot-crm');
    expect(result.version).toBe('1.2.0');
    expect(result.skillCount).toBe(2);
    expect(result.commandCount).toBe(2);
    expect(result.mcpServerCount).toBe(2);
    expect(result.mcpServerNames).toEqual(expect.arrayContaining(['hubspot', 'slack']));

    // Verify skills stored in documents
    const skillKeys = await docs.list('skills');
    expect(skillKeys).toHaveLength(2);
    expect(skillKeys).toContain('pi/plugin:hubspot-crm:call-prep');
    expect(skillKeys).toContain('pi/plugin:hubspot-crm:deal-review');

    // Verify skill content was stored correctly
    const callPrepRaw = await docs.get('skills', 'pi/plugin:hubspot-crm:call-prep');
    expect(callPrepRaw).toBeTruthy();
    const callPrep = JSON.parse(callPrepRaw!);
    expect(callPrep.instructions).toContain('hubspot_get_contacts');
    expect(callPrep.version).toBe('1.2.0');

    // Verify commands stored
    const commandKeys = await docs.list('commands');
    expect(commandKeys).toHaveLength(2);
    const forecastRaw = await docs.get('commands', 'pi/hubspot-crm/forecast');
    expect(forecastRaw).toBeTruthy();
    const forecast = JSON.parse(forecastRaw!);
    expect(forecast.pluginName).toBe('hubspot-crm');
    expect(forecast.content).toContain('sales forecast');

    // Verify MCP servers registered
    const servers = mcpManager.listServers('pi');
    expect(servers).toHaveLength(2);
    expect(servers.map(s => s.name).sort()).toEqual(['hubspot', 'slack']);

    // Verify plugin record stored
    const pluginKeys = await docs.list('plugins');
    expect(pluginKeys).toHaveLength(1);
    const pluginRaw = await docs.get('plugins', 'pi/hubspot-crm');
    expect(pluginRaw).toBeTruthy();
    const plugin = JSON.parse(pluginRaw!);
    expect(plugin.pluginName).toBe('hubspot-crm');
    expect(plugin.version).toBe('1.2.0');
    expect(plugin.mcpServers).toHaveLength(2);
  });

  it('returns installed: false when plugin.json is missing', async () => {
    mockFetchPluginFiles.mockResolvedValue(pluginFilesNoManifest());

    const result = await installPlugin({
      source: './fixtures/bad-plugin',
      agentId: 'pi',
      documents: docs,
      mcpManager,
    });

    expect(result.installed).toBe(false);
    expect(result.reason).toContain('missing .claude-plugin/plugin.json');

    // Nothing stored
    expect(await docs.list('skills')).toHaveLength(0);
    expect(await docs.list('commands')).toHaveLength(0);
    expect(await docs.list('plugins')).toHaveLength(0);
    expect(mcpManager.listServers('pi')).toHaveLength(0);
  });

  it('returns installed: false when fetch fails', async () => {
    mockFetchPluginFiles.mockRejectedValue(new Error('Network error: repository not found'));

    const result = await installPlugin({
      source: 'nonexistent/repo',
      agentId: 'pi',
      documents: docs,
      mcpManager,
    });

    expect(result.installed).toBe(false);
    expect(result.reason).toContain('Failed to fetch plugin');
    expect(result.reason).toContain('Network error');

    // Nothing stored
    expect(await docs.list('skills')).toHaveLength(0);
    expect(await docs.list('plugins')).toHaveLength(0);
  });

  it('logs audit entry on successful install', async () => {
    mockFetchPluginFiles.mockResolvedValue(validPluginFiles());
    const audit = mockAuditProvider();

    await installPlugin({
      source: './fixtures/hubspot-crm',
      agentId: 'pi',
      documents: docs,
      mcpManager,
      audit,
      sessionId: 'sess-123',
    });

    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0].action).toBe('plugin_install');
    expect(audit.entries[0].sessionId).toBe('sess-123');
    expect((audit.entries[0].args as Record<string, unknown>).pluginName).toBe('hubspot-crm');
  });

  it('adds MCP server domains to proxy allowlist', async () => {
    mockFetchPluginFiles.mockResolvedValue(validPluginFiles());

    // Minimal domainList stub
    const addedDomains: Array<{ skillName: string; domains: string[] }> = [];
    const domainList = {
      addSkillDomains(skillName: string, domains: string[]) {
        addedDomains.push({ skillName, domains });
      },
      removeSkillDomains() {},
    } as unknown as import('../../src/host/proxy-domain-list.js').ProxyDomainList;

    await installPlugin({
      source: './fixtures/hubspot-crm',
      agentId: 'pi',
      documents: docs,
      mcpManager,
      domainList,
    });

    // Two MCP servers -> two addSkillDomains calls
    expect(addedDomains).toHaveLength(2);
    expect(addedDomains.some(d => d.domains.includes('mcp.hubspot.com'))).toBe(true);
    expect(addedDomains.some(d => d.domains.includes('mcp.slack.com'))).toBe(true);
  });
});

describe('uninstallPlugin', () => {
  let docs: DocumentStore;
  let mcpManager: McpConnectionManager;

  beforeEach(() => {
    docs = memoryDocuments();
    mcpManager = new McpConnectionManager();
    vi.clearAllMocks();
  });

  async function seedInstalledPlugin(): Promise<void> {
    // Simulate a previous install by populating store directly
    mockFetchPluginFiles.mockResolvedValue(validPluginFiles());
    await installPlugin({
      source: './fixtures/hubspot-crm',
      agentId: 'pi',
      documents: docs,
      mcpManager,
    });
  }

  it('removes skills, commands, MCP servers, and plugin record', async () => {
    await seedInstalledPlugin();

    // Verify data exists before uninstall
    expect(await docs.list('skills')).toHaveLength(2);
    expect(await docs.list('commands')).toHaveLength(2);
    expect(await docs.list('plugins')).toHaveLength(1);
    expect(mcpManager.listServers('pi')).toHaveLength(2);

    const result = await uninstallPlugin({
      pluginName: 'hubspot-crm',
      agentId: 'pi',
      documents: docs,
      mcpManager,
    });

    expect(result.ok).toBe(true);
    expect(result.reason).toBeUndefined();

    // Verify everything removed
    expect(await docs.list('skills')).toHaveLength(0);
    expect(await docs.list('commands')).toHaveLength(0);
    expect(await docs.list('plugins')).toHaveLength(0);
    expect(mcpManager.listServers('pi')).toHaveLength(0);
  });

  it('returns ok: false for non-installed plugin', async () => {
    const result = await uninstallPlugin({
      pluginName: 'not-installed',
      agentId: 'pi',
      documents: docs,
      mcpManager,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('not installed');
  });

  it('logs audit entry on successful uninstall', async () => {
    await seedInstalledPlugin();
    const audit = mockAuditProvider();

    await uninstallPlugin({
      pluginName: 'hubspot-crm',
      agentId: 'pi',
      documents: docs,
      mcpManager,
      audit,
      sessionId: 'sess-456',
    });

    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0].action).toBe('plugin_uninstall');
    expect(audit.entries[0].sessionId).toBe('sess-456');
  });

  it('removes proxy domains on uninstall', async () => {
    await seedInstalledPlugin();

    const removedSkills: string[] = [];
    const domainList = {
      addSkillDomains() {},
      removeSkillDomains(skillName: string) { removedSkills.push(skillName); },
    } as unknown as import('../../src/host/proxy-domain-list.js').ProxyDomainList;

    await uninstallPlugin({
      pluginName: 'hubspot-crm',
      agentId: 'pi',
      documents: docs,
      mcpManager,
      domainList,
    });

    expect(removedSkills).toContain('plugin:pi:hubspot-crm');
  });

  it('does not affect other agents data', async () => {
    // Install for two agents
    mockFetchPluginFiles.mockResolvedValue(validPluginFiles());
    await installPlugin({
      source: './fixtures/hubspot-crm',
      agentId: 'pi',
      documents: docs,
      mcpManager,
    });
    await installPlugin({
      source: './fixtures/hubspot-crm',
      agentId: 'counsel',
      documents: docs,
      mcpManager,
    });

    // Verify both agents have data
    const allSkills = await docs.list('skills');
    expect(allSkills).toHaveLength(4); // 2 per agent
    expect(mcpManager.listServers('pi')).toHaveLength(2);
    expect(mcpManager.listServers('counsel')).toHaveLength(2);

    // Uninstall only for pi
    await uninstallPlugin({
      pluginName: 'hubspot-crm',
      agentId: 'pi',
      documents: docs,
      mcpManager,
    });

    // pi's data is gone
    const remainingSkills = await docs.list('skills');
    expect(remainingSkills).toHaveLength(2);
    expect(remainingSkills.every(k => k.startsWith('counsel/'))).toBe(true);
    expect(mcpManager.listServers('pi')).toHaveLength(0);

    // counsel's data is untouched
    expect(mcpManager.listServers('counsel')).toHaveLength(2);
    const counselPlugin = await docs.get('plugins', 'counsel/hubspot-crm');
    expect(counselPlugin).toBeTruthy();
  });
});
