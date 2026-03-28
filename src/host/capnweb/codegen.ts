/**
 * Generates typed TypeScript stubs from MCP tool schemas.
 *
 * Output structure:
 *   /tools/_runtime.ts          — Proxy-based batch transport over IPC
 *   /tools/<server>/index.ts    — Barrel re-exports for a server's tools
 *   /tools/<server>/<tool>.ts   — One file per tool with typed wrapper function
 *
 * The generated runtime uses JavaScript Proxy to let agents write
 * natural-looking code while secretly building a call graph:
 *
 *   const teams = linear.getTeams({});              // proxy, not awaited
 *   const issues = linear.getIssues({ teamId: teams[0].id }); // tracks dep
 *   const [t, i] = await Promise.all([teams, issues]);        // one IPC call
 *
 * Zero external dependencies — just the IPC socket that's already there.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { safePath } from '../../utils/safe-path.js';
import type { McpToolSchema } from '../../providers/mcp/types.js';
import { getLogger } from '../../logger.js';

const logger = getLogger().child({ component: 'tool-codegen' });

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
// Runtime template — proxy-based batch over IPC, zero dependencies
// ---------------------------------------------------------------------------

function generateRuntime(): string {
  // NOTE: the backslash-n in string literals below are literal characters
  // in the generated file, not escape sequences in this template.
  return `/**
 * Tool runtime — auto-generated, do not edit.
 *
 * Proxy-based batching over IPC. Write normal-looking code:
 *   const teams = getTeams({});
 *   const issues = getIssues({ teamId: teams[0].id });
 *   const [t, i] = await Promise.all([teams, issues]); // one round trip
 *
 * Zero external dependencies.
 */
import { connect } from 'node:net';

// ── Minimal IPC client ──

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
    setTimeout(() => { pending.delete(id); reject(new Error('IPC timeout')); }, 60_000);
  });
}

// ── Proxy-based call graph ──

const REF = Symbol('ref');

type PendingCall = { tool: string; args: Record<string, unknown> };
let pendingCalls: PendingCall[] = [];
let flushPromise: Promise<unknown[]> | null = null;

function scheduleFlush(): Promise<unknown[]> {
  if (!flushPromise) {
    flushPromise = new Promise<unknown[]>((resolve, reject) => {
      setTimeout(async () => {
        const calls = pendingCalls;
        pendingCalls = [];
        flushPromise = null;
        try {
          const resp = await ipcCall('tool_batch', { calls });
          resolve(resp.results ?? []);
        } catch (e) { reject(e); }
      }, 0);
    });
  }
  return flushPromise;
}

function createRef(callId: number, path: string): any {
  const marker = { [REF]: true, callId, path };
  return new Proxy(marker as any, {
    get(target, prop) {
      if (prop === REF) return true;
      if (prop === 'callId') return target.callId;
      if (prop === 'path') return target.path;
      if (prop === 'then' || prop === Symbol.toPrimitive || prop === Symbol.toStringTag) return undefined;
      const seg = typeof prop === 'string' && /^\\d+$/.test(prop) ? \`[\${prop}]\` : \`.\${String(prop)}\`;
      return createRef(callId, target.path + seg);
    }
  });
}

function serializeArgs(value: any): any {
  if (value && value[REF]) return { $ref: value.callId, path: value.path };
  if (Array.isArray(value)) return value.map(serializeArgs);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = serializeArgs(v);
    return out;
  }
  return value;
}

/**
 * Register a tool call. Returns a thenable proxy:
 * - await it → flushes batch, returns result
 * - access properties → creates $ref for pipelining
 */
export function callTool(tool: string, args: Record<string, unknown>): any {
  const callId = pendingCalls.length;
  pendingCalls.push({ tool, args: serializeArgs(args) });
  const flush = scheduleFlush();

  return new Proxy({}, {
    get(_, prop) {
      if (prop === 'then') {
        return (resolve: any, reject: any) => {
          flush.then((results: any) => {
            const r = results[callId];
            if (r && typeof r === 'object' && '$error' in r) reject(new Error(r.$error));
            else resolve(r);
          }).catch(reject);
        };
      }
      if (prop === Symbol.toPrimitive || prop === Symbol.toStringTag) return undefined;
      const seg = typeof prop === 'string' && /^\\d+$/.test(prop) ? \`[\${prop}]\` : \`.\${String(prop)}\`;
      return createRef(callId, seg);
    }
  });
}

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
    `import { callTool } from '../_runtime.js';`,
    ``,
    `export function ${methodName}(params: ${paramsType}) {`,
    `  return callTool(${JSON.stringify(rpcMethod)}, params);`,
    `}`,
  ];

  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Barrel exports
// ---------------------------------------------------------------------------

function generateBarrel(
  tools: Array<{ fileName: string; methodName: string }>,
): string {
  return tools.map(
    ({ fileName, methodName }) =>
      `export { ${methodName} } from './${fileName}.js';`,
  ).join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface GeneratedStubs {
  files: string[];
  toolCount: number;
}

export function generateToolStubs(opts: CodegenOptions): GeneratedStubs {
  const { outputDir, groups } = opts;
  const files: string[] = [];
  let toolCount = 0;

  const runtimePath = safePath(outputDir, '_runtime.ts');
  mkdirSync(dirname(runtimePath), { recursive: true });
  writeFileSync(runtimePath, generateRuntime(), 'utf8');
  files.push(runtimePath);

  for (const group of groups) {
    const serverDir = safePath(outputDir, group.server);
    mkdirSync(serverDir, { recursive: true });

    const barrelEntries: Array<{ fileName: string; methodName: string }> = [];

    for (const tool of group.tools) {
      const methodName = toMethodName(tool.name);
      const filePath = join(serverDir, `${methodName}.ts`);
      writeFileSync(filePath, generateToolStub(group.server, tool, methodName), 'utf8');
      files.push(filePath);
      barrelEntries.push({ fileName: methodName, methodName });
      toolCount++;
    }

    const barrelPath = join(serverDir, 'index.ts');
    writeFileSync(barrelPath, generateBarrel(barrelEntries), 'utf8');
    files.push(barrelPath);
  }

  logger.info('tool_stubs_generated', { outputDir, toolCount, fileCount: files.length });
  return { files, toolCount };
}

/**
 * Group flat MCP tool schemas by server name.
 *
 * Expects tool names in 'serverName_toolName' or 'serverName/toolName' form.
 * Tools without a separator go in a 'default' group.
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
