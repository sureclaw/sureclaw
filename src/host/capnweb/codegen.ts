/**
 * Generates typed TypeScript stubs from MCP tool schemas.
 *
 * Output structure:
 *   /tools/_runtime.ts          — Cap'n Web HTTP batch session (4 lines)
 *   /tools/<server>/index.ts    — Barrel re-exports for a server's tools
 *   /tools/<server>/<tool>.ts   — One file per tool with typed wrapper function
 *
 * The agent reaches the host via the existing web proxy:
 *   newHttpBatchRpcSession('http://ax-capnweb/rpc')
 * The proxy intercepts 'ax-capnweb' as an internal route and handles
 * the Cap'n Web batch in-process — no separate socket or transport needed.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { safePath } from '../../utils/safe-path.js';
import type { McpToolSchema } from '../../providers/mcp/types.js';
import { CAPNWEB_INTERNAL_HOST } from './server.js';
import { getLogger } from '../../logger.js';

const logger = getLogger().child({ component: 'capnweb-codegen' });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolStubGroup {
  /** MCP server name (e.g. 'linear', 'github'). */
  server: string;
  /** Tools belonging to this server. */
  tools: McpToolSchema[];
}

export interface CodegenOptions {
  /** Base output directory (e.g. '/workspace/tools'). */
  outputDir: string;
  /** Grouped tools to generate stubs for. */
  groups: ToolStubGroup[];
  /**
   * Cap'n Web RPC URL. Defaults to http://ax-capnweb/rpc which routes
   * through the web proxy's internal route handler.
   */
  rpcUrl?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert MCP tool name to a valid TS identifier in camelCase. */
function toMethodName(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9_]/g, '_')
    .replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

/** Convert JSON Schema to a simplified TypeScript type string. */
function jsonSchemaToTS(schema: Record<string, unknown>, indent = 2): string {
  if (!schema || typeof schema !== 'object') return 'unknown';

  const type = schema.type as string | undefined;

  if (type === 'string') return 'string';
  if (type === 'number' || type === 'integer') return 'number';
  if (type === 'boolean') return 'boolean';
  if (type === 'null') return 'null';
  if (type === 'array') {
    const items = schema.items as Record<string, unknown> | undefined;
    return `Array<${items ? jsonSchemaToTS(items, indent) : 'unknown'}>`;
  }
  if (type === 'object' || schema.properties) {
    const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    const required = new Set((schema.required ?? []) as string[]);
    const pad = ' '.repeat(indent);
    const entries = Object.entries(props).map(([key, propSchema]) => {
      const opt = required.has(key) ? '' : '?';
      return `${pad}${key}${opt}: ${jsonSchemaToTS(propSchema, indent + 2)};`;
    });
    if (entries.length === 0) return 'Record<string, unknown>';
    return `{\n${entries.join('\n')}\n${' '.repeat(indent - 2)}}`;
  }
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Runtime template
// ---------------------------------------------------------------------------

function generateRuntime(rpcUrl: string): string {
  return `/**
 * Cap'n Web runtime — auto-generated, do not edit.
 *
 * Connects to the host via HTTP batch RPC through the web proxy.
 * All tool stub files import from here.
 */
import { newHttpBatchRpcSession } from 'capnweb';

/** The remote tools API — each method maps to an MCP tool. */
export const tools: any = newHttpBatchRpcSession(${JSON.stringify(rpcUrl)});
`;
}

// ---------------------------------------------------------------------------
// Per-tool stub
// ---------------------------------------------------------------------------

function generateToolStub(
  server: string,
  tool: McpToolSchema,
  methodName: string,
): string {
  const paramsType = tool.inputSchema
    ? jsonSchemaToTS(tool.inputSchema)
    : 'Record<string, unknown>';
  const rpcMethod = tool.name; // Original MCP tool name used as RpcTarget method

  const lines = [
    `/**`,
    ` * ${tool.description?.split('\n')[0] ?? tool.name}`,
    ` *`,
    ` * MCP server: ${server}`,
    ` * MCP tool:   ${tool.name}`,
    ` */`,
    `import { tools } from './_runtime.js';`,
    ``,
    `export function ${methodName}(params: ${paramsType}) {`,
    `  return tools.${rpcMethod}(params);`,
    `}`,
  ];

  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Server barrel export
// ---------------------------------------------------------------------------

function generateBarrel(
  tools: Array<{ fileName: string; methodName: string }>,
): string {
  const lines = tools.map(
    ({ fileName, methodName }) =>
      `export { ${methodName} } from './${fileName}.js';`,
  );
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Per-server _runtime.ts that re-exports from root _runtime
// ---------------------------------------------------------------------------

function generateServerRuntime(): string {
  return `// Re-export tools from root runtime\nexport { tools } from '../_runtime.js';\n`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface GeneratedStubs {
  /** All file paths that were written. */
  files: string[];
  /** Total number of tools generated. */
  toolCount: number;
}

/**
 * Generate TypeScript tool stubs on the filesystem.
 *
 * @returns Metadata about what was generated.
 */
export function generateToolStubs(opts: CodegenOptions): GeneratedStubs {
  const { outputDir, groups } = opts;
  const rpcUrl = opts.rpcUrl ?? `http://${CAPNWEB_INTERNAL_HOST}/rpc`;
  const files: string[] = [];
  let toolCount = 0;

  // Write root _runtime.ts
  const runtimePath = safePath(outputDir, '_runtime.ts');
  mkdirSync(dirname(runtimePath), { recursive: true });
  writeFileSync(runtimePath, generateRuntime(rpcUrl), 'utf8');
  files.push(runtimePath);

  for (const group of groups) {
    const serverDir = safePath(outputDir, group.server);
    mkdirSync(serverDir, { recursive: true });

    // Per-server _runtime.ts re-export
    const serverRuntimePath = join(serverDir, '_runtime.ts');
    writeFileSync(serverRuntimePath, generateServerRuntime(), 'utf8');
    files.push(serverRuntimePath);

    const barrelEntries: Array<{ fileName: string; methodName: string }> = [];

    for (const tool of group.tools) {
      const methodName = toMethodName(tool.name);
      const fileName = methodName;
      const filePath = join(serverDir, `${fileName}.ts`);

      writeFileSync(filePath, generateToolStub(group.server, tool, methodName), 'utf8');
      files.push(filePath);
      barrelEntries.push({ fileName, methodName });
      toolCount++;
    }

    // Barrel index.ts
    const barrelPath = join(serverDir, 'index.ts');
    writeFileSync(barrelPath, generateBarrel(barrelEntries), 'utf8');
    files.push(barrelPath);
  }

  logger.info('capnweb_stubs_generated', { outputDir, toolCount, fileCount: files.length });
  return { files, toolCount };
}

/**
 * Group flat MCP tool schemas by server name.
 *
 * Expects tool names in the form 'serverName_toolName' or 'serverName/toolName'.
 * Tools without a separator are placed in a 'default' group.
 */
export function groupToolsByServer(tools: McpToolSchema[]): ToolStubGroup[] {
  const map = new Map<string, McpToolSchema[]>();

  for (const tool of tools) {
    const sepIdx = Math.max(tool.name.indexOf('_'), tool.name.indexOf('/'));
    const server = sepIdx > 0 ? tool.name.slice(0, sepIdx) : 'default';
    if (!map.has(server)) map.set(server, []);
    map.get(server)!.push(tool);
  }

  return [...map.entries()].map(([server, serverTools]) => ({
    server,
    tools: serverTools,
  }));
}
