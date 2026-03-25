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
import { normalizeOrigin, filterTools } from './tool-catalog.js';
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
    tool('memory',
      'Store, search, read, delete, and list memory entries.\n\n' +
      'Use `type` to select:\n' +
      '- write: Store a memory entry (requires scope, content)\n' +
      '- query: Search entries (requires scope, optional query/limit/tags)\n' +
      '- read: Read entry by ID (requires id)\n' +
      '- delete: Delete entry by ID (requires id)\n' +
      '- list: List entries in scope (requires scope, optional limit)',
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
    tool(
      'web',
      'Retrieve web content.\n\n' +
      'If the user message contains a URL, ALWAYS use `type: "fetch"` with `url`.\n' +
      'Only use `type: "search"` when no URL is provided and the user is asking to find information on the web.\n' +
      'Never put a URL in `query`.',
      {
        type: z.enum(['fetch', 'search']),
        url: z.string().url().optional(),
        method: z.enum(['GET', 'HEAD']).optional(),
        headers: z.record(z.string(), z.string()).optional(),
        timeoutMs: z.number().optional(),
        query: z.string().optional(),
        maxResults: z.number().optional(),
      },
      (args) => {
        const { type, ...rest } = args;
        const params = Object.fromEntries(Object.entries(rest).filter(([_, v]) => v !== undefined));
        return ipcCall(`web_${type}`, params);
      },
    ),

    // ── Identity ──
    tool('identity',
      'Read, write, or update identity files or user preferences.\n\n' +
      'Use `type` to select:\n' +
      '- read: Read current content of SOUL.md or IDENTITY.md (requires file)\n' +
      '- write: Update SOUL.md or IDENTITY.md (requires file, content, reason, origin)\n' +
      '- user_write: Update user preferences USER.md (requires content, reason, origin)',
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
    tool('scheduler',
      'Schedule recurring and one-shot tasks.\n\n' +
      'Use `type` to select:\n' +
      '- add_cron: Schedule recurring task (requires schedule, prompt)\n' +
      '- run_at: Schedule one-shot task (requires datetime, prompt)\n' +
      '- remove: Remove a scheduled job (requires jobId)\n' +
      '- list: List all scheduled jobs',
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
    tool('skill',
      'Install a skill from ClawHub by slug or search query. ' +
      'The host downloads, screens, writes files, and adds domains to the proxy allowlist.',
      {
        query: z.string().optional().describe('Search query (finds best match and installs)'),
        slug: z.string().optional().describe('ClawHub skill slug (e.g. "linear-skill")'),
      },
      (args) => ipcCall('skill_install', args),
    ),

    // ── Credential ──
    tool('request_credential',
      'Request a credential (e.g. API key) that a skill or web API call needs.\n' +
      'The host will prompt the user to provide it. This ends the current turn; you will be\n' +
      're-invoked with the credential available as an environment variable.',
      {
        envName: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/).describe('Environment variable name needed (e.g. LINEAR_API_KEY). Must be uppercase with underscores only.'),
      },
      (args) => ipcCall('credential_request', args),
    ),

    // ── Workspace ──
    tool('workspace_write',
      'Write a text file to a workspace tier (agent, user, or session) without requiring a sandbox.',
      {
        tier: z.string().describe('"agent", "user", or "session"'),
        path: z.string().describe('Relative path within the tier (e.g. "docs/notes.md")'),
        content: z.string().describe('File content to write'),
      },
      (args) => ipcCall('workspace_write', args),
    ),

    // ── Workspace Scopes ──
    tool('workspace_mount',
      'Mount workspace scopes for file persistence. Scopes: session (temporary), user (private), agent (shared). Additive — call multiple times to add scopes.',
      {
        scopes: z.array(z.string()).describe('Scopes to mount: "session", "user", or "agent"'),
      },
      (args) => ipcCall('workspace_mount', args),
    ),

    // ── Governance ──
    tool('governance',
      'Enterprise governance: propose identity changes, list proposals, list agents.\n\n' +
      'Use `type` to select:\n' +
      '- propose: Propose a change to a shared identity file (requires file, content, reason, origin)\n' +
      '- list_proposals: List governance proposals (optional status filter)\n' +
      '- list_agents: List registered agents (optional status filter)',
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
    tool('audit', 'Query the audit log with filters.', {
      action: z.string().optional(),
      sessionId: z.string().optional(),
      limit: z.number().optional(),
    }, (args) => ipcCall('audit_query', args)),

    // ── Agent ──
    tool('agent',
      'Delegate tasks to sub-agents and collect results.\n\n' +
      'Use `type` to select:\n' +
      '- delegate: Launch a sub-agent in its own sandbox (blocks by default, or fire-and-forget with wait: false)\n' +
      '- collect: Collect results from fire-and-forget delegates launched with wait: false',
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
    tool('image',
      'Generate an image from a text prompt using a configured image model. ' +
      'Returns a JSON object with a `url` field. Display the image in your response ' +
      'using markdown: ![description](url)',
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
    tool('bash',
      'Execute a bash command in the workspace directory.',
      {
        command: z.string().describe('The bash command to execute'),
      },
      sandbox
        ? async (args) => textResult(await sandbox.bash(args.command))
        : (args) => ipcCall('sandbox_bash', args),
    ),

    tool('read_file',
      'Read the contents of a file in the workspace.',
      {
        path: z.string().describe('Relative path to the file'),
      },
      sandbox
        ? async (args) => textResult(await sandbox.readFile(args.path))
        : (args) => ipcCall('sandbox_read_file', args),
    ),

    tool('write_file',
      'Write content to a file in the workspace.',
      {
        path: z.string().describe('Relative path to the file'),
        content: z.string().describe('Content to write'),
      },
      sandbox
        ? async (args) => textResult(await sandbox.writeFile(args.path, args.content))
        : (args) => ipcCall('sandbox_write_file', args),
    ),

    tool('edit_file',
      'Replace a string in a file.',
      {
        path: z.string().describe('Relative path to the file'),
        old_string: z.string().describe('Text to find'),
        new_string: z.string().describe('Replacement text'),
      },
      sandbox
        ? async (args) => textResult(await sandbox.editFile(args.path, args.old_string, args.new_string))
        : (args) => ipcCall('sandbox_edit_file', args),
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
