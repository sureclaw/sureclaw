/**
 * Shared IPC tool catalog — single source of truth for tool metadata.
 *
 * Both TypeBox consumers (ipc-tools.ts, pi-session.ts) derive their tool
 * arrays from this catalog. The Zod consumer (mcp-server.ts) stays manually
 * written but a sync test ensures its tool names and parameter keys match.
 *
 * Tools are consolidated: each entry may represent multiple IPC actions
 * selected via a `type` discriminator parameter. The actionMap / singletonAction
 * fields tell the execute layer which IPC action to dispatch.
 */

import { Type, type TSchema } from '@sinclair/typebox';

export type ToolCategory =
  | 'memory' | 'web' | 'audit' | 'identity'
  | 'scheduler' | 'skill' | 'delegation' | 'image'
  | 'workspace' | 'workspace_scopes' | 'governance' | 'sandbox';

export interface ToolSpec {
  name: string;
  label: string;
  description: string;
  parameters: TSchema;
  category: ToolCategory;
  /** When true, execute() must inject userId into IPC call params. */
  injectUserId?: boolean;
  /** Custom IPC call timeout in ms. Tools that spawn subprocesses (agent_delegate)
   *  or call slow external APIs (image_generate) need longer than the 30s default. */
  timeoutMs?: number;
  /** Maps type discriminator values to IPC action names. Present on multi-op tools. */
  actionMap?: Record<string, string>;
  /** IPC action name for singleton tools (no type param). */
  singletonAction?: string;
}

