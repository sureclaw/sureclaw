/**
 * Plugin & command CRUD operations for database-stored Cowork plugins.
 *
 * Uses DocumentStore with JSON serialization, following the same pattern
 * as src/providers/storage/skills.ts.
 *
 * Two collections:
 *  - 'plugins'  — key: '{agentId}/{pluginName}'
 *  - 'commands' — key: '{agentId}/{commandName}'
 */

import type { DocumentStore } from '../providers/storage/types.js';
import type { InstalledPlugin, PluginMcpServer } from './types.js';

// ---------------------------------------------------------------------------
// Plugin CRUD
// ---------------------------------------------------------------------------

function pluginKey(agentId: string, pluginName: string): string {
  return `${agentId}/${pluginName}`;
}

export interface PluginUpsertInput {
  pluginName: string;
  source: string;
  version: string;
  description: string;
  agentId: string;
  skillCount: number;
  commandCount: number;
  mcpServers: PluginMcpServer[];
}

export async function upsertPlugin(
  documents: DocumentStore,
  input: PluginUpsertInput,
): Promise<void> {
  const record: InstalledPlugin = {
    ...input,
    installedAt: new Date().toISOString(),
  };
  await documents.put(
    'plugins',
    pluginKey(input.agentId, input.pluginName),
    JSON.stringify(record),
  );
}

export async function getPlugin(
  documents: DocumentStore,
  agentId: string,
  pluginName: string,
): Promise<InstalledPlugin | null> {
  const raw = await documents.get('plugins', pluginKey(agentId, pluginName));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as InstalledPlugin;
  } catch {
    return null;
  }
}

/** List all plugins for an agent. N+1 fetch pattern — acceptable for typical
 *  plugin counts (<50). If DocumentStore grows a batch-get API, use it here. */
export async function listPlugins(
  documents: DocumentStore,
  agentId: string,
): Promise<InstalledPlugin[]> {
  const keys = await documents.list('plugins');
  const prefix = `${agentId}/`;
  const plugins: InstalledPlugin[] = [];

  for (const key of keys) {
    if (!key.startsWith(prefix)) continue;
    const raw = await documents.get('plugins', key);
    if (!raw) continue;
    try {
      plugins.push(JSON.parse(raw) as InstalledPlugin);
    } catch {
      // Malformed — skip
    }
  }

  return plugins;
}

export async function deletePlugin(
  documents: DocumentStore,
  agentId: string,
  pluginName: string,
): Promise<boolean> {
  return documents.delete('plugins', pluginKey(agentId, pluginName));
}

// ---------------------------------------------------------------------------
// Command CRUD
// ---------------------------------------------------------------------------

export interface CommandRecord {
  name: string;
  pluginName: string;
  agentId: string;
  content: string;
  installedAt: string;
}

function commandKey(agentId: string, pluginName: string, commandName: string): string {
  return `${agentId}/${pluginName}/${commandName}`;
}

export async function upsertCommand(
  documents: DocumentStore,
  input: { name: string; pluginName: string; agentId: string; content: string },
): Promise<void> {
  const record: CommandRecord = {
    ...input,
    installedAt: new Date().toISOString(),
  };
  await documents.put(
    'commands',
    commandKey(input.agentId, input.pluginName, input.name),
    JSON.stringify(record),
  );
}

export async function listCommands(
  documents: DocumentStore,
  agentId: string,
): Promise<CommandRecord[]> {
  const keys = await documents.list('commands');
  const prefix = `${agentId}/`;
  const commands: CommandRecord[] = [];

  for (const key of keys) {
    if (!key.startsWith(prefix)) continue;
    const raw = await documents.get('commands', key);
    if (!raw) continue;
    try {
      commands.push(JSON.parse(raw) as CommandRecord);
    } catch {
      // Malformed — skip
    }
  }

  return commands;
}

export async function deleteCommandsByPlugin(
  documents: DocumentStore,
  agentId: string,
  pluginName: string,
): Promise<void> {
  const keys = await documents.list('commands');
  const prefix = `${agentId}/${pluginName}/`;
  for (const key of keys) {
    if (key.startsWith(prefix)) {
      await documents.delete('commands', key);
    }
  }
}
