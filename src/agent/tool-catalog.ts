/**
 * Shared IPC tool catalog — single source of truth for tool metadata.
 *
 * TypeBox consumers (ipc-tools.ts, pi-session.ts) derive their tool arrays
 * from this catalog. The Zod consumer (mcp-server.ts) imports descriptions
 * via getToolDescription() and defines only Zod schemas + execution logic.
 *
 * Tools are consolidated: each entry may represent multiple IPC actions
 * selected via a `type` discriminator parameter. The actionMap / singletonAction
 * fields tell the execute layer which IPC action to dispatch.
 */

import { Type, type TSchema } from '@sinclair/typebox';

export type ToolCategory =
  | 'memory' | 'web' | 'audit'
  | 'scheduler' | 'skill' | 'credential' | 'delegation'
  | 'workspace' | 'sandbox';

export interface ToolSpec {
  name: string;
  label: string;
  description: string;
  parameters: TSchema;
  category: ToolCategory;
  /** When true, execute() must inject userId into IPC call params. */
  injectUserId?: boolean;
  /** Custom IPC call timeout in ms. Tools that spawn subprocesses (agent_delegate)
   *  or call slow external APIs need longer than the 30s default. */
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
      'Access the web. Pick ONE type:\n\n' +
      'type="search": Find information when you do NOT have a URL. Requires `query` (plain text, NOT a URL). Returns a list of relevant URLs and snippets.\n' +
      'type="extract": Read a webpage when you HAVE a URL and want the text content. Requires `url`. Returns cleaned readable text (like reader mode). Best for articles, docs, blog posts.\n' +
      'type="fetch": Make a raw HTTP request when you HAVE a URL and need the exact response (HTML, JSON, headers). Requires `url`. Best for APIs and machine-readable data.\n\n' +
      'RULES:\n' +
      '- If you have a URL and want to read it → use "extract" (not "search")\n' +
      '- If you need to find something and have no URL → use "search"\n' +
      '- If you need raw JSON/HTML or custom headers → use "fetch"\n' +
      '- NEVER put a URL in the `query` field. URLs go in `url` only.',
    parameters: Type.Union([
      Type.Object({
        type: Type.Literal('fetch'),
        url: Type.String({ description: 'The full URL to fetch (e.g. "https://api.example.com/data"). Required for type="fetch".' }),
        method: Type.Optional(Type.Union([Type.Literal('GET'), Type.Literal('HEAD')])),
        headers: Type.Optional(Type.Record(Type.String(), Type.String())),
        timeoutMs: Type.Optional(Type.Number()),
      }),
      Type.Object({
        type: Type.Literal('extract'),
        url: Type.String({ description: 'The full URL of the webpage to extract text from (e.g. "https://example.com/article"). Required for type="extract".' }),
      }),
      Type.Object({
        type: Type.Literal('search'),
        query: Type.String({ description: 'Search query in plain text (e.g. "how to parse JSON in Python"). Must NOT be a URL. Required for type="search".' }),
        maxResults: Type.Optional(Type.Number({ description: 'Maximum number of search results to return (default: 5)' })),
      }),
    ]),
    category: 'web',
    actionMap: {
      fetch: 'web_fetch',
      extract: 'web_extract',
      search: 'web_search',
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
        id: Type.String({ description: 'The job ID to remove' }),
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
      'Create, install, update, and delete skills.\n\nUse `type` to select:\n' +
      '- create: Create a new skill from SKILL.md content. Non-admin users in DM/web get a personal skill; admins get an agent-wide skill.\n' +
      '- install: Install a skill from ClawHub by slug or search query\n' +
      '- update: Update a specific file in a skill\n' +
      '- delete: Uninstall a skill by slug',
    parameters: Type.Union([
      Type.Object({
        type: Type.Literal('create'),
        slug: Type.String({ description: 'Skill slug (short name, e.g. "my-helper")' }),
        content: Type.String({ description: 'Full SKILL.md content' }),
      }),
      Type.Object({
        type: Type.Literal('install'),
        slug: Type.String({ description: 'ClawHub skill slug (owner/name or URL)' }),
      }),
      Type.Object({
        type: Type.Literal('install'),
        query: Type.String({ description: 'Search query to find skills on ClawHub' }),
      }),
      Type.Object({
        type: Type.Literal('update'),
        slug: Type.String({ description: 'Skill slug to update' }),
        path: Type.String({ description: 'File path within the skill (e.g. "SKILL.md")' }),
        content: Type.String({ description: 'New file content' }),
      }),
      Type.Object({
        type: Type.Literal('delete'),
        slug: Type.String({ description: 'Skill slug to delete' }),
      }),
    ]),
    category: 'skill',
    actionMap: {
      create: 'skill_create',
      install: 'skill_install',
      update: 'skill_update',
      delete: 'skill_delete',
    },
  },

  // ── Credential ──
  {
    name: 'request_credential',
    label: 'Request Credential',
    description:
      'Request a credential (e.g. API key) that a skill or web API call needs.\n' +
      'The host will prompt the user to provide it.\n\n' +
      'IMPORTANT: If the response shows available=false, you MUST stop immediately.\n' +
      'Tell the user what credential is needed and why, then end your turn.\n' +
      'Do NOT attempt to use the skill, call APIs, or run scripts without the credential.\n' +
      'The credential will be available as an environment variable when you are re-invoked on the next turn.',
    parameters: Type.Object({
      envName: Type.String({
        pattern: '^[A-Z][A-Z0-9_]{1,63}$',
        description: 'Environment variable name needed (e.g. LINEAR_API_KEY). Must be uppercase with underscores only.',
      }),
    }),
    category: 'credential',
    singletonAction: 'credential_request',
  },

