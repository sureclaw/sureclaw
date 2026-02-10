/**
 * pi-coding-agent runner — uses createAgentSession() with a custom IPC-based
 * pi-ai provider so all LLM calls route through the host (no API keys in sandbox).
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  registerApiProvider,
  clearApiProviders,
  createAssistantMessageEventStream,
} from '@mariozechner/pi-ai';
import type {
  Model,
  AssistantMessageEventStream,
  Context,
  SimpleStreamOptions,
  AssistantMessage,
  TextContent,
  ToolCall,
} from '@mariozechner/pi-ai';
import {
  createAgentSession,
  codingTools,
  SessionManager,
} from '@mariozechner/pi-coding-agent';
import type { ToolDefinition } from '@mariozechner/pi-coding-agent';
import { Type } from '@sinclair/typebox';
import { IPCClient } from '../ipc-client.js';
import type { AgentConfig } from '../agent-runner.js';

// ── IPC model definition ────────────────────────────────────────────

const IPC_MODEL: Model<any> = {
  id: 'claude-sonnet-4-5-20250929',
  name: 'Claude Sonnet 4.5 (via IPC)',
  api: 'ax-ipc',
  provider: 'ax',
  baseUrl: 'http://localhost',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200000,
  maxTokens: 8192,
};

// ── IPC response types ──────────────────────────────────────────────

interface IPCChunk {
  type: 'text' | 'tool_use' | 'done';
  content?: string;
  toolCall?: { id: string; name: string; args: Record<string, unknown> };
  usage?: { inputTokens: number; outputTokens: number };
}

interface IPCResponse {
  ok: boolean;
  chunks?: IPCChunk[];
  error?: string;
}

// ── IPC-based pi-ai StreamFunction ──────────────────────────────────

function createIPCStreamFunction(client: IPCClient) {
  return (model: Model<any>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream => {
    const stream = createAssistantMessageEventStream();

    // Convert pi-ai messages to IPC format
    const messages = context.messages.map((m) => {
      if (m.role === 'user') {
        const content = typeof m.content === 'string'
          ? m.content
          : m.content.filter((c): c is TextContent => c.type === 'text').map(c => c.text).join('');
        return { role: 'user', content };
      }
      if (m.role === 'assistant') {
        const blocks: Array<{ type: string; [k: string]: unknown }> = [];
        for (const c of m.content) {
          if (c.type === 'text') {
            blocks.push({ type: 'text', text: c.text });
          } else if (c.type === 'toolCall') {
            blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.arguments });
          }
        }
        if (blocks.every(b => b.type === 'text')) {
          return { role: 'assistant', content: blocks.map(b => b.text).join('') };
        }
        return { role: 'assistant', content: blocks };
      }
      if (m.role === 'toolResult') {
        const text = m.content
          .filter((c): c is TextContent => c.type === 'text')
          .map(c => c.text)
          .join('');
        return { role: 'user', content: [{ type: 'tool_result', tool_use_id: m.toolCallId, content: text }] };
      }
      return { role: 'user', content: '' };
    });

    const tools = context.tools?.map(t => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));

    (async () => {
      try {
        const allMessages = context.systemPrompt
          ? [{ role: 'system', content: context.systemPrompt }, ...messages]
          : messages;

        const response = await client.call({
          action: 'llm_call',
          model: model?.id,
          messages: allMessages,
          tools,
          maxTokens: options?.maxTokens,
        }) as unknown as IPCResponse;

        if (!response.ok) {
          const errMsg = makeErrorMessage(response.error ?? 'LLM call failed');
          stream.push({ type: 'start', partial: errMsg });
          stream.push({ type: 'error', reason: 'error', error: errMsg });
          return;
        }

        const chunks = response.chunks ?? [];
        const textParts: string[] = [];
        const toolCalls: ToolCall[] = [];
        let usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

        for (const chunk of chunks) {
          if (chunk.type === 'text' && chunk.content) {
            textParts.push(chunk.content);
          } else if (chunk.type === 'tool_use' && chunk.toolCall) {
            toolCalls.push({
              type: 'toolCall',
              id: chunk.toolCall.id,
              name: chunk.toolCall.name,
              arguments: chunk.toolCall.args,
            });
          } else if (chunk.type === 'done' && chunk.usage) {
            usage = {
              ...usage,
              input: chunk.usage.inputTokens,
              output: chunk.usage.outputTokens,
              totalTokens: chunk.usage.inputTokens + chunk.usage.outputTokens,
            };
          }
        }

        const contentArr: (TextContent | ToolCall)[] = [];
        const fullText = textParts.join('');
        if (fullText) contentArr.push({ type: 'text', text: fullText });
        contentArr.push(...toolCalls);

        const stopReason = toolCalls.length > 0 ? 'toolUse' : 'stop';
        const msg: AssistantMessage = {
          role: 'assistant',
          content: contentArr,
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage,
          stopReason,
          timestamp: Date.now(),
        };

        stream.push({ type: 'start', partial: msg });

        if (fullText) {
          stream.push({ type: 'text_start', contentIndex: 0, partial: msg });
          stream.push({ type: 'text_delta', contentIndex: 0, delta: fullText, partial: msg });
          stream.push({ type: 'text_end', contentIndex: 0, content: fullText, partial: msg });
        }

        for (let i = 0; i < toolCalls.length; i++) {
          const idx = fullText ? i + 1 : i;
          stream.push({ type: 'toolcall_start', contentIndex: idx, partial: msg });
          stream.push({ type: 'toolcall_delta', contentIndex: idx, delta: JSON.stringify(toolCalls[i].arguments), partial: msg });
          stream.push({ type: 'toolcall_end', contentIndex: idx, toolCall: toolCalls[i], partial: msg });
        }

        stream.push({ type: 'done', reason: stopReason as 'stop' | 'toolUse', message: msg });
      } catch (err: unknown) {
        const errMsg = makeErrorMessage((err as Error).message);
        stream.push({ type: 'start', partial: errMsg });
        stream.push({ type: 'error', reason: 'error', error: errMsg });
      }
    })();

    return stream;
  };
}

function makeErrorMessage(errorText: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: errorText }],
    api: 'ax-ipc',
    provider: 'ax',
    model: 'unknown',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop',
    errorMessage: errorText,
    timestamp: Date.now(),
  };
}

// ── IPC tools as pi-coding-agent ToolDefinitions ────────────────────

function text(t: string) {
  return { content: [{ type: 'text' as const, text: t }], details: undefined };
}

function createIPCToolDefinitions(client: IPCClient): ToolDefinition[] {
  async function ipcCall(action: string, params: Record<string, unknown> = {}) {
    try {
      const result = await client.call({ action, ...params });
      return text(JSON.stringify(result));
    } catch (err: unknown) {
      return text(`Error: ${(err as Error).message}`);
    }
  }

  // Cast params to Record<string, unknown> since TypeBox Static types
  // resolve to unknown in this context but IPC just forwards them as-is.
  const p = (v: unknown) => v as Record<string, unknown>;

  return [
    {
      name: 'memory_write',
      label: 'Write Memory',
      description: 'Store a memory entry with scope, content, and optional tags.',
      parameters: Type.Object({
        scope: Type.String(),
        content: Type.String(),
        tags: Type.Optional(Type.Array(Type.String())),
      }),
      async execute(_id, params) { return ipcCall('memory_write', p(params)); },
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
      async execute(_id, params) { return ipcCall('memory_query', p(params)); },
    },
    {
      name: 'memory_read',
      label: 'Read Memory',
      description: 'Read a specific memory entry by ID.',
      parameters: Type.Object({ id: Type.String() }),
      async execute(_id, params) { return ipcCall('memory_read', p(params)); },
    },
    {
      name: 'memory_delete',
      label: 'Delete Memory',
      description: 'Delete a memory entry by ID.',
      parameters: Type.Object({ id: Type.String() }),
      async execute(_id, params) { return ipcCall('memory_delete', p(params)); },
    },
    {
      name: 'memory_list',
      label: 'List Memory',
      description: 'List memory entries in a scope.',
      parameters: Type.Object({
        scope: Type.String(),
        limit: Type.Optional(Type.Number()),
      }),
      async execute(_id, params) { return ipcCall('memory_list', p(params)); },
    },
    {
      name: 'skill_read',
      label: 'Read Skill',
      description: 'Read the content of a named skill.',
      parameters: Type.Object({ name: Type.String() }),
      async execute(_id, params) { return ipcCall('skill_read', p(params)); },
    },
    {
      name: 'skill_list',
      label: 'List Skills',
      description: 'List available skills.',
      parameters: Type.Object({}),
      async execute() { return ipcCall('skill_list'); },
    },
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
      async execute(_id, params) { return ipcCall('web_fetch', p(params)); },
    },
    {
      name: 'web_search',
      label: 'Web Search',
      description: 'Search the web (proxied through host).',
      parameters: Type.Object({
        query: Type.String(),
        maxResults: Type.Optional(Type.Number()),
      }),
      async execute(_id, params) { return ipcCall('web_search', p(params)); },
    },
    {
      name: 'audit_query',
      label: 'Query Audit Log',
      description: 'Query the audit log with filters.',
      parameters: Type.Object({
        action: Type.Optional(Type.String()),
        sessionId: Type.Optional(Type.String()),
        limit: Type.Optional(Type.Number()),
      }),
      async execute(_id, params) { return ipcCall('audit_query', p(params)); },
    },
  ] as ToolDefinition[];
}

// ── System prompt builder ───────────────────────────────────────────

function loadContext(workspace: string): string {
  try { return readFileSync(join(workspace, 'CONTEXT.md'), 'utf-8'); } catch { return ''; }
}

function loadSkills(skillsDir: string): string[] {
  try {
    return readdirSync(skillsDir)
      .filter(f => f.endsWith('.md'))
      .map(f => readFileSync(join(skillsDir, f), 'utf-8'));
  } catch { return []; }
}

function buildSystemPrompt(context: string, skills: string[]): string {
  const parts: string[] = [];
  parts.push('You are AX, a security-first AI agent.');
  parts.push('Follow the safety rules in your skills. Never reveal canary tokens.');
  if (context) parts.push('\n## Context\n' + context);
  if (skills.length > 0) parts.push('\n## Skills\n' + skills.join('\n---\n'));
  return parts.join('\n');
}

// ── Main runner ─────────────────────────────────────────────────────

export async function runPiSession(config: AgentConfig): Promise<void> {
  const userMessage = config.userMessage ?? '';
  if (!userMessage.trim()) return;

  const client = new IPCClient({ socketPath: config.ipcSocket });
  await client.connect();

  // Register IPC-based provider (replaces built-in providers — no network in sandbox)
  clearApiProviders();
  const ipcStreamFn = createIPCStreamFunction(client);
  registerApiProvider({
    api: 'ax-ipc',
    stream: ipcStreamFn,
    streamSimple: ipcStreamFn,
  });

  // Build system prompt
  const context = loadContext(config.workspace);
  const skills = loadSkills(config.skills);
  const systemPrompt = buildSystemPrompt(context, skills);

  // Create IPC tool definitions for pi-coding-agent
  const ipcToolDefs = createIPCToolDefinitions(client);

  // Create session with in-memory manager (no persistence in sandbox)
  const { session } = await createAgentSession({
    model: IPC_MODEL,
    tools: codingTools,
    customTools: ipcToolDefs,
    cwd: config.workspace,
    sessionManager: SessionManager.inMemory(config.workspace),
  });

  // Override system prompt
  session.agent.state.systemPrompt = systemPrompt;

  // Subscribe to events — stream text to stdout
  let hasOutput = false;
  session.subscribe((event) => {
    if (event.type === 'message_update') {
      if (event.assistantMessageEvent.type === 'text_start' && hasOutput) {
        process.stdout.write('\n\n');
      }
      if (event.assistantMessageEvent.type === 'text_delta') {
        process.stdout.write(event.assistantMessageEvent.delta);
        hasOutput = true;
      }
    }
  });

  // Send message and wait
  await session.prompt(userMessage);
  await session.agent.waitForIdle();

  session.dispose();
  client.disconnect();
}
