import type { DocumentStore } from '../providers/storage/types.js';
import type { McpConnectionManager } from './mcp-manager.js';
import type { AuditProvider } from '../providers/audit/types.js';
import type { ProxyDomainList } from '../host/proxy-domain-list.js';
import type { DatabaseProvider } from '../providers/database/types.js';
import { parsePluginSource, fetchPluginFiles } from './fetcher.js';
import { parsePluginBundle } from './parser.js';
import { upsertPlugin, deletePlugin, getPlugin } from './store.js';
import { upsertCommand, deleteCommandsByPlugin } from './store.js';
import { upsertSkill } from '../providers/storage/skills.js';
import { inferMcpApps } from '../providers/storage/skills.js';
import { getLogger } from '../logger.js';

const logger = getLogger().child({ component: 'plugin-install' });

export interface InstallPluginInput {
  source: string;
  agentId: string;
  documents: DocumentStore;
  mcpManager: McpConnectionManager;
  audit?: AuditProvider;
  domainList?: ProxyDomainList;
  sessionId?: string;
  /** Database provider — used to persist MCP servers globally. */
  database?: DatabaseProvider;
  /** When true, the plugin's skills are shared with the company (visible to all agents). */
  shared?: boolean;
}

export interface InstallPluginResult {
  installed: boolean;
  pluginName?: string;
  version?: string;
  skillCount?: number;
  commandCount?: number;
  mcpServerCount?: number;
  mcpServerNames?: string[];
  reason?: string;
}

export async function installPlugin(input: InstallPluginInput): Promise<InstallPluginResult> {
  const { source, agentId, documents, mcpManager } = input;

  // 1. Fetch files
  let parsedSource;
  try {
    parsedSource = parsePluginSource(source);
  } catch (err) {
    return { installed: false, reason: `Invalid plugin source: ${(err as Error).message}` };
  }
  let files: Map<string, string>;
  try {
    files = await fetchPluginFiles(parsedSource);
  } catch (err) {
    return { installed: false, reason: `Failed to fetch plugin: ${(err as Error).message}` };
  }

  // 2. Parse bundle
  let bundle;
  try {
    bundle = parsePluginBundle(files);
  } catch (err) {
    return { installed: false, reason: (err as Error).message };
  }

  const pluginName = bundle.manifest.name;
  logger.info('plugin_install_start', { pluginName, agentId, source });

  // 2b. If plugin is already installed, uninstall old version first
  const existing = await getPlugin(documents, agentId, pluginName);
  if (existing) {
    logger.info('plugin_reinstall_replacing_old', { pluginName, agentId });
    // Remove old skills
    const allSkillKeys = await documents.list('skills');
    const skillPrefix = `${agentId}/plugin:${pluginName}:`;
    for (const key of allSkillKeys) {
      if (key.startsWith(skillPrefix)) {
        await documents.delete('skills', key);
      }
    }
    // Remove old commands
    await deleteCommandsByPlugin(documents, agentId, pluginName);
    // Remove old MCP servers
    mcpManager.removeServersByPlugin(agentId, pluginName);
    // Remove old plugin record
    await deletePlugin(documents, agentId, pluginName);
  }

  // 3. Store skills (reuse existing skill storage with plugin: prefix)
  for (const skill of bundle.skills) {
    const skillId = `plugin:${pluginName}:${skill.name}`;
    const mcpApps = inferMcpApps(skill.content);
    await upsertSkill(documents, {
      id: skillId,
      agentId,
      version: bundle.manifest.version,
      instructions: skill.content,
      mcpApps,
    });
  }

  // 4. Store commands
  for (const cmd of bundle.commands) {
    await upsertCommand(documents, {
      name: cmd.name,
      pluginName,
      agentId,
      content: cmd.content,
    });
  }

  // 5. Register MCP servers globally (live + persisted to DB + assigned to agent)
  for (const server of bundle.mcpServers) {
    mcpManager.addServer(agentId, server, pluginName);
    if (input.database) {
      try {
        const { addGlobalMcpServer, assignServerToAgent } = await import('../providers/mcp/database.js');
        await addGlobalMcpServer(input.database.db, server.name, server.url);
        await assignServerToAgent(input.database.db, agentId, server.name);
      } catch {
        // Server may already exist (e.g. reinstall) — just ensure assignment
        try {
          const { assignServerToAgent } = await import('../providers/mcp/database.js');
          await assignServerToAgent(input.database.db, agentId, server.name);
        } catch { /* ignore */ }
      }
    }
  }

  // 6. Add MCP server domains to proxy allowlist
  if (input.domainList) {
    for (const server of bundle.mcpServers) {
      try {
        const url = new URL(server.url);
        input.domainList.addSkillDomains(`plugin:${agentId}:${pluginName}`, [url.hostname]);
      } catch { /* invalid URL -- skip */ }
    }
  }

  // 7. Store plugin metadata (includes mcpServers for restart recovery)
  await upsertPlugin(documents, {
    pluginName,
    source,
    version: bundle.manifest.version,
    description: bundle.manifest.description,
    agentId,
    skillCount: bundle.skills.length,
    commandCount: bundle.commands.length,
    mcpServers: bundle.mcpServers,
    shared: input.shared,
  });

  // 8. Audit log
  if (input.audit) {
    await input.audit.log({
      action: 'plugin_install',
      sessionId: input.sessionId ?? 'cli',
      args: { pluginName, source, agentId, skillCount: bundle.skills.length, commandCount: bundle.commands.length },
      result: 'success',
    });
  }

  logger.info('plugin_install_complete', {
    pluginName, agentId,
    skills: bundle.skills.length,
    commands: bundle.commands.length,
    mcpServers: bundle.mcpServers.length,
  });

  return {
    installed: true,
    pluginName,
    version: bundle.manifest.version,
    skillCount: bundle.skills.length,
    commandCount: bundle.commands.length,
    mcpServerCount: bundle.mcpServers.length,
    mcpServerNames: bundle.mcpServers.map(s => s.name),
  };
}

