/**
 * Generates typed TypeScript stubs from MCP tool schemas.
 *
 * Output structure:
 *   /tools/_runtime.ts          — IPC-based Cap'n Web batch transport
 *   /tools/<server>/index.ts    — Barrel re-exports for a server's tools
 *   /tools/<server>/<tool>.ts   — One file per tool with typed wrapper function
 *
 * The agent reaches the host via the existing IPC socket.
 * The generated runtime sends Cap'n Web batch payloads as a single
 * `capnweb_batch` IPC call — same socket, same framing as all other tools.
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
// Runtime template — IPC-based Cap'n Web batch transport
// ---------------------------------------------------------------------------

function generateRuntime(): string {
  return `/**
 * Cap'n Web runtime — auto-generated, do not edit.
 *
 * Sends Cap'n Web batch RPC over the existing IPC socket using the
 * capnweb_batch action. Same socket, same framing as all other IPC tools.
 */
import { RpcSession } from 'capnweb';
import { connect } from 'node:net';

// ── Minimal IPC client (length-prefixed JSON over Unix socket) ──

const socketPath = process.env.AX_IPC_SOCKET!;
let msgId = 0;
let ipcSocket: import('node:net').Socket;
let ipcBuffer = Buffer.alloc(0);
const pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }>();

function ensureConnected(): Promise<void> {
  if (ipcSocket) return Promise.resolve();
  return new Promise((resolve, reject) => {
    ipcSocket = connect(socketPath, () => resolve());
    ipcSocket.on('error', reject);
    ipcSocket.on('data', (chunk: Buffer) => {
      ipcBuffer = Buffer.concat([ipcBuffer, chunk]);
      while (ipcBuffer.length >= 4) {
        const len = ipcBuffer.readUInt32BE(0);
        if (ipcBuffer.length < 4 + len) break;
        const msg = JSON.parse(ipcBuffer.subarray(4, 4 + len).toString('utf8'));
        ipcBuffer = ipcBuffer.subarray(4 + len);
        if (msg._heartbeat) continue;
        const p = pending.get(msg._msgId);
        if (p) { pending.delete(msg._msgId); p.resolve(msg); }
      }
    });
  });
}

async function ipcCall(action: string, params: Record<string, unknown>): Promise<any> {
  await ensureConnected();
  const id = String(++msgId);
  const payload = Buffer.from(JSON.stringify({ action, ...params, _msgId: id }), 'utf8');
  const hdr = Buffer.alloc(4);
  hdr.writeUInt32BE(payload.length, 0);
  ipcSocket.write(Buffer.concat([hdr, payload]));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => { pending.delete(id); reject(new Error('IPC timeout')); }, 30_000);
  });
}

// ── Cap'n Web batch transport over IPC ──

class IPCBatchTransport {
  #outbox: string[] = [];
  #inbox: string[] = [];
  #waiters: Array<{ resolve: (m: string) => void; reject: (e: Error) => void }> = [];
  #flushScheduled = false;
  #done = false;

  async send(message: string) {
    this.#outbox.push(message);
    if (!this.#flushScheduled) {
      this.#flushScheduled = true;
      // Flush on next microtask — batches all calls made synchronously
      setTimeout(() => this.#flush(), 0);
    }
  }

  async #flush() {
    this.#flushScheduled = false;
    const batch = this.#outbox.join('\\n');
    this.#outbox = [];
    const resp = await ipcCall('capnweb_batch', { body: batch });
    if (resp.error) {
      for (const w of this.#waiters) w.reject(new Error(resp.error));
      this.#waiters = [];
      return;
    }
    const messages = (resp.body as string).split('\\n').filter(Boolean);
    for (const msg of messages) {
      const w = this.#waiters.shift();
      if (w) w.resolve(msg);
      else this.#inbox.push(msg);
    }
    // Signal end of batch
    this.#done = true;
    for (const w of this.#waiters) w.reject(new Error('Batch ended'));
    this.#waiters = [];
  }

  receive(): Promise<string> {
    if (this.#inbox.length > 0) return Promise.resolve(this.#inbox.shift()!);
    if (this.#done) return Promise.reject(new Error('Batch ended'));
    return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
  }

  abort() { this.#done = true; }
}

// ── Session ──

const transport = new IPCBatchTransport();
const session = new RpcSession<any>(transport as any);

/** The remote tools API — each method maps to an MCP tool. */
export const tools: any = session.getRemoteMain();

// Cleanup
process.on('exit', () => { ipcSocket?.destroy(); });
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
  const rpcMethod = tool.name;

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
  const files: string[] = [];
  let toolCount = 0;

  // Write root _runtime.ts
  const runtimePath = safePath(outputDir, '_runtime.ts');
  mkdirSync(dirname(runtimePath), { recursive: true });
  writeFileSync(runtimePath, generateRuntime(), 'utf8');
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