export const TOOL_CATALOG: readonly ToolSpec[] = [
  // ── Memory ──
  {
    name: 'memory',
    label: 'Memory',
    description:
      'Store, search, read, delete, and list memory entries.\n\nUse `type` to select:\n' +
      '- write: Store a memory entry with scope, content, and optional tags\n' +
      '- query: Search entries by scope and optional query string\n' +
      '- read: Read a specific entry by ID\n' +
      '- delete: Delete an entry by ID\n' +
      '- list: List entries in a scope',
    parameters: Type.Union([
      Type.Object({
        type: Type.Literal('write'),
        scope: Type.String(),
        content: Type.String(),
        tags: Type.Optional(Type.Array(Type.String())),
      }),
      Type.Object({
        type: Type.Literal('query'),
        scope: Type.String(),
        query: Type.Optional(Type.String()),
        limit: Type.Optional(Type.Number()),
        tags: Type.Optional(Type.Array(Type.String())),
      }),
      Type.Object({
        type: Type.Literal('read'),
        id: Type.String(),
      }),
      Type.Object({
        type: Type.Literal('delete'),
        id: Type.String(),
      }),
      Type.Object({
        type: Type.Literal('list'),
        scope: Type.String(),
        limit: Type.Optional(Type.Number()),
      }),
    ]),
    category: 'memory',
    actionMap: {
      write: 'memory_write',
      query: 'memory_query',
      read: 'memory_read',
      delete: 'memory_delete',
      list: 'memory_list',
    },
  },

  // ── Web ──
  {
    name: 'web',
    label: 'Web',
    description:
    'Retrieve web content.\n\n' +
    'If the user message contains a URL, ALWAYS use `type: "fetch"` with `url`.\n' +
    'Only use `type: "search"` when no URL is provided and the user is asking to find information on the web.\n' +
    'Never put a URL in `query`.',
    parameters: Type.Union([
      Type.Object({
        type: Type.Literal('fetch'),
        url: Type.String(),
        method: Type.Optional(Type.Union([Type.Literal('GET'), Type.Literal('HEAD')])),
        headers: Type.Optional(Type.Record(Type.String(), Type.String())),
        timeoutMs: Type.Optional(Type.Number()),
      }),
      Type.Object({
        type: Type.Literal('search'),
        query: Type.String(),
        maxResults: Type.Optional(Type.Number()),
      }),
    ]),
    category: 'web',
    actionMap: {
      fetch: 'web_fetch',
      search: 'web_search',
    },
  },

  // ── Identity ──
  {
    name: 'identity',
    label: 'Identity',
    description:
      'Read, write, or update identity files and user preferences.\n\nUse `type` to select:\n' +
      '- read: Read the current content of an identity file (SOUL.md or IDENTITY.md)\n' +
      '- write: Write or update a shared identity file (SOUL.md or IDENTITY.md)\n' +
      '- user_write: Write or update what you have learned about the current user (USER.md). Per-user scoped.',
    parameters: Type.Union([
      Type.Object({
        type: Type.Literal('read'),
        file: Type.String({ description: 'File name: "SOUL.md" or "IDENTITY.md"' }),
      }),
      Type.Object({
        type: Type.Literal('write'),
        file: Type.String({ description: 'File name: "SOUL.md" or "IDENTITY.md"' }),
        content: Type.String(),
        reason: Type.String(),
        origin: Type.String({ description: 'Either "user_request" or "agent_initiated"' }),
      }),
      Type.Object({
        type: Type.Literal('user_write'),
        content: Type.String(),
        reason: Type.String(),
        origin: Type.String({ description: 'Either "user_request" or "agent_initiated"' }),
      }),
    ]),
    category: 'identity',
    injectUserId: true,
    actionMap: {
      read: 'identity_read',
      write: 'identity_write',
      user_write: 'user_write',
    },
  },

  // ── Scheduler ──
  {
    name: 'scheduler',
    label: 'Scheduler',
    description:
      'Schedule recurring and one-shot tasks.\n\nUse `type` to select:\n' +
      '- add_cron: Schedule a recurring task using a 5-field cron expression\n' +
      '- run_at: Schedule a one-shot task at a specific date/time\n' +
      '- remove: Remove a previously scheduled cron job by its ID\n' +
      '- list: List all currently scheduled cron jobs',
    parameters: Type.Union([
      Type.Object({
        type: Type.Literal('add_cron'),
        schedule: Type.String({ description: 'Cron expression, e.g. "0 9 * * 1" for 9am every Monday' }),
        prompt: Type.String({ description: 'The instruction/prompt to execute on each trigger' }),
        maxTokenBudget: Type.Optional(Type.Number({ description: 'Optional max token budget per execution' })),
      }),
      Type.Object({
        type: Type.Literal('run_at'),
        datetime: Type.String({ description: 'ISO 8601 datetime in local time (no Z suffix), e.g. "2026-02-21T19:30:00". Use the current time from your system prompt to compute relative times.' }),
        prompt: Type.String({ description: 'The instruction/prompt to execute' }),
        maxTokenBudget: Type.Optional(Type.Number({ description: 'Optional max token budget for execution' })),
      }),
      Type.Object({
        type: Type.Literal('remove'),
        jobId: Type.String({ description: 'The job ID returned by scheduler_add_cron' }),
      }),
      Type.Object({
        type: Type.Literal('list'),
      }),
    ]),
    category: 'scheduler',
    actionMap: {
      add_cron: 'scheduler_add_cron',
      run_at: 'scheduler_run_at',
      remove: 'scheduler_remove_cron',
      list: 'scheduler_list_jobs',
    },
  },

  // ── Skill ──
  {
    name: 'skill',
    label: 'Skill',
    description:
      'Manage skills: search, download from ClawHub, or request credentials.\n\n' +
      'Use `type: "search"` to find skills by query.\n' +
      'Use `type: "download"` to download a skill package by slug. Returns all files and required credentials.\n' +
      'Use `type: "request_credential"` to request a credential (e.g. API key) that a skill needs.\n' +
      'The host will prompt the user to provide it. This ends the current turn; you will be\n' +
      're-invoked with the credential available as an environment variable.',
    parameters: Type.Union([
      Type.Object({
        type: Type.Literal('search'),
        query: Type.String({ description: 'Search query' }),
        limit: Type.Optional(Type.Number({ description: 'Max results (1-50, default 20)' })),
      }),
      Type.Object({
        type: Type.Literal('download'),
        slug: Type.String({ description: 'ClawHub skill slug (e.g. "linear-skill")' }),
      }),
      Type.Object({
        type: Type.Literal('request_credential'),
        envName: Type.String({ description: 'Environment variable name the skill requires (e.g. LINEAR_API_KEY)' }),
      }),
    ]),
    category: 'skill',
    actionMap: {
      search: 'skill_search',
      download: 'skill_download',
      request_credential: 'credential_request',
    },
  },

  // ── Workspace ──
  {
    name: 'workspace_write',
    label: 'Workspace Write',
    description:
      'Write a text file to a workspace tier (agent, user, or session) without requiring a sandbox.',
    parameters: Type.Object({
      tier: Type.String({ description: '"agent", "user", or "session"' }),
      path: Type.String({ description: 'Relative path within the tier (e.g. "docs/notes.md")' }),
      content: Type.String({ description: 'File content to write' }),
    }),
    category: 'workspace',
    singletonAction: 'workspace_write',
  },

  // ── Workspace Scopes ──
  {
    name: 'workspace_mount',
    label: 'Mount Workspace',
    description:
      'Mount workspace scopes for file persistence. Scopes: session (temporary), user (private), agent (shared). Additive — call multiple times to add scopes.',
    parameters: Type.Object({
      scopes: Type.Array(Type.String({ description: 'Scopes to mount: "session", "user", or "agent"' })),
    }),
    category: 'workspace_scopes',
    singletonAction: 'workspace_mount',
  },

  // ── Governance ──
  {
    name: 'governance',
    label: 'Governance',
    description:
      'Enterprise governance: propose identity changes, list proposals, list agents.\n\nUse `type` to select:\n' +
      '- propose: Propose a change to a shared identity file for governance review\n' +
      '- list_proposals: List governance proposals, optionally filtered by status\n' +
      '- list_agents: List all registered agents in the enterprise registry',
    parameters: Type.Union([
      Type.Object({
        type: Type.Literal('propose'),
        file: Type.String({ description: 'File name: "SOUL.md" or "IDENTITY.md"' }),
        content: Type.String(),
        reason: Type.String(),
        origin: Type.String({ description: 'Either "user_request" or "agent_initiated"' }),
      }),
      Type.Object({
        type: Type.Literal('list_proposals'),
        status: Type.Optional(Type.String({ description: '"pending", "approved", or "rejected"' })),
      }),
      Type.Object({
        type: Type.Literal('list_agents'),
        status: Type.Optional(Type.String({ description: 'Filter by status: "active", "suspended", or "archived"' })),
      }),
    ]),
    category: 'governance',
    actionMap: {
      propose: 'identity_propose',
      list_proposals: 'proposal_list',
      list_agents: 'agent_registry_list',
    },
  },

  // ── Audit (singleton) ──
  {
    name: 'audit',
    label: 'Query Audit Log',
    description: 'Query the audit log with filters.',
    parameters: Type.Object({
      action: Type.Optional(Type.String()),
      sessionId: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Number()),
    }),
    category: 'audit',
    singletonAction: 'audit_query',
  },

  // ── Agent ──
  {
    name: 'agent',
    label: 'Agent',
    description:
      'Delegate tasks to sub-agents and collect results.\n\nUse `type` to select:\n' +
      '- delegate: Launch a sub-agent in its own sandbox (blocks by default, or fire-and-forget with wait: false)\n' +
      '- collect: Collect results from fire-and-forget delegates launched with wait: false',
    parameters: Type.Union([
      Type.Object({
        type: Type.Literal('delegate'),
        task: Type.String({ description: 'The task description for the sub-agent' }),
        context: Type.Optional(Type.String({ description: 'Background context the sub-agent should know' })),
        runner: Type.Optional(Type.String({ description: '"pi-coding-agent" or "claude-code"' })),
        model: Type.Optional(Type.String({ description: 'Model ID override for the sub-agent (e.g. "claude-sonnet-4-5-20250929")' })),
        maxTokens: Type.Optional(Type.Number({ description: 'Max tokens for the sub-agent response' })),
        timeoutSec: Type.Optional(Type.Number({ description: 'Timeout in seconds (5-600)' })),
        wait: Type.Optional(Type.Boolean({ description: 'If false, launch in background and return immediately with a handleId. Default: true (blocking).' })),
        resourceTier: Type.Optional(Type.String({ description: '"default" (1 vCPU, 256MB) or "heavy" (4 vCPU, 2GB) — request more resources for intensive tasks' })),
      }),
      Type.Object({
        type: Type.Literal('collect'),
        handleIds: Type.Array(Type.String({ description: 'Handle IDs returned by delegate with wait: false' })),
        timeoutMs: Type.Optional(Type.Number({ description: 'Timeout in milliseconds (default: 300000 = 5 min)' })),
      }),
    ]),
    category: 'delegation',
    timeoutMs: 600_000,
    actionMap: {
      delegate: 'agent_delegate',
      collect: 'agent_collect',
    },
  },

  // ── Image (singleton) ──
  {
    name: 'image',
    label: 'Generate Image',
    description:
      'Generate an image from a text prompt using a configured image model. ' +
      'Returns a JSON object with a `url` field. Display the image in your response ' +
      'using markdown: ![description](url)',
    parameters: Type.Object({
      prompt: Type.String({ description: 'Text description of the image to generate' }),
      model: Type.Optional(Type.String({ description: 'Model ID override (defaults to first configured image model)' })),
      size: Type.Optional(Type.String({ description: 'Image size, e.g. "1024x1024"' })),
      quality: Type.Optional(Type.String({ description: 'Quality level, e.g. "standard" or "hd"' })),
    }),
    category: 'image',
    timeoutMs: 120_000,
    singletonAction: 'image_generate',
  },

  // ── Web Proxy Governance ──
  {
    name: 'web_approve',
    label: 'Approve Web Access',
    description:
      'Approve network access to a domain for commands that need internet ' +
      '(npm install, pip install, curl, git clone, etc.).\n\n' +
      'Call this BEFORE running a bash command that needs to reach an external domain. ' +
      'Example: approve "registry.npmjs.org" before `npm install`.',
    parameters: Type.Object({
      domain: Type.String({ description: 'Domain to approve, e.g. "registry.npmjs.org"' }),
      approved: Type.Boolean({ description: 'true to approve, false to deny' }),
    }),
    category: 'web',
    singletonAction: 'web_proxy_approve',
  },

  // ── Sandbox (singleton tools for bash/file ops) ──
  {
    name: 'bash',
    label: 'Run Command',
    description: 'Execute a bash command in the workspace directory.',
    parameters: Type.Object({
      command: Type.String({ description: 'The bash command to execute' }),
    }),
    category: 'sandbox',
    timeoutMs: 180_000,
    singletonAction: 'sandbox_bash',
  },
  {
    name: 'read_file',
    label: 'Read File',
    description: 'Read the contents of a file in the workspace.',
    parameters: Type.Object({
      path: Type.String({ description: 'Relative path to the file' }),
    }),
    category: 'sandbox',
    singletonAction: 'sandbox_read_file',
  },
  {
    name: 'write_file',
    label: 'Write File',
    description: 'Write content to a file in the workspace.',
    parameters: Type.Object({
      path: Type.String({ description: 'Relative path to the file' }),
      content: Type.String({ description: 'Content to write' }),
    }),
    category: 'sandbox',
    singletonAction: 'sandbox_write_file',
  },
  {
    name: 'edit_file',
    label: 'Edit File',
    description: 'Replace a string in a file.',
    parameters: Type.Object({
      path: Type.String({ description: 'Relative path to the file' }),
      old_string: Type.String({ description: 'Text to find' }),
      new_string: Type.String({ description: 'Replacement text' }),
    }),
    category: 'sandbox',
    singletonAction: 'sandbox_edit_file',
  },
] as const;

