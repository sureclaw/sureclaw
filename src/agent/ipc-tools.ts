import { Type } from '@sinclair/typebox';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import type { IPCClient } from './ipc-client.js';

function text(t: string) {
  return { content: [{ type: 'text' as const, text: t }], details: undefined };
}

export interface IPCToolsOptions {
  /** Current user ID — included in user_write calls for per-user scoping. */
  userId?: string;
}

/** Create tools that route through IPC to the host process. */
export function createIPCTools(client: IPCClient, opts?: IPCToolsOptions): AgentTool[] {
  async function ipcCall(action: string, params: Record<string, unknown> = {}) {
    try {
      const result = await client.call({ action, ...params });
      return text(JSON.stringify(result));
    } catch (err: unknown) {
      return text(`Error: ${(err as Error).message}`);
    }
  }

  return [
    // ── Memory tools ──
    {
      name: 'memory_write',
      label: 'Write Memory',
      description: 'Store a factual memory entry with scope, content, and optional tags. For name, personality, or style changes use identity_write or user_write instead.',
      parameters: Type.Object({
        scope: Type.String(),
        content: Type.String(),
        tags: Type.Optional(Type.Array(Type.String())),
      }),
      async execute(_id, params) {
        return ipcCall('memory_write', params);
      },
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
      async execute(_id, params) {
        return ipcCall('memory_query', params);
      },
    },
    {
      name: 'memory_read',
      label: 'Read Memory',
      description: 'Read a specific memory entry by ID.',
      parameters: Type.Object({
        id: Type.String(),
      }),
      async execute(_id, params) {
        return ipcCall('memory_read', params);
      },
    },
    {
      name: 'memory_delete',
      label: 'Delete Memory',
      description: 'Delete a memory entry by ID.',
      parameters: Type.Object({
        id: Type.String(),
      }),
      async execute(_id, params) {
        return ipcCall('memory_delete', params);
      },
    },
    {
      name: 'memory_list',
      label: 'List Memory',
      description: 'List memory entries in a scope.',
      parameters: Type.Object({
        scope: Type.String(),
        limit: Type.Optional(Type.Number()),
      }),
      async execute(_id, params) {
        return ipcCall('memory_list', params);
      },
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
      async execute(_id, params) {
        return ipcCall('web_fetch', params);
      },
    },
    {
      name: 'web_search',
      label: 'Web Search',
      description: 'Search the web (proxied through host).',
      parameters: Type.Object({
        query: Type.String(),
        maxResults: Type.Optional(Type.Number()),
      }),
      async execute(_id, params) {
        return ipcCall('web_search', params);
      },
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
      async execute(_id, params) {
        return ipcCall('audit_query', params);
      },
    },

    // ── Identity tools ──
    {
      name: 'identity_write',
      label: 'Write Identity',
      description: 'Write or update a shared identity file (SOUL.md or IDENTITY.md). ' +
        'Use when you want to evolve your personality or update your self-description. ' +
        'For recording user preferences, use user_write instead. ' +
        'Auto-applied in clean sessions; queued for review when ' +
        'external content is present. All changes are audited.',
      parameters: Type.Object({
        file: Type.Union([Type.Literal('SOUL.md'), Type.Literal('IDENTITY.md')]),
        content: Type.String(),
        reason: Type.String(),
        origin: Type.Union([Type.Literal('user_request'), Type.Literal('agent_initiated')]),
      }),
      async execute(_id, params) {
        return ipcCall('identity_write', params);
      },
    },
    {
      name: 'user_write',
      label: 'Write User Preferences',
      description: 'Write or update what you have learned about the current user (USER.md). ' +
        'Records preferences, workflows, communication style. Per-user scoped — ' +
        'each user gets their own file. Auto-applied in clean sessions; queued when tainted. ' +
        'All changes are audited.',
      parameters: Type.Object({
        content: Type.String(),
        reason: Type.String(),
        origin: Type.Union([Type.Literal('user_request'), Type.Literal('agent_initiated')]),
      }),
      async execute(_id, params) {
        return ipcCall('user_write', { ...params, userId: opts?.userId ?? '' });
      },
    },

    // ── Scheduler tools ──
    {
      name: 'scheduler_add_cron',
      label: 'Add Cron Job',
      description: 'Schedule a recurring task using a 5-field cron expression (minute hour day month weekday). The prompt will be sent to you at each matching time.',
      parameters: Type.Object({
        schedule: Type.String({ description: 'Cron expression, e.g. "0 9 * * 1" for 9am every Monday' }),
        prompt: Type.String({ description: 'The instruction/prompt to execute on each trigger' }),
        maxTokenBudget: Type.Optional(Type.Number({ description: 'Optional max token budget per execution' })),
      }),
      async execute(_id, params) {
        return ipcCall('scheduler_add_cron', params);
      },
    },
    {
      name: 'scheduler_remove_cron',
      label: 'Remove Cron Job',
      description: 'Remove a previously scheduled cron job by its ID.',
      parameters: Type.Object({
        jobId: Type.String({ description: 'The job ID returned by scheduler_add_cron' }),
      }),
      async execute(_id, params) {
        return ipcCall('scheduler_remove_cron', params);
      },
    },
    {
      name: 'scheduler_list_jobs',
      label: 'List Cron Jobs',
      description: 'List all currently scheduled cron jobs.',
      parameters: Type.Object({}),
      async execute(_id) {
        return ipcCall('scheduler_list_jobs', {});
      },
    },
  ];
}
