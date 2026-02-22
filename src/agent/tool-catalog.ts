/**
 * Shared IPC tool catalog — single source of truth for tool metadata.
 *
 * Both TypeBox consumers (ipc-tools.ts, pi-session.ts) derive their tool
 * arrays from this catalog. The Zod consumer (mcp-server.ts) stays manually
 * written but a sync test ensures its tool names and parameter keys match.
 */

import { Type, type TSchema } from '@sinclair/typebox';

export interface ToolSpec {
  name: string;
  label: string;
  description: string;
  parameters: TSchema;
  /** When true, execute() must inject userId into IPC call params. */
  injectUserId?: boolean;
}

export const TOOL_CATALOG: readonly ToolSpec[] = [
  // ── Memory tools ──
  {
    name: 'memory_write',
    label: 'Write Memory',
    description:
      'Store a factual memory entry with scope, content, and optional tags. For name, personality, or style changes use identity_write or user_write instead.',
    parameters: Type.Object({
      scope: Type.String(),
      content: Type.String(),
      tags: Type.Optional(Type.Array(Type.String())),
    }),
  },
  {
    name: 'memory_query',
    label: 'Query Memory',
    description: 'Search memory entries by scope and optional query string.',
    parameters: Type.Object({
      scope: Type.String(),
      query: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Number()),
      tags: Type.Optional(Type.Array(Type.String())),
    }),
  },
  {
    name: 'memory_read',
    label: 'Read Memory',
    description: 'Read a specific memory entry by ID.',
    parameters: Type.Object({
      id: Type.String(),
    }),
  },
  {
    name: 'memory_delete',
    label: 'Delete Memory',
    description: 'Delete a memory entry by ID.',
    parameters: Type.Object({
      id: Type.String(),
    }),
  },
  {
    name: 'memory_list',
    label: 'List Memory',
    description: 'List memory entries in a scope.',
    parameters: Type.Object({
      scope: Type.String(),
      limit: Type.Optional(Type.Number()),
    }),
  },

  // ── Web tools ──
  {
    name: 'web_fetch',
    label: 'Fetch URL',
    description: 'Fetch content from a URL (proxied through host with SSRF protection).',
    parameters: Type.Object({
      url: Type.String(),
      method: Type.Optional(Type.Union([Type.Literal('GET'), Type.Literal('HEAD')])),
      headers: Type.Optional(Type.Record(Type.String(), Type.String())),
      timeoutMs: Type.Optional(Type.Number()),
    }),
  },
  {
    name: 'web_search',
    label: 'Web Search',
    description: 'Search the web (proxied through host).',
    parameters: Type.Object({
      query: Type.String(),
      maxResults: Type.Optional(Type.Number()),
    }),
  },

  // ── Audit tool ──
  {
    name: 'audit_query',
    label: 'Query Audit Log',
    description: 'Query the audit log with filters.',
    parameters: Type.Object({
      action: Type.Optional(Type.String()),
      sessionId: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Number()),
    }),
  },

  // ── Identity tools ──
  {
    name: 'identity_write',
    label: 'Write Identity',
    description:
      'Write or update a shared identity file (SOUL.md or IDENTITY.md). ' +
      'Use when you want to evolve your personality or update your self-description. ' +
      'For recording user preferences, use user_write instead. ' +
      'Auto-applied in clean sessions; queued for review when ' +
      'external content is present. All changes are audited.',
    parameters: Type.Object({
      file: Type.String({ description: 'File name: "SOUL.md" or "IDENTITY.md"' }),
      content: Type.String(),
      reason: Type.String(),
      origin: Type.String({ description: 'Either "user_request" or "agent_initiated"' }),
    }),
  },
  {
    name: 'user_write',
    label: 'Write User Preferences',
    description:
      'Write or update what you have learned about the current user (USER.md). ' +
      'Records preferences, workflows, communication style. Per-user scoped — ' +
      'each user gets their own file. Auto-applied in clean sessions; queued when tainted. ' +
      'All changes are audited.',
    parameters: Type.Object({
      content: Type.String(),
      reason: Type.String(),
      origin: Type.String({ description: 'Either "user_request" or "agent_initiated"' }),
    }),
    injectUserId: true,
  },

  // ── Scheduler tools ──
  {
    name: 'scheduler_add_cron',
    label: 'Add Cron Job',
    description:
      'Schedule a recurring task using a 5-field cron expression (minute hour day month weekday). The prompt will be sent to you at each matching time.',
    parameters: Type.Object({
      schedule: Type.String({ description: 'Cron expression, e.g. "0 9 * * 1" for 9am every Monday' }),
      prompt: Type.String({ description: 'The instruction/prompt to execute on each trigger' }),
      maxTokenBudget: Type.Optional(Type.Number({ description: 'Optional max token budget per execution' })),
    }),
  },
  {
    name: 'scheduler_run_at',
    label: 'Run Once At',
    description:
      'Schedule a one-shot task at a specific date/time. The prompt executes once and the job is automatically removed.',
    parameters: Type.Object({
      datetime: Type.String({ description: 'ISO 8601 datetime in local time (no Z suffix), e.g. "2026-02-21T19:30:00". Use the current time from your system prompt to compute relative times.' }),
      prompt: Type.String({ description: 'The instruction/prompt to execute' }),
      maxTokenBudget: Type.Optional(Type.Number({ description: 'Optional max token budget for execution' })),
    }),
  },
  {
    name: 'scheduler_remove_cron',
    label: 'Remove Cron Job',
    description: 'Remove a previously scheduled cron job by its ID.',
    parameters: Type.Object({
      jobId: Type.String({ description: 'The job ID returned by scheduler_add_cron' }),
    }),
  },
  {
    name: 'scheduler_list_jobs',
    label: 'List Cron Jobs',
    description: 'List all currently scheduled cron jobs.',
    parameters: Type.Object({}),
  },

  // ── Skill tools ──
  {
    name: 'skill_list',
    label: 'List Skills',
    description:
      'List all available skills. Returns skill names and descriptions.',
    parameters: Type.Object({}),
  },
  {
    name: 'skill_read',
    label: 'Read Skill',
    description:
      'Read the full content of a skill by name.',
    parameters: Type.Object({
      name: Type.String(),
    }),
  },
  {
    name: 'skill_propose',
    label: 'Propose Skill',
    description:
      'Propose a new skill or update an existing one. The skill content is markdown — ' +
      'prompt-level instructions that guide your behavior (like a checklist or workflow). ' +
      'Content is screened for safety: dangerous patterns (exec, eval, fetch) are hard-rejected, ' +
      'capability patterns (fs-write, env-access) require human review, clean content is auto-approved. ' +
      'Auto-approved skills are available on your next turn in this session.',
    parameters: Type.Object({
      skill: Type.String({ description: 'Skill name (alphanumeric, hyphens, underscores)' }),
      content: Type.String({ description: 'Skill content as markdown' }),
      reason: Type.Optional(Type.String({ description: 'Why this skill is needed' })),
    }),
  },

  // ── Enterprise: Workspace tools ──
  {
    name: 'workspace_write',
    label: 'Write to Workspace',
    description:
      'Write a file to a workspace tier. Tiers: "agent" (shared, read-only to sandbox), ' +
      '"user" (per-user, persistent), "scratch" (ephemeral, per-session). ' +
      'Agent tier writes may require approval in paranoid mode.',
    parameters: Type.Object({
      tier: Type.String({ description: '"agent", "user", or "scratch"' }),
      path: Type.String({ description: 'Relative path within the tier (e.g. "docs/notes.md")' }),
      content: Type.String({ description: 'File content to write' }),
    }),
  },
  {
    name: 'workspace_read',
    label: 'Read from Workspace',
    description:
      'Read a file from a workspace tier.',
    parameters: Type.Object({
      tier: Type.String({ description: '"agent", "user", or "scratch"' }),
      path: Type.String({ description: 'Relative path within the tier' }),
    }),
  },
  {
    name: 'workspace_list',
    label: 'List Workspace',
    description:
      'List files in a workspace tier directory.',
    parameters: Type.Object({
      tier: Type.String({ description: '"agent", "user", or "scratch"' }),
      path: Type.Optional(Type.String({ description: 'Subdirectory to list (defaults to root)' })),
    }),
  },

  // ── Enterprise: Governance tools ──
  {
    name: 'identity_propose',
    label: 'Propose Identity Change',
    description:
      'Propose a change to a shared identity file (SOUL.md or IDENTITY.md) for review. ' +
      'Unlike identity_write which may auto-apply, proposals always go through governance. ' +
      'Use when you want to suggest a change that requires human approval.',
    parameters: Type.Object({
      file: Type.String({ description: 'File name: "SOUL.md" or "IDENTITY.md"' }),
      content: Type.String(),
      reason: Type.String(),
      origin: Type.String({ description: 'Either "user_request" or "agent_initiated"' }),
    }),
  },
  {
    name: 'proposal_list',
    label: 'List Proposals',
    description:
      'List governance proposals. Optionally filter by status (pending, approved, rejected).',
    parameters: Type.Object({
      status: Type.Optional(Type.String({ description: '"pending", "approved", or "rejected"' })),
    }),
  },
  {
    name: 'agent_registry_list',
    label: 'List Agents',
    description:
      'List all registered agents in the enterprise registry.',
    parameters: Type.Object({
      status: Type.Optional(Type.String({ description: 'Filter by status: "active", "suspended", or "archived"' })),
    }),
  },
] as const;

/** All tool names, derived from the catalog. */
export const TOOL_NAMES: string[] = TOOL_CATALOG.map(s => s.name);

/** Extract parameter key names for a given tool (for sync tests). */
export function getToolParamKeys(name: string): string[] {
  const spec = TOOL_CATALOG.find(s => s.name === name);
  if (!spec) throw new Error(`Unknown tool: ${name}`);
  const schema = spec.parameters as { properties?: Record<string, unknown> };
  return Object.keys(schema.properties ?? {});
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
