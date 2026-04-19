/**
 * Generic MCP HTTP client for querying arbitrary remote MCP servers.
 *
 * Uses the @modelcontextprotocol/sdk Client + StreamableHTTPClientTransport
 * to speak the standard MCP protocol over HTTP.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { McpToolSchema } from '../providers/mcp/types.js';
import { getLogger } from '../logger.js';

/** MCP wire protocol. `http` is the newer POST-based transport (what the
 *  MCP spec calls "Streamable HTTP"); `sse` is the legacy
 *  GET-for-events + POST-for-replies transport. Skill frontmatter
 *  declares which one a given server speaks. */
export type McpTransport = 'http' | 'sse';

const logger = getLogger().child({ component: 'mcp-client' });

const CONNECT_TIMEOUT_MS = 15_000;
const LIST_TOOLS_TIMEOUT_MS = 30_000;
const CALL_TOOL_TIMEOUT_MS = 60_000;

/**
 * Custom fetch wrapper that handles MCP Streamable HTTP quirks:
 *
 * 1. Some servers return 406 on the initial GET SSE request when the client
 *    only sends `Accept: text/event-stream`. The SDK only handles 405
 *    gracefully (skips SSE). We convert 406 → 405 for GET requests so the
 *    SDK continues to the POST-based initialize flow.
 *
 * 2. Ensures the correct `Accept` header for POST requests.
 */
function createMcpFetch(): typeof globalThis.fetch {
  return async (input, init) => {
    const response = await globalThis.fetch(input, init);
    // Convert 406 → 405 for GET: server doesn't support SSE stream with
    // the Accept header the SDK sends. Treat like "method not allowed".
    if (init?.method === 'GET' && response.status === 406) {
      await response.body?.cancel();
      return new Response(null, { status: 405, statusText: 'Method Not Allowed' });
    }
    return response;
  };
}

function createTransport(
  url: string,
  headers?: Record<string, string>,
  transport: McpTransport = 'http',
): StreamableHTTPClientTransport | SSEClientTransport {
  if (transport === 'sse') {
    return new SSEClientTransport(new URL(url), {
      requestInit: headers ? { headers } : undefined,
      // SSE spec also accepts eventSourceInit for the GET stream, but
      // auth headers in requestInit already flow to both the GET and
      // POST requests in the SDK's SSE implementation.
    });
  }
  return new StreamableHTTPClientTransport(new URL(url), {
    requestInit: headers ? { headers } : undefined,
    fetch: createMcpFetch(),
  });
}

/**
 * Connect to an MCP server, list tools, and disconnect. Throws on error.
 * Use listToolsFromServer() for a graceful variant that returns [] on failure.
 */
export async function connectAndListTools(
  url: string,
  opts?: { headers?: Record<string, string>; transport?: McpTransport },
): Promise<McpToolSchema[]> {
  const client = new Client({ name: 'ax-host', version: '1.0.0' });
  const transport = createTransport(url, opts?.headers, opts?.transport);

  try {
    await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, `MCP connect to ${url}`);
    const result = await withTimeout(client.listTools(), LIST_TOOLS_TIMEOUT_MS, `MCP listTools from ${url}`);

    return (result.tools ?? []).map(t => ({
      name: t.name,
      description: t.description ?? '',
      inputSchema: t.inputSchema as Record<string, unknown>,
    }));
  } finally {
    try { await transport.close(); } catch { /* ignore cleanup errors */ }
  }
}

/**
 * List tools from a remote MCP server.
 * Connects, queries, and disconnects in one shot.
 * Returns [] on failure (graceful degradation).
 */
export async function listToolsFromServer(
  url: string,
  opts?: { headers?: Record<string, string>; transport?: McpTransport },
): Promise<McpToolSchema[]> {
  try {
    return await connectAndListTools(url, opts);
  } catch (err) {
    logger.warn('mcp_list_tools_failed', {
      url,
      transport: opts?.transport ?? 'http',
      error: (err as Error).message,
    });
    return [];
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
  opts?: { headers?: Record<string, string>; transport?: McpTransport },
): Promise<{ content: string; isError?: boolean }> {
  const client = new Client({ name: 'ax-host', version: '1.0.0' });
  const transport = createTransport(url, opts?.headers, opts?.transport);

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