export async function uninstallPlugin(input: {
  pluginName: string;
  agentId: string;
  documents: DocumentStore;
  mcpManager: McpConnectionManager;
  audit?: AuditProvider;
  domainList?: ProxyDomainList;
  sessionId?: string;
  /** Database provider — used to remove persisted MCP servers. */
  database?: DatabaseProvider;
}): Promise<{ ok: boolean; reason?: string }> {
  const { pluginName, agentId, documents, mcpManager } = input;

  const existing = await getPlugin(documents, agentId, pluginName);
  if (!existing) {
    return { ok: false, reason: `Plugin "${pluginName}" is not installed for agent "${agentId}".` };
  }

  // Remove skills with plugin prefix
  const allSkillKeys = await documents.list('skills');
  const skillPrefix = `${agentId}/plugin:${pluginName}:`;
  for (const key of allSkillKeys) {
    if (key.startsWith(skillPrefix)) {
      await documents.delete('skills', key);
    }
  }

  // Remove commands
  await deleteCommandsByPlugin(documents, agentId, pluginName);

  // Remove MCP servers: unassign this agent first, then remove global server
  // only if no other agents still reference it.
  mcpManager.removeServersByPlugin(agentId, pluginName);
  if (input.database && existing.mcpServers) {
    const { unassignServerFromAgent, countServerAssignments, removeGlobalMcpServer } = await import('../providers/mcp/database.js');
    for (const server of existing.mcpServers) {
      try {
        await unassignServerFromAgent(input.database.db, agentId, server.name);
        const remaining = await countServerAssignments(input.database.db, server.name);
        if (remaining === 0) {
          await removeGlobalMcpServer(input.database.db, server.name);
        }
      } catch { /* ignore — table may not exist */ }
    }
  }

  // Remove proxy domains
  if (input.domainList) {
    input.domainList.removeSkillDomains(`plugin:${agentId}:${pluginName}`);
  }

  // Remove plugin record
  await deletePlugin(documents, agentId, pluginName);

  if (input.audit) {
    await input.audit.log({
      action: 'plugin_uninstall',
      sessionId: input.sessionId ?? 'cli',
      args: { pluginName, agentId },
      result: 'success',
    });
  }

  logger.info('plugin_uninstall_complete', { pluginName, agentId });
  return { ok: true };
}
