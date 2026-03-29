/**
 * CLI commands for MCP server management: ax mcp add/remove/list/test
 *
 * Manages per-agent MCP server definitions in the database.
 */

import { loadConfig } from '../config.js';
import { resolveProviderPath } from '../host/provider-map.js';
import type { DatabaseProvider } from '../providers/database/types.js';
import type { CredentialProvider } from '../providers/credentials/types.js';
import { storageMigrations } from '../providers/storage/migrations.js';
import { runMigrations } from '../utils/migrator.js';

async function loadDeps(): Promise<{ database: DatabaseProvider; credentials: CredentialProvider }> {
  const config = loadConfig();

  // Load database provider
  const dbModPath = resolveProviderPath('database', config.providers.database ?? 'sqlite');
  const dbMod = await import(dbModPath);
  const database: DatabaseProvider = await dbMod.create(config);

  // Run storage migrations (ensures mcp_servers table exists)
  await runMigrations(database.db, storageMigrations(database.type));

  // Load credential provider
  const needsDb = config.providers.credentials === 'database';
  let credentials: CredentialProvider;
  if (needsDb) {
    const credModPath = resolveProviderPath('credentials', 'database');
    const credMod = await import(credModPath);
    credentials = await credMod.create(config, 'database', { database });
  } else {
    const credModPath = resolveProviderPath('credentials', config.providers.credentials);
    const credMod = await import(credModPath);
    credentials = await credMod.create(config, config.providers.credentials);
  }

  return { database, credentials };
}

async function handleAdd(args: string[]): Promise<void> {
  if (args.length < 2) {
    console.error('Usage: ax mcp add <agent> <name> --url <url> [--header "Key: Value"]...');
    process.exit(1);
  }

  const agentId = args[0];
  const name = args[1];
  let url = '';
  const headers: Record<string, string> = {};

  for (let i = 2; i < args.length; i++) {
    if (args[i] === '--url' && args[i + 1]) {
      url = args[++i];
    } else if (args[i] === '--header' && args[i + 1]) {
      const h = args[++i];
      const colonIdx = h.indexOf(':');
      if (colonIdx > 0) {
        headers[h.slice(0, colonIdx).trim()] = h.slice(colonIdx + 1).trim();
      }
    }
  }

  if (!url) {
    console.error('Error: --url is required');
    process.exit(1);
  }

  try {
    new URL(url);
  } catch {
    console.error(`Error: invalid URL "${url}"`);
    process.exit(1);
  }

  const { database } = await loadDeps();
  const { addMcpServer } = await import('../providers/mcp/database.js');
  const server = await addMcpServer(database.db, agentId, name, url, Object.keys(headers).length > 0 ? headers : undefined);
  console.log(`Added MCP server "${server.name}" for agent "${agentId}"`);
  await database.close();
}

async function handleRemove(args: string[]): Promise<void> {
  if (args.length < 2) {
    console.error('Usage: ax mcp remove <agent> <name>');
    process.exit(1);
  }

  const [agentId, name] = args;
  const { database } = await loadDeps();
  const { removeMcpServer } = await import('../providers/mcp/database.js');
  const removed = await removeMcpServer(database.db, agentId, name);
  if (removed) {
    console.log(`Removed MCP server "${name}" for agent "${agentId}"`);
  } else {
    console.error(`MCP server "${name}" not found for agent "${agentId}"`);
  }
  await database.close();
}

async function handleList(args: string[]): Promise<void> {
  if (args.length < 1) {
    console.error('Usage: ax mcp list <agent>');
    process.exit(1);
  }

  const agentId = args[0];
  const { database } = await loadDeps();
  const { listMcpServers } = await import('../providers/mcp/database.js');
  const servers = await listMcpServers(database.db, agentId);

  if (servers.length === 0) {
    console.log(`No MCP servers configured for agent "${agentId}"`);
  } else {
    console.log(`MCP servers for agent "${agentId}":\n`);
    for (const s of servers) {
      const status = s.enabled ? 'enabled' : 'disabled';
      console.log(`  ${s.name.padEnd(20)} ${s.url.padEnd(40)} [${status}]`);
    }
  }
  await database.close();
}

async function handleTest(args: string[]): Promise<void> {
  if (args.length < 2) {
    console.error('Usage: ax mcp test <agent> <name>');
    process.exit(1);
  }

  const [agentId, name] = args;
  const { database, credentials } = await loadDeps();
  const { testMcpServer } = await import('../providers/mcp/database.js');
  const result = await testMcpServer(database.db, agentId, name, credentials);

  if (result.ok) {
    console.log(`Server "${name}" is reachable. Tools available:`);
    for (const tool of result.tools ?? []) {
      console.log(`  ${tool.name.padEnd(30)} ${tool.description ?? ''}`);
    }
  } else {
    console.error(`Server "${name}" test failed: ${result.error}`);
  }
  await database.close();
}

export async function runMcp(args: string[]): Promise<void> {
  const subcommand = args[0];
  const subArgs = args.slice(1);

  switch (subcommand) {
    case 'add':    await handleAdd(subArgs); break;
    case 'remove': await handleRemove(subArgs); break;
    case 'list':   await handleList(subArgs); break;
    case 'test':   await handleTest(subArgs); break;
    default:
      console.error(`Usage: ax mcp <add|remove|list|test> [args...]`);
      if (subcommand) console.error(`Unknown subcommand: ${subcommand}`);
      process.exit(1);
  }
}
