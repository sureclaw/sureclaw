/**
 * Generates importable JS modules from MCP tool schemas.
 *
 * Output: one module per MCP server, plus a barrel index.
 */

import type { McpToolSchema } from '../../providers/mcp/types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolStubGroup {
  /** MCP server name (e.g. 'linear', 'github'). */
  server: string;
  /** Tools belonging to this server. */
  tools: McpToolSchema[];
}

// ---------------------------------------------------------------------------
// Module generation (PTC model)
// ---------------------------------------------------------------------------

/**
 * Convert snake_case to camelCase: list_issues → listIssues
 */
export function snakeToCamel(name: string): string {
  return name.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

/**
 * Generate a JSDoc block from tool description and input schema.
 *
 * Emits the object-form (`@param {object} params` + `@param {T} params.name`
 * per property) to match the generated function signature, which always takes
 * a single object argument. Earlier versions wrote bare positional tags like
 * `@param {string} teamId` — agents read that as "pass a string positionally"
 * and called `listCycles("uuid")`, which then hit the IPC Zod validator
 * (`args: z.record(...)`) with a cryptic "expected record, received string"
 * error and spiraled into retry loops.
 */
function buildJSDoc(description: string, schema: Record<string, unknown>): string {
  const props = (schema.properties ?? {}) as Record<string, {
    type?: string;
    description?: string;
    enum?: unknown[];
  }>;
  const required = new Set((schema.required ?? []) as string[]);
  const propEntries = Object.entries(props);
  const lines = ['/**', ` * ${description}`];
  if (propEntries.length > 0) {
    lines.push(' * @param {object} params');
    for (const [name, prop] of propEntries) {
      const typeAnnotation = jsdocType(prop);
      const desc = prop.description ? ` — ${prop.description}` : '';
      const pathName = required.has(name) ? `params.${name}` : `[params.${name}]`;
      lines.push(` * @param {${typeAnnotation}} ${pathName}${desc}`);
    }
  }
  lines.push(' */');
  return lines.join('\n');
}

/**
 * Pick the JSDoc type for a property. Prefer an enum union (`"a"|"b"|"c"`)
 * over the plain type because an agent reading `@param {string}` will
 * freely hallucinate adjacent values — the union type refuses to let
 * those go unnoticed. Falls back to the raw `type` (or `unknown`) when
 * the enum is missing, empty, or contains non-string values.
 */
function jsdocType(prop: { type?: string; enum?: unknown[] }): string {
  const values = Array.isArray(prop.enum) ? prop.enum : [];
  const strings = values.filter((v): v is string => typeof v === 'string');
  if (strings.length > 0 && strings.length === values.length) {
    return strings.map((v) => JSON.stringify(v)).join('|');
  }
  return prop.type ?? 'unknown';
}

/**
 * Generate an importable JS module for an MCP server's tools.
 * Each tool becomes a named async function that calls through IPC.
 */
export function generateModule(
  server: string,
  tools: McpToolSchema[],
): string {
  const functions = tools.map(tool => {
    const fnName = snakeToCamel(tool.name);
    const props = (tool.inputSchema?.properties ?? {}) as Record<string, unknown>;
    const paramNames = Object.keys(props);
    const required = (tool.inputSchema?.required ?? []) as string[];
    const jsDoc = buildJSDoc(tool.description ?? tool.name, tool.inputSchema ?? {});

    if (paramNames.length === 0) {
      return `${jsDoc}
export async function ${fnName}() {
  return _call(${JSON.stringify(tool.name)}, {});
}`;
    }

    // Runtime guard: bail out with an actionable TypeError before we put a
    // non-object on the wire. Without this, a wrong-shaped call produces
    // "expected record, received string" from the IPC Zod validator, which
    // agents interpret as "the request format is wrong" and retry with
    // random new shapes instead of fixing the argument type.
    //
    // When all params are optional, default `params = {}` so no-args calls
    // (e.g. `listTeams()`) work — typeof undefined !== 'object' would
    // otherwise mistakenly reject the legitimate zero-arg case.
    const keyHint = paramNames.slice(0, 3).join(', ');
    const paramDecl = required.length === 0 ? 'params = {}' : 'params';
    return `${jsDoc}
export async function ${fnName}(${paramDecl}) {
  if (params === null || typeof params !== 'object') {
    throw new TypeError(
      '${fnName} expects a single object argument (keys: ${keyHint}), e.g. ${fnName}({ ${paramNames[0]}: ... })'
    );
  }
  return _call(${JSON.stringify(tool.name)}, params);
}`;
  });

  return `// Auto-generated tool module for ${server}. Do not edit.
//
// Response shapes: many MCP servers wrap list results in an object keyed by
// the plural resource name — e.g. list_issues returns { issues: [...],
// pageInfo: {...} }, NOT a bare array. Destructure or use result.issues.map
// accordingly. When unsure, log the raw response first before iterating:
//   const r = await listIssues({...}); console.log(JSON.stringify(r, null, 2));
'use strict';

const _hostUrl = process.env.AX_HOST_URL;
const _token = process.env.AX_IPC_TOKEN;

async function _call(tool, params) {
  if (!_hostUrl) throw new Error('AX_HOST_URL not set');
  const res = await fetch(_hostUrl + '/internal/ipc', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(_token ? { Authorization: 'Bearer ' + _token } : {}),
    },
    body: JSON.stringify({ action: 'tool_batch', calls: [{ tool, args: params }] }),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + (await res.text()));
  const data = await res.json();
  const result = data.results?.[0];
  if (result && typeof result === 'object' && 'ok' in result && !result.ok) {
    throw new Error(result.error || 'tool call failed');
  }
  return result;
}

${functions.join('\n\n')}
`;
}

/**
 * Generate a barrel index.js that re-exports every tool function from every
 * server module at the top level. This lets the agent import functions
 * directly:
 *
 *   import { listIssues } from '/workspace/.ax/tools/linear/index.js';
 *   await listIssues({ ... });
 *
 * instead of the namespaced form (`import { linear } ... linear.listIssues()`)
 * which the model tends not to discover from examples.
 *
 * Collisions: if two servers within the same skill both export a function
 * with the same name, ES-module link-time will raise an "ambiguous export"
 * error the first time something tries to import that name. The error is
 * clear enough for the admin to disambiguate (rename one server or split
 * the skills). Accepts the small risk for a much cleaner agent-facing API
 * in the common single-server case.
 */
export function generateIndex(servers: string[]): string {
  const exports = servers.map(s => `export * from './${s}.js';`);
  return `// Auto-generated tool index. Do not edit.\n${exports.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

/**
 * Group flat MCP tool schemas by server name.
 *
 * Uses the `server` field on each tool when available (set by discoverAllTools).
 * Falls back to inferring from tool names in 'serverName_toolName' or
 * 'serverName/toolName' form. Tools without a server go in a 'default' group.
 */
export function groupToolsByServer(tools: McpToolSchema[]): ToolStubGroup[] {
  const map = new Map<string, McpToolSchema[]>();

  for (const tool of tools) {
    if (tool.server) {
      // Server is known — use the tool name as-is (no stripping)
      if (!map.has(tool.server)) map.set(tool.server, []);
      map.get(tool.server)!.push({ ...tool, server: undefined });
    } else {
      // Legacy fallback: infer server from tool name prefix
      const indices = [tool.name.indexOf('_'), tool.name.indexOf('/')]
        .filter(i => i > 0);
      const sepIdx = indices.length > 0 ? Math.min(...indices) : -1;
      const server = sepIdx > 0 ? tool.name.slice(0, sepIdx) : 'default';
      const localName = sepIdx > 0 ? tool.name.slice(sepIdx + 1) : tool.name;
      if (!map.has(server)) map.set(server, []);
      map.get(server)!.push({ ...tool, name: localName, server: undefined });
    }
  }

  return [...map.entries()].map(([server, serverTools]) => ({
    server,
    tools: serverTools,
  }));
}
