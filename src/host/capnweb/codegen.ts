/**
 * Generates typed TypeScript stubs from MCP tool schemas.
 *
 * Output structure:
 *   /tools/_runtime.ts          — Cap'n Web session + transport (self-contained)
 *   /tools/<server>/index.ts    — Barrel re-exports for a server's tools
 *   /tools/<server>/<tool>.ts   — One file per tool with typed wrapper function
 *
 * The generated code is self-contained: it inlines the SocketRpcTransport
 * and uses only `capnweb` and `node:net` as dependencies.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { safePath } from '../../utils/safe-path.js';
import type { McpToolSchema } from '../../providers/mcp/types.js';
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
  /** Cap'n Web socket path (injected into _runtime.ts). */
  socketPath: string;
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

function generateRuntime(socketPath: string): string {
  return `/**
 * Cap'n Web runtime — auto-generated, do not edit.
 *
 * Connects to the host's Cap'n Web RPC server via Unix socket.
 * All tool stub files import from here.
 */

import { RpcSession } from 'capnweb';
import { connect } from 'node:net';

// ── Length-prefixed transport (inlined to avoid extra dependencies) ──

class SocketRpcTransport {
  private buffer = Buffer.alloc(0);
  private msgQueue: string[] = [];
  private waiters: Array<{ resolve: (m: string) => void; reject: (e: Error) => void }> = [];
  private closed = false;
  private closeErr: Error | null = null;

  constructor(private socket: import('node:net').Socket) {
    socket.on('data', (c: Buffer) => this.onData(c));
    socket.on('close', () => this.onClose());
    socket.on('error', (e: Error) => { this.closeErr = e; });
  }

  private onData(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const len = this.buffer.readUInt32BE(0);
      if (this.buffer.length < 4 + len) break;
      const msg = this.buffer.subarray(4, 4 + len).toString('utf8');
      this.buffer = this.buffer.subarray(4 + len);
      const w = this.waiters.shift();
      if (w) w.resolve(msg); else this.msgQueue.push(msg);
    }
  }

  private onClose() {
    this.closed = true;
    this.closeErr ??= new Error('Socket closed');
    for (const w of this.waiters) w.reject(this.closeErr);
    this.waiters.length = 0;
  }

  async send(message: string) {
    if (this.closed) throw new Error('Transport closed');
    const buf = Buffer.from(message, 'utf8');
    const hdr = Buffer.alloc(4);
    hdr.writeUInt32BE(buf.length, 0);
    return new Promise<void>((res, rej) => {
      this.socket.write(Buffer.concat([hdr, buf]), (e) => e ? rej(e) : res());
    });
  }

  receive(): Promise<string> {
    if (this.msgQueue.length > 0) return Promise.resolve(this.msgQueue.shift()!);
    if (this.closed) return Promise.reject(this.closeErr ?? new Error('closed'));
    return new Promise((res, rej) => this.waiters.push({ resolve: res, reject: rej }));
  }

  abort() { this.socket.destroy(); }
}

// ── Session ──

const socket = connect(${JSON.stringify(socketPath)});
const transport = new SocketRpcTransport(socket);
const session = new RpcSession<any>(transport as any);

/** The remote tools API — each method maps to an MCP tool. */
export const tools: any = session.getRemoteMain();

// Cleanup on exit
process.on('exit', () => { socket.destroy(); });
process.on('SIGTERM', () => { socket.destroy(); process.exit(0); });
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
  const { outputDir, groups, socketPath } = opts;
  const files: string[] = [];
  let toolCount = 0;

  // Write root _runtime.ts
  const runtimePath = safePath(outputDir, '_runtime.ts');
  mkdirSync(dirname(runtimePath), { recursive: true });
  writeFileSync(runtimePath, generateRuntime(socketPath), 'utf8');
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
