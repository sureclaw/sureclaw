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
import type { IPCClient } from './ipc-client.js';

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
}

export function createIPCMcpServer(client: IPCClient, opts?: MCPServerOptions): McpSdkServerConfigWithInstance {
  async function ipcCall(action: string, params: Record<string, unknown> = {}) {
    try {
      const result = await client.call({ action, ...params });
      return textResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }

  return createSdkMcpServer({
    name: 'ax-tools',
    version: '1.0.0',
    tools: [
      // ── Memory tools ──
      tool('memory_write', 'Store a factual memory entry with scope, content, and optional tags. For name, personality, or style changes use identity_write or user_write instead.', {
        scope: z.string(),
        content: z.string(),
        tags: z.array(z.string()).optional(),
      }, (args) => ipcCall('memory_write', args)),

      tool('memory_query', 'Search memory entries by scope and optional query string.', {
        scope: z.string(),
        query: z.string().optional(),
        limit: z.number().optional(),
        tags: z.array(z.string()).optional(),
      }, (args) => ipcCall('memory_query', args)),

      tool('memory_read', 'Read a specific memory entry by ID.', {
        id: z.string(),
      }, (args) => ipcCall('memory_read', args)),

      tool('memory_delete', 'Delete a memory entry by ID.', {
        id: z.string(),
      }, (args) => ipcCall('memory_delete', args)),

      tool('memory_list', 'List memory entries in a scope.', {
        scope: z.string(),
        limit: z.number().optional(),
      }, (args) => ipcCall('memory_list', args)),

      // ── Web tools ──
      tool('web_search', 'Search the web (proxied through host).', {
        query: z.string(),
        maxResults: z.number().optional(),
      }, (args) => ipcCall('web_search', args)),

      tool('web_fetch', 'Fetch content from a URL (proxied through host with SSRF protection).', {
        url: z.string(),
        method: z.enum(['GET', 'HEAD']).optional(),
        headers: z.record(z.string(), z.string()).optional(),
        timeoutMs: z.number().optional(),
      }, (args) => ipcCall('web_fetch', args)),

      // ── Audit tool ──
      tool('audit_query', 'Query the audit log with filters.', {
        action: z.string().optional(),
        sessionId: z.string().optional(),
        limit: z.number().optional(),
      }, (args) => ipcCall('audit_query', args)),

      // ── Identity tools ──
      tool(
        'identity_write',
        'Write or update a shared identity file (SOUL.md or IDENTITY.md). ' +
        'For recording user preferences, use user_write instead. ' +
        'Auto-applied in clean sessions; queued when tainted. All changes are audited.',
        {
          file: z.enum(['SOUL.md', 'IDENTITY.md']),
          content: z.string(),
          reason: z.string(),
          origin: z.enum(['user_request', 'agent_initiated']),
        },
        (args) => ipcCall('identity_write', args),
      ),

      tool(
        'user_write',
        'Write or update what you have learned about the current user (USER.md). ' +
        'Per-user scoped. Auto-applied in clean sessions; queued when tainted. All changes are audited.',
        {
          content: z.string(),
          reason: z.string(),
          origin: z.enum(['user_request', 'agent_initiated']),
        },
        (args) => ipcCall('user_write', { ...args, userId: opts?.userId ?? '' }),
      ),

      // ── Scheduler tools ──
      tool(
        'scheduler_add_cron',
        'Schedule a recurring task using a 5-field cron expression (minute hour day month weekday). The prompt will be sent to you at each matching time.',
        {
          schedule: z.string().describe('Cron expression, e.g. "0 9 * * 1" for 9am every Monday'),
          prompt: z.string().describe('The instruction/prompt to execute on each trigger'),
          maxTokenBudget: z.number().optional().describe('Optional max token budget per execution'),
        },
        (args) => ipcCall('scheduler_add_cron', args),
      ),

      tool(
        'scheduler_run_at',
        'Schedule a one-shot task at a specific date/time. The prompt executes once and the job is automatically removed.',
        {
          datetime: z.string().describe('ISO 8601 datetime string, e.g. "2026-02-21T19:30:00"'),
          prompt: z.string().describe('The instruction/prompt to execute'),
          maxTokenBudget: z.number().optional().describe('Optional max token budget for execution'),
        },
        (args) => ipcCall('scheduler_run_at', args),
      ),

      tool(
        'scheduler_remove_cron',
        'Remove a previously scheduled cron job by its ID.',
        {
          jobId: z.string().describe('The job ID returned by scheduler_add_cron'),
        },
        (args) => ipcCall('scheduler_remove_cron', args),
      ),

      tool(
        'scheduler_list_jobs',
        'List all currently scheduled cron jobs.',
        {},
        () => ipcCall('scheduler_list_jobs', {}),
      ),

      // ── Skill tools ──
      tool('skill_list', 'List all available skills. Returns skill names and descriptions.', {},
        () => ipcCall('skill_list', {})),

      tool('skill_read', 'Read the full content of a skill by name.', {
        name: z.string(),
      }, (args) => ipcCall('skill_read', args)),

      tool('skill_propose',
        'Propose a new skill or update an existing one. Content is screened for safety. ' +
        'Auto-approved skills are available on your next turn.',
        {
          skill: z.string().describe('Skill name (alphanumeric, hyphens, underscores)'),
          content: z.string().describe('Skill content as markdown'),
          reason: z.string().optional().describe('Why this skill is needed'),
        },
        (args) => ipcCall('skill_propose', args)),
    ],
  });
}
