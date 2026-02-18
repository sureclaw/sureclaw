import { Type } from '@sinclair/typebox';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import type { IPCClient } from './ipc-client.js';

function text(t: string) {
  return { content: [{ type: 'text' as const, text: t }], details: undefined };
}

/** Create tools that route through IPC to the host process. */
export function createIPCTools(client: IPCClient): AgentTool[] {
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
      description: 'Store a memory entry with scope, content, and optional tags.',
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

    // ── Identity tool ──
    {
      name: 'identity_write',
      label: 'Write Identity',
      description: 'Write or update an identity file (SOUL.md, IDENTITY.md, or USER.md). ' +
        'Use when you want to evolve your personality, update your self-description, or ' +
        'record user preferences. Auto-applied in clean sessions; queued for review when ' +
        'external content is present. All changes are audited.',
      parameters: Type.Object({
        file: Type.Union([Type.Literal('SOUL.md'), Type.Literal('IDENTITY.md'), Type.Literal('USER.md')]),
        content: Type.String(),
        reason: Type.String(),
      }),
      async execute(_id, params) {
        return ipcCall('identity_write', params);
      },
    },
  ];
}
