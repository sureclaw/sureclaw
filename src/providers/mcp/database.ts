// src/providers/mcp/database.ts — Database-backed MCP provider
import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { Config, TaintTag } from '../../types.js';
import type {
  McpProvider, McpToolSchema, McpToolCall, McpToolResult, McpCredentialStatus,
} from './types.js';
import type { DatabaseProvider } from '../database/types.js';
import type { CredentialProvider } from '../credentials/types.js';
import { connectAndListTools, callToolOnServer } from '../../plugins/mcp-client.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface McpServerRow {
  id: string;
  name: string;
  url: string;
  headers: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Circuit Breaker (per-server)
// ---------------------------------------------------------------------------

export class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;
  private readonly threshold: number;
  private readonly cooldownMs: number;

  constructor(threshold: number, cooldownMs: number) {
    this.threshold = threshold;
    this.cooldownMs = cooldownMs;
  }

  get isOpen(): boolean {
    if (this.failures < this.threshold) return false;
    if (Date.now() - this.openedAt >= this.cooldownMs) {
      this.reset();
      return false;
    }
    return true;
  }

  recordFailure(): void {
    this.failures++;
    if (this.failures >= this.threshold) {
      this.openedAt = Date.now();
    }
  }

  reset(): void {
    this.failures = 0;
    this.openedAt = 0;
  }
}

// ---------------------------------------------------------------------------
// Helpers (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Resolve `{CRED_NAME}` placeholders in header values via the credential provider.
 * Returns a plain object of resolved headers.
 */
export async function resolveHeaders(
  headersJson: string | null | undefined,
  credentials: CredentialProvider,
): Promise<Record<string, string>> {
  if (!headersJson) return {};
  const raw: Record<string, string> = JSON.parse(headersJson);
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    resolved[key] = await replacePlaceholders(value, credentials);
  }
  return resolved;
}

async function replacePlaceholders(value: string, credentials: CredentialProvider): Promise<string> {
  const matches = value.matchAll(/\{([A-Z0-9_]+)\}/g);
  let result = value;
  for (const match of matches) {
    const credName = match[1];
    const credValue = await credentials.get(credName);
    if (credValue !== null) {
      result = result.split(match[0]).join(credValue);
    }
  }
  return result;
}

/**
 * Parse a prefixed tool name (`server__tool`) into its server and tool parts.
 * Returns undefined if the name doesn't contain a `__` separator.
 */
