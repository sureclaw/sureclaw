/**
 * CLI commands for Cowork plugin management: ax plugin install/remove/list
 *
 * Cowork plugins are file-based bundles (skills + commands + MCP servers)
 * from Claude Cowork, scoped per-agent.
 */

import { loadConfig } from '../config.js';
import { loadProviders } from '../host/registry.js';
import { McpConnectionManager } from '../plugins/mcp-manager.js';
import { installPlugin, uninstallPlugin } from '../plugins/install.js';
import { listPlugins } from '../plugins/store.js';

export async function runPlugin(args: string[]): Promise<void> {
  const subcommand = args[0];
  switch (subcommand) {
    case 'install': await pluginInstall(args.slice(1)); break;
    case 'remove': await pluginRemove(args.slice(1)); break;
    case 'list': await pluginList(args.slice(1)); break;
    default: showPluginHelp(); break;
  }
}

function showPluginHelp(): void {
  console.log(`
AX Plugin Manager (Cowork Plugins)

Usage:
  ax plugin install <source> [--agent <name>]   Install a Cowork plugin
  ax plugin remove <name> [--agent <name>]      Remove an installed plugin
  ax plugin list [--agent <name>]               List installed plugins

Sources:
  anthropics/knowledge-work-plugins/sales       GitHub owner/repo/subdir
  ./plugins/my-custom-plugin                    Local directory
  https://github.com/org/repo                   GitHub URL

Examples:
  ax plugin install anthropics/knowledge-work-plugins/sales --agent pi
  ax plugin install ./plugins/internal-legal --agent counsel
  ax plugin list --agent pi
  ax plugin remove sales --agent pi
`);
}

function parseAgentFlag(args: string[]): { agentId: string; remaining: string[] } {
  const idx = args.indexOf('--agent');
  if (idx >= 0 && args[idx + 1]) {
    const agentId = args[idx + 1];
    const remaining = [...args.slice(0, idx), ...args.slice(idx + 2)];
    return { agentId, remaining };
  }
  return { agentId: 'main', remaining: args };
}

async function loadDeps() {
  const config = loadConfig();
  const providers = await loadProviders(config);
  if (!providers.storage.documents) {
    console.error('Error: No storage provider configured. Run "ax configure" first.');
    process.exit(1);
  }
  return { documents: providers.storage.documents, audit: providers.audit };
}

async function pluginInstall(args: string[]): Promise<void> {
  const { agentId, remaining } = parseAgentFlag(args);
  const source = remaining[0];
  if (!source) {
    console.error('Error: Source required. Usage: ax plugin install <source> [--agent <name>]');
    process.exit(1);
  }

  console.log(`Installing plugin from ${source} for agent "${agentId}"...`);

  const { documents, audit } = await loadDeps();
  const mcpManager = new McpConnectionManager();

  const result = await installPlugin({ source, agentId, documents, mcpManager, audit });

  if (!result.installed) {
    console.error(`Failed: ${result.reason}`);
    process.exit(1);
  }

  console.log('');
  console.log(`Plugin "${result.pluginName}" v${result.version} installed for agent "${agentId}".`);
  console.log('');
  console.log('  Components:');
  if (result.skillCount) console.log(`    ${result.skillCount} skills`);
  if (result.commandCount) console.log(`    ${result.commandCount} commands`);
  if (result.mcpServerCount) {
    console.log(`    ${result.mcpServerCount} MCP servers (${result.mcpServerNames!.join(', ')})`);
    console.log('');
    console.log('  MCP servers may need authentication.');
    console.log('  Connect them in the dashboard: http://localhost:8080/admin/connectors');
  }
  console.log('');
}

async function pluginRemove(args: string[]): Promise<void> {
  const { agentId, remaining } = parseAgentFlag(args);
  const pluginName = remaining[0];
  if (!pluginName) {
    console.error('Error: Plugin name required. Usage: ax plugin remove <name> [--agent <name>]');
    process.exit(1);
  }

  const { documents, audit } = await loadDeps();
  const mcpManager = new McpConnectionManager();

  const result = await uninstallPlugin({ pluginName, agentId, documents, mcpManager, audit });

  if (!result.ok) {
    console.error(`Failed: ${result.reason}`);
    process.exit(1);
  }

  console.log(`Plugin "${pluginName}" removed from agent "${agentId}".`);
}

async function pluginList(args: string[]): Promise<void> {
  const { agentId } = parseAgentFlag(args);
  const { documents } = await loadDeps();

  const plugins = await listPlugins(documents, agentId);
  if (plugins.length === 0) {
    console.log(`No plugins installed for agent "${agentId}".`);
    return;
  }

  console.log(`Plugins for agent "${agentId}":\n`);
  for (const p of plugins) {
    console.log(`  ${p.pluginName} v${p.version}`);
    console.log(`    ${p.description}`);
    const mcpNames = p.mcpServers.map(s => s.name).join(', ') || 'none';
    console.log(`    Skills: ${p.skillCount}  Commands: ${p.commandCount}  MCP: ${mcpNames}`);
    console.log(`    Source: ${p.source}`);
    console.log('');
  }
}
