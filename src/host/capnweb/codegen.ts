/**
 * Generates executable CLI tools from MCP tool schemas.
 *
 * Output: one self-contained JS file per MCP server with #!/usr/bin/env node
 * shebang. Each file contains an IPC client (HTTP fetch), a declarative tool
 * registry, and a generic argv parser with --help. Written to /workspace/bin/
 * and already in PATH.
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
// CLI generation
// ---------------------------------------------------------------------------

/**
 * Convert an MCP tool name to a kebab-case CLI subcommand.
 * list_issues → 'list-issues'
 * get_authenticated_user → 'get-authenticated-user'
 */
export function mcpToolToCLICommand(toolName: string): string {
  return toolName.replace(/_/g, '-');
}

/**
 * Infer a group name from a kebab-case command (strip verb, title-case noun, pluralize).
 * list-issues → Issues, get-team → Teams, save-customer-need → Customer Needs
 */
function inferGroup(cmd: string): string {
  const parts = cmd.split('-');
  const noun = parts.slice(1).join(' ');
  if (!noun) return 'Commands';
  const titled = noun.replace(/\b\w/g, c => c.toUpperCase());
  if (!titled.endsWith('s') && !titled.endsWith('tion')) return titled + 's';
  return titled;
}

/**
 * Generate a self-contained CLI executable for an MCP server.
 */
export function generateCLI(
  server: string,
  tools: McpToolSchema[],
): string {
  // Build the TOOLS registry
  const toolEntries = tools.map(tool => {
    const cmd = mcpToolToCLICommand(tool.name);
    const params = tool.inputSchema?.properties
      ? Object.keys(tool.inputSchema.properties as Record<string, unknown>)
      : [];
    const group = inferGroup(cmd);
    const desc = tool.description?.split('\n')[0]?.slice(0, 80) ?? tool.name;
    return `  ${JSON.stringify(cmd)}: { tool: ${JSON.stringify(tool.name)}, desc: ${JSON.stringify(desc)}, group: ${JSON.stringify(group)}, params: [${params.map(p => JSON.stringify(p)).join(', ')}] }`;
  });

  return `#!/usr/bin/env node
// Auto-generated CLI for ${server} MCP server. Do not edit.
'use strict';

// ── IPC ──────────────────────────────────────────────
async function ipc(tool, params) {
  const hostUrl = process.env.AX_HOST_URL;
  const token = process.env.AX_IPC_TOKEN;
  if (!hostUrl) { process.stderr.write('Error: AX_HOST_URL not set\\n'); process.exit(1); }
  const res = await fetch(hostUrl + '/internal/ipc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: JSON.stringify({ action: 'tool_batch', calls: [{ tool, args: params }] }),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) { process.stderr.write('Error: HTTP ' + res.status + ' ' + (await res.text()) + '\\n'); process.exit(1); }
  const data = await res.json();
  const result = data.results?.[0];
  if (result && typeof result === 'object' && 'ok' in result && !result.ok) {
    process.stderr.write('Error: ' + (result.error || 'tool call failed') + '\\n');
    process.exit(1);
  }
  return result;
}

// ── Tools ────────────────────────────────────────────
const TOOLS = {
${toolEntries.join(',\n')}
};

// ── Help ─────────────────────────────────────────────
function showHelp() {
  process.stdout.write('Usage: ${server} <command> [--flag value ...]\\n\\n');
  const groups = {};
  for (const [cmd, t] of Object.entries(TOOLS)) {
    if (!groups[t.group]) groups[t.group] = [];
    groups[t.group].push({ cmd, ...t });
  }
  for (const [group, cmds] of Object.entries(groups)) {
    process.stdout.write(group + ':\\n');
    for (const c of cmds) {
      const flags = c.params.length ? ' [--' + c.params.join(', --') + ']' : '';
      process.stdout.write('  ' + c.cmd.padEnd(24) + c.desc + flags + '\\n');
    }
    process.stdout.write('\\n');
  }
}

// ── Argv parser ──────────────────────────────────────
function parseArgs(argv) {
  const params = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const val = argv[i + 1];
      if (val === undefined || val.startsWith('--')) { params[key] = true; i++; continue; }
      // Try to parse as number/boolean/JSON
      if (val === 'true') params[key] = true;
      else if (val === 'false') params[key] = false;
      else if (/^-?\\d+(\\.\\d+)?$/.test(val)) params[key] = Number(val);
      else params[key] = val;
      i++;
    }
  }
  return params;
}

// ── Stdin ────────────────────────────────────────────
async function readStdin() {
  if (process.stdin.isTTY) return null;
  // Only read if data is already available or pipe is being closed.
  // Avoid blocking forever when spawned as a subprocess with open stdin pipe.
  return new Promise((resolve) => {
    let data = '';
    let timer = setTimeout(() => { process.stdin.pause(); resolve(null); }, 50);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { clearTimeout(timer); data += chunk; });
    process.stdin.on('end', () => { clearTimeout(timer); if (!data.trim()) { resolve(null); return; } try { resolve(JSON.parse(data.trim())); } catch { resolve(null); } });
    process.stdin.on('error', () => { clearTimeout(timer); resolve(null); });
    process.stdin.resume();
  });
}

// ── Main ─────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') { showHelp(); return; }

  const cmd = args[0];
  const entry = TOOLS[cmd];
  if (!entry) {
    const match = Object.keys(TOOLS).find(k => k.startsWith(cmd));
    if (match) { process.stderr.write('Unknown: ' + cmd + '. Did you mean: ' + match + '?\\n'); }
    else { process.stderr.write('Unknown command: ' + cmd + '. Run ${server} --help\\n'); }
    process.exit(1);
  }

  const flagParams = parseArgs(args.slice(1));
  const stdinParams = await readStdin();
  const params = { ...(stdinParams && typeof stdinParams === 'object' && !Array.isArray(stdinParams) ? stdinParams : {}), ...flagParams };

  const result = await ipc(entry.tool, params);

  // Unwrap single-key objects with array values for cleaner piping
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const keys = Object.keys(result);
    if (keys.length === 1 && Array.isArray(result[keys[0]])) {
      process.stdout.write(JSON.stringify(result[keys[0]], null, 2) + '\\n');
      return;
    }
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\\n');
}

main().catch(e => { process.stderr.write('Error: ' + (e.message || e) + '\\n'); process.exit(1); });
`;
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
