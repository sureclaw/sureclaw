// src/providers/mcp/database.ts — Database-backed MCP provider
import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { Config, TaintTag } from '../../types.js';
import type {
  McpProvider, McpToolSchema, McpToolCall, McpToolResult, McpCredentialStatus,
} from './types.js';
import type { DatabaseProvider } from '../database/types.js';
import type { CredentialProvider } from '../credentials/types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface McpServerRow {
  id: string;
  agent_id: string;
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
// JSON-RPC helpers
// ---------------------------------------------------------------------------

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

async function jsonRpcCall(
  url: string,
  method: string,
  params: unknown,
  headers: Record<string, string>,
  timeoutMs = 30_000,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`MCP server HTTP ${res.status}: ${text}`);
    }
    const data = await res.json() as JsonRpcResponse;
    if (data.error) {
      throw new Error(`MCP JSON-RPC error ${data.error.code}: ${data.error.message}`);
    }
    return data.result;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

class DatabaseMcpProvider implements McpProvider {
  private readonly db: Kysely<any>;
  private readonly credentials: CredentialProvider;
  private readonly breakers = new Map<string, CircuitBreaker>();
  private readonly toolCache = new Map<string, { tools: McpToolSchema[]; expires: number }>();
  private readonly cacheTtlMs = 60_000;

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

  async listTools(filter?: { apps?: string[]; query?: string; agentId?: string }): Promise<McpToolSchema[]> {
    if (!filter?.agentId) return [];

    const servers = await getEnabledServers(this.db, filter.agentId);
    const allTools: McpToolSchema[] = [];

    for (const server of servers) {
      // If apps filter is provided, only include matching servers
      if (filter.apps?.length && !filter.apps.includes(server.name)) continue;

      const breaker = this.getBreaker(server.name);
      if (breaker.isOpen) continue; // graceful degradation

      // Check cache
      const cacheKey = `${filter.agentId}:${server.name}`;
      const cached = this.toolCache.get(cacheKey);
      if (cached && cached.expires > Date.now()) {
        allTools.push(...cached.tools);
        continue;
      }

      try {
        const headers = await resolveHeaders(server.headers, this.credentials);
        const result = await jsonRpcCall(server.url, 'tools/list', {}, headers) as { tools?: McpToolSchema[] };
        const tools = (result?.tools ?? []).map(t => ({
          ...t,
          name: `${server.name}__${t.name}`,
        }));
        breaker.reset();
        this.toolCache.set(cacheKey, { tools, expires: Date.now() + this.cacheTtlMs });
        allTools.push(...tools);
      } catch {
        breaker.recordFailure();
        // Continue to next server — one server failing doesn't affect others
      }
    }

    // Apply query filter if provided
    if (filter.query) {
      const q = filter.query.toLowerCase();
      return allTools.filter(t =>
        t.name.toLowerCase().includes(q) || t.description?.toLowerCase().includes(q)
      );
    }

    return allTools;
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
      const result = await jsonRpcCall(server.url, 'tools/call', {
        name: parsed.tool,
        arguments: call.arguments,
      }, headers) as { content: Array<{ type: string; text?: string }> ; isError?: boolean };

      breaker.reset();

      // Invalidate cache for this server (tool state may have changed)
      this.toolCache.delete(`${call.agentId}:${server.name}`);

      const taint: TaintTag = {
        source: `mcp:${server.name}:${parsed.tool}`,
        trust: 'external',
        timestamp: new Date(),
      };

      // Extract text content from MCP response
      const textContent = result?.content
        ?.filter((c: { type: string }) => c.type === 'text')
        .map((c: { text?: string }) => c.text ?? '')
        .join('\n') ?? '';

      return {
        content: textContent,
        isError: result?.isError,
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
// CRUD helpers (exported for CLI/admin)
// ---------------------------------------------------------------------------

async function getEnabledServers(db: Kysely<any>, agentId: string): Promise<McpServerRow[]> {
  return db
    .selectFrom('mcp_servers')
    .selectAll()
    .where('agent_id', '=', agentId)
    .where('enabled', '=', 1)
    .execute() as Promise<McpServerRow[]>;
}

export async function addMcpServer(
  db: Kysely<any>,
  agentId: string,
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
      agent_id: agentId,
      name,
      url,
      headers: headers ? JSON.stringify(headers) : null,
      enabled: 1,
      created_at: now,
      updated_at: now,
    })
    .execute();
  return { id, agent_id: agentId, name, url, headers: headers ? JSON.stringify(headers) : null, enabled: 1, created_at: now, updated_at: now };
}

export async function removeMcpServer(db: Kysely<any>, agentId: string, name: string): Promise<boolean> {
  const result = await db
    .deleteFrom('mcp_servers')
    .where('agent_id', '=', agentId)
    .where('name', '=', name)
    .executeTakeFirst();
  return (result?.numDeletedRows ?? 0n) > 0n;
}

export async function listMcpServers(db: Kysely<any>, agentId: string): Promise<McpServerRow[]> {
  return db
    .selectFrom('mcp_servers')
    .selectAll()
    .where('agent_id', '=', agentId)
    .orderBy('name')
    .execute() as Promise<McpServerRow[]>;
}

export async function updateMcpServer(
  db: Kysely<any>,
  agentId: string,
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
    .where('agent_id', '=', agentId)
    .where('name', '=', name)
    .executeTakeFirst();
  return (result?.numUpdatedRows ?? 0n) > 0n;
}

export async function testMcpServer(
  db: Kysely<any>,
  agentId: string,
  name: string,
  credentials: CredentialProvider,
): Promise<{ ok: boolean; tools?: McpToolSchema[]; error?: string }> {
  const rows = await db
    .selectFrom('mcp_servers')
    .selectAll()
    .where('agent_id', '=', agentId)
    .where('name', '=', name)
    .execute() as McpServerRow[];

  if (rows.length === 0) return { ok: false, error: `Server "${name}" not found` };
  const server = rows[0];

  try {
    const headers = await resolveHeaders(server.headers, credentials);
    const result = await jsonRpcCall(server.url, 'tools/list', {}, headers) as { tools?: McpToolSchema[] };
    return { ok: true, tools: result?.tools ?? [] };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

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