/** All tool names, derived from the catalog. */
export const TOOL_NAMES: string[] = TOOL_CATALOG.map(s => s.name);

/** Extract parameter key names for a given tool (for sync tests). */
export function getToolParamKeys(name: string): string[] {
  const spec = TOOL_CATALOG.find(s => s.name === name);
  if (!spec) throw new Error(`Unknown tool: ${name}`);
  const schema = spec.parameters as any;
  if (schema.anyOf) {
    // Union: collect all keys from all members, excluding 'type'
    const keys = new Set<string>();
    for (const member of schema.anyOf) {
      for (const key of Object.keys(member.properties ?? {})) {
        if (key !== 'type') keys.add(key);
      }
    }
    return [...keys];
  }
  return Object.keys(schema.properties ?? {});
}

// ── Context-aware tool filtering ──────────────────────────────────────
//
// Runners pass a ToolFilterContext derived from the same data the prompt
// builder uses. Categories excluded here match prompt modules excluded by
// their shouldInclude() — e.g., no heartbeat content → no scheduler tools
// AND no HeartbeatModule in the system prompt.

export interface ToolFilterContext {
  /** identityFiles.heartbeat is non-empty */
  hasHeartbeat: boolean;
  /** Workspace scoped mounts available (workspace provider != 'none') */
  hasWorkspaceScopes: boolean;
  /** Enterprise governance enabled */
  hasGovernance: boolean;
}

