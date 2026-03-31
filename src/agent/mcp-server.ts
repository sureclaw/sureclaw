/**
 * In-process MCP server wrapping AX's IPC tools for the Agent SDK.
 *
 * Uses createSdkMcpServer() and tool() from @anthropic-ai/claude-agent-sdk
 * to expose AX IPC tools (memory, web, audit, skills) as MCP tools that
 * the Agent SDK's Claude Code CLI subprocess can call.
 */

import { z } from 'zod/v4';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import type { IIPCClient } from './runner.js';
import { normalizeOrigin, filterTools, getToolDescription } from './tool-catalog.js';
import type { ToolFilterContext } from './tool-catalog.js';
import { createLocalSandbox } from './local-sandbox.js';

function stripTaint(data: unknown): unknown {
  if (Array.isArray(data)) {
    return data.map(stripTaint);
  }
  if (data && typeof data === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      if (k === 'taint') continue;
      out[k] = stripTaint(v);
    }
    return out;
  }
  return data;
}

function textResult(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(stripTaint(data)) }] };
}

function errorResult(err: unknown) {
  return {
    content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }],
    isError: true,
  };
}

export interface MCPServerOptions {
  /** Current user ID — included in user_write calls for per-user scoping. */
  userId?: string;
  /** Tool filter context — excludes tools irrelevant to the current session. */
  filter?: ToolFilterContext;
  /** When set, sandbox tools execute locally with host audit gate. */
  localSandbox?: { client: IIPCClient; workspace: string };
}

// ── Action maps for tools with irregular IPC action names ──
const SCHEDULER_ACTIONS: Record<string, string> = {
  add_cron: 'scheduler_add_cron',
  run_at: 'scheduler_run_at',
  remove: 'scheduler_remove_cron',
  list: 'scheduler_list_jobs',
};

const GOVERNANCE_ACTIONS: Record<string, string> = {
  propose: 'identity_propose',
  list_proposals: 'proposal_list',
  list_agents: 'agent_registry_list',
};