export function parseServerFromToolName(name: string): { server: string; tool: string } | undefined {
  const idx = name.indexOf('__');
  if (idx < 0) return undefined;
  return {
    server: name.slice(0, idx),
    tool: name.slice(idx + 2),
  };
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

class DatabaseMcpProvider implements McpProvider {
  private readonly db: Kysely<any>;
  private readonly credentials: CredentialProvider;
  private readonly breakers = new Map<string, CircuitBreaker>();

  constructor(db: Kysely<any>, credentials: CredentialProvider) {
    this.db = db;
    this.credentials = credentials;
  }

  private getBreaker(serverName: string): CircuitBreaker {
    let breaker = this.breakers.get(serverName);
    if (!breaker) {
      breaker = new CircuitBreaker(5, 30_000);
      this.breakers.set(serverName, breaker);
    }
    return breaker;
  }

  async callTool(call: McpToolCall): Promise<McpToolResult> {
    const parsed = parseServerFromToolName(call.tool);
    if (!parsed) throw new Error(`Invalid MCP tool name: ${call.tool} (expected server__tool format)`);

    const servers = await getEnabledServers(this.db, call.agentId);
    const server = servers.find(s => s.name === parsed.server);
    if (!server) throw new Error(`MCP server "${parsed.server}" not found for agent ${call.agentId}`);

    const breaker = this.getBreaker(server.name);
    if (breaker.isOpen) {
      throw new Error(`MCP server "${server.name}" circuit breaker is open — too many consecutive failures`);
    }

    try {
      const headers = await resolveHeaders(server.headers, this.credentials);
      const result = await callToolOnServer(server.url, parsed.tool, call.arguments ?? {}, { headers });

      breaker.reset();

      const taint: TaintTag = {
        source: `mcp:${server.name}:${parsed.tool}`,
        trust: 'external',
        timestamp: new Date(),
      };

      return {
        content: result.content,
        isError: result.isError,
        taint,
      };
    } catch (err) {
      breaker.recordFailure();
      throw err;
    }
  }

  async credentialStatus(_agentId: string, app: string): Promise<McpCredentialStatus> {
    return { available: false, app, authType: 'api_key' };
  }

  async storeCredential(_agentId: string, app: string, value: string): Promise<void> {
    await this.credentials.set(app, value);
  }

  async listApps(): Promise<Array<{ name: string; description: string; authType: 'oauth' | 'api_key' }>> {
    const rows = await this.db
      .selectFrom('mcp_servers')
      .select('name')
      .distinct()
      .execute() as Array<{ name: string }>;
    return rows.map(r => ({ name: r.name, description: `MCP server: ${r.name}`, authType: 'api_key' as const }));
  }
}

// ---------------------------------------------------------------------------
// Global MCP Server CRUD
// ---------------------------------------------------------------------------

async function getEnabledServers(db: Kysely<any>, agentId: string): Promise<McpServerRow[]> {
  return listAgentServers(db, agentId);
}

export async function listAllMcpServers(db: Kysely<any>): Promise<McpServerRow[]> {
  return db
    .selectFrom('mcp_servers')
    .selectAll()
    .orderBy('name')
    .execute() as Promise<McpServerRow[]>;
}

export async function addGlobalMcpServer(
  db: Kysely<any>,
  name: string,
  url: string,
  headers?: Record<string, string>,
): Promise<McpServerRow> {
  const id = randomUUID();
  const now = new Date().toISOString();
  await db
    .insertInto('mcp_servers')
    .values({
      id,
      name,
      url,
      headers: headers ? JSON.stringify(headers) : null,
      enabled: 1,
      created_at: now,
      updated_at: now,
    })
    .execute();
  return { id, name, url, headers: headers ? JSON.stringify(headers) : null, enabled: 1, created_at: now, updated_at: now };
}

export async function removeGlobalMcpServer(db: Kysely<any>, name: string): Promise<boolean> {
  // Also remove agent assignments
  try { await db.deleteFrom('agent_mcp_servers').where('server_name', '=', name).execute(); } catch { /* table may not exist yet */ }
  const result = await db
    .deleteFrom('mcp_servers')
    .where('name', '=', name)
    .executeTakeFirst();
  return (result?.numDeletedRows ?? 0n) > 0n;
}

export async function updateGlobalMcpServer(
  db: Kysely<any>,
  name: string,
  updates: { url?: string; headers?: Record<string, string>; enabled?: boolean },
): Promise<boolean> {
  const set: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (updates.url !== undefined) set.url = updates.url;
  if (updates.headers !== undefined) set.headers = JSON.stringify(updates.headers);
  if (updates.enabled !== undefined) set.enabled = updates.enabled ? 1 : 0;

  const result = await db
    .updateTable('mcp_servers')
    .set(set)
    .where('name', '=', name)
    .executeTakeFirst();
  return (result?.numUpdatedRows ?? 0n) > 0n;
}

export async function testGlobalMcpServer(
  db: Kysely<any>,
  name: string,
  credentials: CredentialProvider,
): Promise<{ ok: boolean; tools?: McpToolSchema[]; error?: string }> {
  const rows = await db
    .selectFrom('mcp_servers')
    .selectAll()
    .where('name', '=', name)
    .execute() as McpServerRow[];

  if (rows.length === 0) return { ok: false, error: `Server "${name}" not found` };
  const server = rows[0];

  try {
    const headers = await resolveHeaders(server.headers, credentials);
    const tools = await connectAndListTools(server.url, { headers });
    return { ok: true, tools };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

// ---------------------------------------------------------------------------
// Agent ↔ MCP Server assignment
// ---------------------------------------------------------------------------

/** Assign a global MCP server to an agent. */
export async function assignServerToAgent(db: Kysely<any>, agentId: string, serverName: string): Promise<void> {
  try {
    await db
      .insertInto('agent_mcp_servers')
      .values({ agent_id: agentId, server_name: serverName })
      .execute();
  } catch {
    // Already assigned (unique constraint) — that's fine
  }
}

/** Remove an agent's assignment to an MCP server. */
export async function unassignServerFromAgent(db: Kysely<any>, agentId: string, serverName: string): Promise<boolean> {
  const result = await db
    .deleteFrom('agent_mcp_servers')
    .where('agent_id', '=', agentId)
    .where('server_name', '=', serverName)
    .executeTakeFirst();
  return (result?.numDeletedRows ?? 0n) > 0n;
}

/** Count how many agents are assigned to a given server. */
export async function countServerAssignments(db: Kysely<any>, serverName: string): Promise<number> {
  const result = await db
    .selectFrom('agent_mcp_servers')
    .select(db.fn.countAll<number>().as('count'))
    .where('server_name', '=', serverName)
    .executeTakeFirst();
  return Number(result?.count ?? 0);
}

/** List MCP server names assigned to an agent. */
export async function listAgentServerNames(db: Kysely<any>, agentId: string): Promise<string[]> {
  const rows = await db
    .selectFrom('agent_mcp_servers')
    .select('server_name')
    .where('agent_id', '=', agentId)
    .execute() as Array<{ server_name: string }>;
  return rows.map(r => r.server_name);
}

/** List full MCP server records assigned to an agent. */
export async function listAgentServers(db: Kysely<any>, agentId: string): Promise<McpServerRow[]> {
  return db
    .selectFrom('mcp_servers')
    .innerJoin('agent_mcp_servers', 'mcp_servers.name', 'agent_mcp_servers.server_name')
    .selectAll('mcp_servers')
    .where('agent_mcp_servers.agent_id', '=', agentId)
    .where('mcp_servers.enabled', '=', 1)
    .execute() as Promise<McpServerRow[]>;
}

// Legacy compat wrappers (used by CLI, old admin routes)
/** @deprecated Use addGlobalMcpServer */
export const addMcpServer = (_db: Kysely<any>, _agentId: string, name: string, url: string, headers?: Record<string, string>) => addGlobalMcpServer(_db, name, url, headers);
/** @deprecated Use removeGlobalMcpServer */
export const removeMcpServer = (_db: Kysely<any>, _agentId: string, name: string) => removeGlobalMcpServer(_db, name);
/** @deprecated Use listAllMcpServers */
export const listMcpServers = (_db: Kysely<any>, _agentId: string) => listAllMcpServers(_db);
/** @deprecated Use updateGlobalMcpServer */
export const updateMcpServer = (_db: Kysely<any>, _agentId: string, name: string, updates: { url?: string; headers?: Record<string, string>; enabled?: boolean }) => updateGlobalMcpServer(_db, name, updates);
/** @deprecated Use testGlobalMcpServer */
export const testMcpServer = (_db: Kysely<any>, _agentId: string, name: string, credentials: CredentialProvider) => testGlobalMcpServer(_db, name, credentials);

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export async function create(
  _config: Config,
  _name: string,
  deps: { database: DatabaseProvider; credentials: CredentialProvider },
): Promise<McpProvider> {
  return new DatabaseMcpProvider(deps.database.db, deps.credentials);
}