/**
 * Filter the catalog to tools relevant to the current session.
 * Without a context, returns the full catalog (backward compat).
 */
export function filterTools(ctx: ToolFilterContext): readonly ToolSpec[] {
  return TOOL_CATALOG.filter(spec => {
    switch (spec.category) {
      case 'scheduler':  return ctx.hasHeartbeat;
      case 'skill':      return true;
      case 'workspace':        return ctx.hasWorkspaceScopes;
      case 'workspace_scopes': return ctx.hasWorkspaceScopes;
      case 'governance': return ctx.hasGovernance;
      default:           return true;
    }
  });
}

// ── Parameter normalization for weaker models ────────────────────────
//
// Models like Gemini/Kimi send free-text strings for enum fields.
// These normalizers coerce to the strict values the IPC schema expects.

const ORIGIN_VALUES = ['user_request', 'agent_initiated'] as const;

/** Normalize an origin value to a valid enum. Defaults to 'user_request'. */
export function normalizeOrigin(raw: unknown): 'user_request' | 'agent_initiated' {
  if (typeof raw === 'string') {
    const lower = raw.toLowerCase().replace(/[\s-]/g, '_');
    for (const v of ORIGIN_VALUES) {
      if (lower === v || lower.includes(v)) return v;
    }
  }
  return 'user_request';
}

const IDENTITY_FILE_MAP: Record<string, string> = {
  'soul.md': 'SOUL.md', 'soul': 'SOUL.md',
  'identity.md': 'IDENTITY.md', 'identity': 'IDENTITY.md',
};

/** Normalize a file name to 'SOUL.md' or 'IDENTITY.md'. Returns raw value if unrecognized. */
export function normalizeIdentityFile(raw: unknown): string {
  if (typeof raw === 'string') {
    return IDENTITY_FILE_MAP[raw.toLowerCase()] ?? raw;
  }
  return String(raw);
}