export function createIPCMcpServer(client: IIPCClient, opts?: MCPServerOptions): McpSdkServerConfigWithInstance {
  async function ipcCall(action: string, params: Record<string, unknown> = {}) {
    try {
      const result = await client.call({ action, ...params });
      return textResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }

  // Local sandbox executor for container-local tool execution
  const sandbox = opts?.localSandbox
    ? createLocalSandbox({ client: opts.localSandbox.client, workspace: opts.localSandbox.workspace })
    : null;

  // Build name set of allowed tools based on filter context
  const allowedNames = opts?.filter
    ? new Set(filterTools(opts.filter).map(s => s.name))
    : null; // null = no filtering, include all

  // Define all MCP tools (10 consolidated), then filter based on context
  const allTools = [
    // ── Memory ──
    tool('memory', getToolDescription('memory'),
      {
        type: z.enum(['write', 'query', 'read', 'delete', 'list']),
        scope: z.string().optional(),
        content: z.string().optional(),
        tags: z.array(z.string()).optional(),
        query: z.string().optional(),
        limit: z.number().optional(),
        id: z.string().optional(),
      },
      (args) => {
        const { type, ...rest } = args;
        const params = Object.fromEntries(Object.entries(rest).filter(([_, v]) => v !== undefined));
        return ipcCall(`memory_${type}`, params);
      },
    ),

    // ── Web ──
    tool('web', getToolDescription('web'),
      {
        type: z.enum(['fetch', 'extract', 'search']).describe('Operation type: "search" to find info (no URL needed), "extract" to read a webpage (URL required), "fetch" for raw HTTP requests (URL required)'),
        url: z.string().url().optional().describe('The URL to fetch or extract. Required for type="fetch" and type="extract". Do NOT use with type="search".'),
        method: z.enum(['GET', 'HEAD']).optional().describe('HTTP method. Only used with type="fetch". Defaults to GET.'),
        headers: z.record(z.string(), z.string()).optional().describe('Custom HTTP headers. Only used with type="fetch".'),
        timeoutMs: z.number().optional().describe('Request timeout in ms. Only used with type="fetch".'),
        query: z.string().optional().describe('Search query in plain text. Required for type="search". Must NOT be a URL.'),
        maxResults: z.number().optional().describe('Max search results. Only used with type="search".'),
      },
      (args) => {
        const { type, ...rest } = args;
        const params = Object.fromEntries(Object.entries(rest).filter(([_, v]) => v !== undefined));
        return ipcCall(`web_${type}`, params);
      },
    ),

    // ── Identity ──
    tool('identity', getToolDescription('identity'),
      {
        type: z.enum(['read', 'write', 'user_write']),
        file: z.enum(['SOUL.md', 'IDENTITY.md']).optional(),
        content: z.string().optional(),
        reason: z.string().optional(),
        origin: z.string().optional().describe('"user_request" or "agent_initiated"'),
      },
      (args) => {
        const { type, ...rest } = args;
        const params = Object.fromEntries(Object.entries(rest).filter(([_, v]) => v !== undefined));
        if (type === 'read') {
          return ipcCall('identity_read', params);
        }
        const action = type === 'write' ? 'identity_write' : 'user_write';
        const normalized = { ...params, origin: normalizeOrigin(params.origin) };
        if (type === 'user_write') {
          return ipcCall(action, { ...normalized, userId: opts?.userId ?? '' });
        }
        return ipcCall(action, normalized);
      },
    ),

    // ── Scheduler ──
    tool('scheduler', getToolDescription('scheduler'),
      {
        type: z.enum(['add_cron', 'run_at', 'remove', 'list']),
        schedule: z.string().optional().describe('Cron expression, e.g. "0 9 * * 1" for 9am every Monday'),
        prompt: z.string().optional().describe('The instruction/prompt to execute'),
        maxTokenBudget: z.number().optional().describe('Optional max token budget per execution'),
        datetime: z.string().optional().describe('ISO 8601 datetime string, e.g. "2026-02-21T19:30:00"'),
        jobId: z.string().optional().describe('The job ID returned by scheduler_add_cron'),
      },
      (args) => {
        const { type, ...rest } = args;
        const params = Object.fromEntries(Object.entries(rest).filter(([_, v]) => v !== undefined));
        return ipcCall(SCHEDULER_ACTIONS[type], params);
      },
    ),

    // ── Skill ──
    tool('skill', getToolDescription('skill'),
      {
        type: z.enum(['create', 'install', 'update', 'delete']),
        slug: z.string().optional().describe('Skill slug'),
        query: z.string().optional().describe('Search query'),
        path: z.string().optional().describe('File path within the skill (e.g. "SKILL.md")'),
        content: z.string().optional().describe('SKILL.md content (for create) or file content (for update)'),
      },
      async (args) => {
        const SKILL_ACTIONS: Record<string, string> = {
          create: 'skill_create', install: 'skill_install', update: 'skill_update', delete: 'skill_delete',
        };
        const { type, ...rest } = args;
        // Validate required params per operation type
        if (type === 'create' && (!rest.slug || !rest.content)) {
          return errorResult(new Error('create requires slug and content'));
        }
        if (type === 'update' && (!rest.slug || !rest.path || !rest.content)) {
          return errorResult(new Error('update requires slug, path, and content'));
        }
        if (type === 'delete' && !rest.slug) {
          return errorResult(new Error('delete requires slug'));
        }
        const params = Object.fromEntries(Object.entries(rest).filter(([_, v]) => v !== undefined));
        return ipcCall(SKILL_ACTIONS[type], params);
      },
    ),

    // ── Credential ──
    tool('request_credential', getToolDescription('request_credential'),
      {
        envName: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/).describe('Environment variable name needed (e.g. LINEAR_API_KEY). Must be uppercase with underscores only.'),
      },
      (args) => ipcCall('credential_request', args),
    ),

    // ── Workspace ──
    tool('workspace_write', getToolDescription('workspace_write'),
      {
        tier: z.string().describe('"agent", "user", or "session"'),
        path: z.string().describe('Relative path within the tier (e.g. "docs/notes.md")'),
        content: z.string().describe('File content to write'),
      },
      (args) => ipcCall('workspace_write', args),
    ),

    // ── Workspace Read ──
    tool('workspace_read', getToolDescription('workspace_read'),
      {
        scope: z.string().describe('"agent", "user", or "session"'),
        path: z.string().describe('Relative path within the scope'),
      },
      (args) => ipcCall('workspace_read', args),
    ),

    // ── Workspace List ──
    tool('workspace_list', getToolDescription('workspace_list'),
      {
        scope: z.string().describe('"agent", "user", or "session"'),
        prefix: z.string().optional().describe('Filter by path prefix'),
      },
      (args) => ipcCall('workspace_list', args),
    ),

    // ── Workspace Scopes ──
    tool('workspace_mount', getToolDescription('workspace_mount'),
      {
        scopes: z.array(z.string()).describe('Scopes to mount: "session", "user", or "agent"'),
      },
      (args) => ipcCall('workspace_mount', args),
    ),

    // ── Governance ──
    tool('governance', getToolDescription('governance'),
      {
        type: z.enum(['propose', 'list_proposals', 'list_agents']),
        file: z.string().optional().describe('"SOUL.md" or "IDENTITY.md"'),
        content: z.string().optional(),
        reason: z.string().optional(),
        origin: z.string().optional().describe('"user_request" or "agent_initiated"'),
        status: z.string().optional().describe('"pending", "approved", "rejected", "active", "suspended", or "archived"'),
      },
      (args) => {
        const { type, ...rest } = args;
        const params = Object.fromEntries(Object.entries(rest).filter(([_, v]) => v !== undefined));
        if (type === 'propose') {
          return ipcCall(GOVERNANCE_ACTIONS[type], { ...params, origin: normalizeOrigin(params.origin) });
        }
        return ipcCall(GOVERNANCE_ACTIONS[type], params);
      },
    ),

    // ── Audit (singleton) ──
    tool('audit', getToolDescription('audit'), {
      action: z.string().optional(),
      sessionId: z.string().optional(),
      limit: z.number().optional(),
    }, (args) => ipcCall('audit_query', args)),

    // ── Agent ──
    tool('agent', getToolDescription('agent'),
      {
        type: z.enum(['delegate', 'collect']),
        task: z.string().optional().describe('The task description for the sub-agent (delegate)'),
        context: z.string().optional().describe('Background context the sub-agent should know (delegate)'),
        runner: z.enum(['pi-coding-agent', 'claude-code']).optional()
          .describe('Runner type for the sub-agent (delegate)'),
        model: z.string().optional().describe('Model ID override for the sub-agent (delegate)'),
        maxTokens: z.number().optional().describe('Max tokens for the sub-agent response (delegate)'),
        timeoutSec: z.number().optional().describe('Timeout in seconds, 5-600 (delegate)'),
        wait: z.boolean().optional().describe('If false, launch in background and return immediately with a handleId. Default: true (delegate)'),
        resourceTier: z.string().optional().describe('"default" (1 vCPU, 256MB) or "heavy" (4 vCPU, 2GB) — request more resources for intensive tasks (delegate)'),
        handleIds: z.array(z.string()).optional().describe('Handle IDs returned by delegate with wait: false (collect)'),
        timeoutMs: z.number().optional().describe('Timeout in milliseconds, default 300000 (collect)'),
      },
      (args) => {
        const { type, ...rest } = args;
        const params = Object.fromEntries(Object.entries(rest).filter(([_, v]) => v !== undefined));
        const action = type === 'delegate' ? 'agent_delegate' : 'agent_collect';
        return ipcCall(action, params);
      },
    ),

    // ── Image (singleton) ──
    tool('image', getToolDescription('image'),
      {
        prompt: z.string().describe('Text description of the image to generate'),
        model: z.string().optional().describe('Model ID override (defaults to first configured image model)'),
        size: z.string().optional().describe('Image size, e.g. "1024x1024"'),
        quality: z.string().optional().describe('Quality level, e.g. "standard" or "hd"'),
      },
      (args) => ipcCall('image_generate', args),
    ),

    // ── Sandbox (singleton tools for bash/file ops) ──
    // When localSandbox is set, tools execute in-container with host audit gate.
    tool('bash', getToolDescription('bash'),
      {
        command: z.string().describe('The bash command to execute'),
      },
      sandbox
        ? async (args) => textResult(await sandbox.bash(args.command))
        : (args) => ipcCall('sandbox_bash', args),
    ),

    tool('read_file', getToolDescription('read_file'),
      {
        path: z.string().describe('Relative path to the file'),
      },
      sandbox
        ? async (args) => textResult(await sandbox.readFile(args.path))
        : (args) => ipcCall('sandbox_read_file', args),
    ),

    tool('write_file', getToolDescription('write_file'),
      {
        path: z.string().describe('Relative path to the file'),
        content: z.string().describe('Content to write'),
      },
      sandbox
        ? async (args) => textResult(await sandbox.writeFile(args.path, args.content))
        : (args) => ipcCall('sandbox_write_file', args),
    ),

    tool('edit_file', getToolDescription('edit_file'),
      {
        path: z.string().describe('Relative path to the file'),
        old_string: z.string().describe('Text to find'),
        new_string: z.string().describe('Replacement text'),
      },
      sandbox
        ? async (args) => textResult(await sandbox.editFile(args.path, args.old_string, args.new_string))
        : (args) => ipcCall('sandbox_edit_file', args),
    ),

    // ── Grep (search file contents) ──
    tool('grep', getToolDescription('grep'),
      {
        pattern: z.string().max(10_000).describe('Regex pattern to search for'),
        path: z.string().max(1024).optional().describe('Directory to search in, relative to workspace (default: ".")'),
        glob: z.string().max(1024).optional().describe('File filter pattern, e.g. "*.ts", "*.{js,jsx}"'),
        max_results: z.number().int().min(1).max(10_000).optional().describe('Maximum matching lines to return (default: 100)'),
        include_line_numbers: z.boolean().optional().describe('Show line numbers (default: true)'),
        context_lines: z.number().int().min(0).max(20).optional().describe('Lines of context around each match (default: 0)'),
      },
      sandbox
        ? async (args) => textResult(await sandbox.grep(args.pattern, {
            path: args.path,
            glob: args.glob,
            max_results: args.max_results,
            include_line_numbers: args.include_line_numbers,
            context_lines: args.context_lines,
          }))
        : (args) => {
            const params = Object.fromEntries(Object.entries(args).filter(([_, v]) => v !== undefined));
            return ipcCall('sandbox_grep', params);
          },
    ),

    // ── Glob (find files by pattern) ──
    tool('glob', getToolDescription('glob'),
      {
        pattern: z.string().max(1024).describe('Glob pattern, e.g. "**/*.ts", "src/**/*.test.*"'),
        path: z.string().max(1024).optional().describe('Base directory, relative to workspace (default: ".")'),
        max_results: z.number().int().min(1).max(10_000).optional().describe('Maximum files to return (default: 100)'),
      },
      sandbox
        ? async (args) => textResult(await sandbox.glob(args.pattern, {
            path: args.path,
            max_results: args.max_results,
          }))
        : (args) => {
            const params = Object.fromEntries(Object.entries(args).filter(([_, v]) => v !== undefined));
            return ipcCall('sandbox_glob', params);
          },
    ),
  ];

  // Filter tools if context was provided
  const tools = allowedNames
    ? allTools.filter(t => allowedNames.has(t.name))
    : allTools;

  return createSdkMcpServer({
    name: 'ax-tools',
    version: '1.0.0',
    tools,
  });
}
