/**
 * Generic MCP HTTP client for querying arbitrary remote MCP servers.
 *
 * Uses the @modelcontextprotocol/sdk Client + StreamableHTTPClientTransport
 * to speak the standard MCP protocol over HTTP.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { McpToolSchema } from '../providers/mcp/types.js';
import { getLogger } from '../logger.js';

const logger = getLogger().child({ component: 'mcp-client' });

const CONNECT_TIMEOUT_MS = 15_000;
const LIST_TOOLS_TIMEOUT_MS = 30_000;
const CALL_TOOL_TIMEOUT_MS = 60_000;

/**
 * List tools from a remote MCP server.
 * Connects, queries, and disconnects in one shot.
 */
export async function listToolsFromServer(
  url: string,
  opts?: { headers?: Record<string, string> },
): Promise<McpToolSchema[]> {
  const client = new Client({ name: 'ax-host', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: opts?.headers ? { headers: opts.headers } : undefined,
  });

  try {
    await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, `MCP connect to ${url}`);
    const result = await withTimeout(client.listTools(), LIST_TOOLS_TIMEOUT_MS, `MCP listTools from ${url}`);

    return (result.tools ?? []).map(t => ({
      name: t.name,
      description: t.description ?? '',
      inputSchema: t.inputSchema as Record<string, unknown>,
    }));
  } catch (err) {
    logger.warn('mcp_list_tools_failed', { url, error: (err as Error).message });
    return [];
  } finally {
    try { await transport.close(); } catch { /* ignore cleanup errors */ }
  }
}

/**
 * Call a tool on a remote MCP server.
 * Connects, calls, and disconnects in one shot.
 */
export async function callToolOnServer(
  url: string,
  toolName: string,
  args: Record<string, unknown>,
  opts?: { headers?: Record<string, string> },
): Promise<{ content: string; isError?: boolean }> {
  const client = new Client({ name: 'ax-host', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: opts?.headers ? { headers: opts.headers } : undefined,
  });

  try {
    await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, `MCP connect to ${url}`);
    const result = await withTimeout(
      client.callTool({ name: toolName, arguments: args }),
      CALL_TOOL_TIMEOUT_MS,
      `MCP callTool ${toolName} on ${url}`,
    );

    // Extract text from content blocks
    const textParts: string[] = [];
    if (Array.isArray(result.content)) {
      for (const block of result.content) {
        if (typeof block === 'object' && 'text' in block && typeof block.text === 'string') {
          textParts.push(block.text);
        }
      }
    }

    return {
      content: textParts.join('\n') || JSON.stringify(result.content),
      isError: result.isError === true,
    };
  } finally {
    try { await transport.close(); } catch { /* ignore cleanup errors */ }
  }
}

/**
 * List tools from multiple MCP servers in parallel.
 * Used during sandbox spin-up and fast-path tool discovery.
 */
export async function listToolsFromServers(urls: string[]): Promise<McpToolSchema[]> {
  if (urls.length === 0) return [];
  const results = await Promise.all(urls.map(url => listToolsFromServer(url)));
  return results.flat();
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout: ${label} (${ms}ms)`)), ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}