  // ── Workspace ──
  {
    name: 'save_artifact',
    label: 'Save Artifact',
    description:
      'Save a file as a downloadable artifact for the user. Use this when the user asks you to create, generate, or save a file they can download (documents, reports, poems, code files, etc.). Files saved here are immediately available for download in the chat UI.',
    parameters: Type.Object({
      tier: Type.String({ description: '"agent", "user", or "session"' }),
      path: Type.String({ description: 'Filename with extension (e.g. "report.md", "poem.txt")' }),
      content: Type.String({ description: 'File content to write' }),
    }),
    category: 'workspace',
    singletonAction: 'save_artifact',
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
    description: 'Write content to a file in the workspace. Files written to artifacts/ (e.g. "artifacts/poem.md") are automatically uploaded and made available for download in the chat UI.',
    parameters: Type.Object({
      path: Type.String({ description: 'Relative path to the file. Use "artifacts/" prefix for downloadable files.' }),
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
  {
    name: 'grep',
    label: 'Search File Contents',
    description:
      'Search file contents using regex patterns. Returns matching lines with context.\n\n' +
      'Use this instead of running grep/rg via bash — it limits output to protect your context window.\n\n' +
      'Parameters:\n' +
      '- pattern: Regex pattern to search for (required)\n' +
      '- path: Directory to search in, relative to workspace (default: ".")\n' +
      '- glob: File filter pattern, e.g. "*.ts", "*.{js,jsx}" (optional)\n' +
      '- max_results: Maximum matching lines to return (default: 100)\n' +
      '- include_line_numbers: Show line numbers (default: true)\n' +
      '- context_lines: Lines of context around each match (default: 0)',
    parameters: Type.Object({
      pattern: Type.String({ description: 'Regex pattern to search for' }),
      path: Type.Optional(Type.String({ description: 'Directory to search in, relative to workspace (default: ".")' })),
      glob: Type.Optional(Type.String({ description: 'File filter pattern, e.g. "*.ts", "*.{js,jsx}"' })),
      max_results: Type.Optional(Type.Number({ description: 'Maximum matching lines to return (default: 100)' })),
      include_line_numbers: Type.Optional(Type.Boolean({ description: 'Show line numbers (default: true)' })),
      context_lines: Type.Optional(Type.Number({ description: 'Lines of context around each match (default: 0)' })),
    }),
    category: 'sandbox',
    singletonAction: 'sandbox_grep',
  },
  {
    name: 'glob',
    label: 'Find Files',
    description:
      'Find files by name or path pattern. Returns matching file paths.\n\n' +
      'Use this instead of running find/ls via bash — it limits output to protect your context window.\n\n' +
      'Parameters:\n' +
      '- pattern: Glob pattern, e.g. "**/*.ts", "src/**/*.test.*" (required)\n' +
      '- path: Base directory, relative to workspace (default: ".")\n' +
      '- max_results: Maximum files to return (default: 100)',
    parameters: Type.Object({
      pattern: Type.String({ description: 'Glob pattern, e.g. "**/*.ts", "src/**/*.test.*"' }),
      path: Type.Optional(Type.String({ description: 'Base directory, relative to workspace (default: ".")' })),
      max_results: Type.Optional(Type.Number({ description: 'Maximum files to return (default: 100)' })),
    }),
    category: 'sandbox',
    singletonAction: 'sandbox_glob',
  },
] as const;

/** All tool names, derived from the catalog. */
export const TOOL_NAMES: string[] = TOOL_CATALOG.map(s => s.name);

/** Look up a tool's description by name. Single source of truth for both TypeBox and Zod consumers. */
export function getToolDescription(name: string): string {
  const spec = TOOL_CATALOG.find(s => s.name === name);
  if (!spec) throw new Error(`Unknown tool: ${name}`);
  return spec.description;
}

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
// their shouldInclude() — e.g., no governance config → no governance tools.

export interface ToolFilterContext {
  /** identityFiles.heartbeat is non-empty (used by prompt modules, not tool filtering) */
  hasHeartbeat: boolean;
  /** User message indicates skill install intent — show install tool */
  skillInstallEnabled?: boolean;
}

/**
 * Filter the catalog to tools relevant to the current session.
 * Without a context, returns the full catalog (backward compat).
 *
 * When skillInstallEnabled is false, the skill tool's install variants
 * are stripped from its parameter union so the LLM can't attempt installs.
 */
export function filterTools(ctx: ToolFilterContext): readonly ToolSpec[] {
  return TOOL_CATALOG
    .filter(spec => {
      switch (spec.category) {
        case 'scheduler':  return true;  // always available — HEARTBEAT.md controls heartbeat content, not tool visibility
        case 'skill':      return true;  // always available — delete/update shouldn't require install intent
        default:           return true;
      }
    })
    .map(spec => {
      // Strip install variants from skill tool when install intent not detected
      if (spec.category === 'skill' && !ctx.skillInstallEnabled) {
        return stripSkillInstall(spec);
      }
      return spec;
    });
}

/** Remove install variants from skill tool's parameter union and actionMap. */
function stripSkillInstall(spec: ToolSpec): ToolSpec {
  const schema = spec.parameters as { anyOf?: Array<{ properties?: { type?: { const?: string } } }> };
  if (!schema.anyOf) return spec;

  const filtered = schema.anyOf.filter(
    variant => variant.properties?.type?.const !== 'install',
  );
  if (filtered.length === schema.anyOf.length) return spec; // nothing to strip

  const { install: _, ...remainingActions } = spec.actionMap ?? {};
  const description = spec.description
    .replace('Create, install, update, and delete', 'Create, update, and delete')
    .replace(/\n- install:[^\n]*/g, '');
  return {
    ...spec,
    description,
    parameters: Type.Union(filtered as TSchema[]),
    actionMap: remainingActions,
  };
}

