/**
 * pi-coding-agent runner — uses createAgentSession() with a custom LLM
 * provider. When a proxy socket is available, LLM calls go directly through
 * the Anthropic SDK via the credential-injecting proxy (no IPC overhead).
 * Falls back to IPC-based LLM transport when no proxy socket is configured.
 * Non-LLM tools (memory, web, audit) always use IPC.
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
  createCodingTools,
  SessionManager,
  AuthStorage,
} from '@mariozechner/pi-coding-agent';
import type { ToolDefinition } from '@mariozechner/pi-coding-agent';
import { Type } from '@sinclair/typebox';
// Anthropic SDK is imported dynamically in createProxyStreamFunction() to avoid
// loading it when the proxy is not used (IPC fallback mode).
import type Anthropic from '@anthropic-ai/sdk';
import type { MessageParam, Tool as AnthropicTool } from '@anthropic-ai/sdk/resources/messages';
import { IPCClient } from '../ipc-client.js';
import { compactHistory, historyToPiMessages } from '../runner.js';
import type { AgentConfig } from '../runner.js';
import { debug, truncate } from '../../logger.js';

const SRC = 'container:pi-session';

// LLM calls can take minutes for complex prompts. The default IPC timeout
// (30s) is far too short. Configurable via AX_LLM_TIMEOUT_MS, defaults to 10 minutes.
const LLM_CALL_TIMEOUT_MS = parseInt(process.env.AX_LLM_TIMEOUT_MS ?? '', 10) || 10 * 60 * 1000;

// ── IPC model definition ────────────────────────────────────────────

function createIPCModel(maxTokens?: number): Model<any> {
  return {
    id: 'claude-sonnet-4-5-20250929',
    name: 'Claude Sonnet 4.5 (via IPC)',
    api: 'ax-ipc',
    provider: 'ax',
    baseUrl: 'http://localhost',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: maxTokens ?? 8192,
  };
}

function createProxyModel(maxTokens?: number): Model<any> {
  return {
    id: 'claude-sonnet-4-5-20250929',
    name: 'Claude Sonnet 4.5 (via proxy)',
    api: 'ax-proxy',
    provider: 'ax',
    baseUrl: 'http://localhost',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: maxTokens ?? 8192,
  };
}

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

    const msgCount = context.messages.length;
    const toolCount = context.tools?.length ?? 0;
    debug(SRC, 'stream_start', {
      model: model?.id,
      messageCount: msgCount,
      toolCount,
      hasSystemPrompt: !!context.systemPrompt,
    });

    // Convert pi-ai messages to IPC format.
    // Anthropic API rejects messages with empty content, so every message
    // must produce a non-empty string or a non-empty structured blocks array.
    const messages = context.messages.map((m) => {
      if (m.role === 'user') {
        const content = typeof m.content === 'string'
          ? m.content
          : m.content.filter((c): c is TextContent => c.type === 'text').map(c => c.text).join('');
        return { role: 'user', content: content || '.' };
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
        if (blocks.length === 0) {
          return { role: 'assistant', content: '.' };
        }
        if (blocks.every(b => b.type === 'text')) {
          const text = blocks.map(b => b.text).join('');
          return { role: 'assistant', content: text || '.' };
        }
        return { role: 'assistant', content: blocks };
      }
      if (m.role === 'toolResult') {
        const text = m.content
          .filter((c): c is TextContent => c.type === 'text')
          .map(c => c.text)
          .join('');
        return { role: 'user', content: [{ type: 'tool_result', tool_use_id: m.toolCallId, content: text || '[no output]' }] };
      }
      return { role: 'user', content: '.' };
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

        const maxTokens = options?.maxTokens ?? model?.maxTokens;
        debug(SRC, 'ipc_call', { messageCount: allMessages.length, toolCount: tools?.length ?? 0, maxTokens });
        const response = await client.call({
          action: 'llm_call',
          model: model?.id,
          messages: allMessages,
          tools,
          maxTokens,
        }, LLM_CALL_TIMEOUT_MS) as unknown as IPCResponse;

        if (!response.ok) {
          debug(SRC, 'ipc_error', { error: response.error });
          const errMsg = makeErrorMessage(response.error ?? 'LLM call failed');
          stream.push({ type: 'start', partial: errMsg });
          stream.push({ type: 'error', reason: 'error', error: errMsg });
          return;
        }

        const chunks = response.chunks ?? [];
        debug(SRC, 'ipc_response', { chunkCount: chunks.length, chunkTypes: chunks.map(c => c.type) });
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

        debug(SRC, 'stream_done', {
          stopReason,
          textLength: fullText.length,
          toolCallCount: toolCalls.length,
          toolNames: toolCalls.map(t => t.name),
          usage,
        });
        stream.push({ type: 'done', reason: stopReason as 'stop' | 'toolUse', message: msg });
      } catch (err: unknown) {
        debug(SRC, 'stream_error', { error: (err as Error).message, stack: (err as Error).stack });
        const errMsg = makeErrorMessage((err as Error).message);
        stream.push({ type: 'start', partial: errMsg });
        stream.push({ type: 'error', reason: 'error', error: errMsg });
      }
    })();

    return stream;
  };
}

function makeErrorMessage(errorText: string, api = 'ax-ipc'): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: errorText }],
    api,
    provider: 'ax',
    model: 'unknown',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop',
    errorMessage: errorText,
    timestamp: Date.now(),
  };
}

// ── Proxy-based pi-ai StreamFunction (Anthropic SDK via Unix socket) ─

async function createSocketFetch(socketPath: string): Promise<typeof globalThis.fetch> {
  const { Agent } = await import('undici');
  const dispatcher = new Agent({ connect: { socketPath } });
  return ((input: string | URL | Request, init?: RequestInit) =>
    fetch(input, { ...init, dispatcher } as RequestInit)) as typeof globalThis.fetch;
}

function createProxyStreamFunction(proxySocket: string) {
  // Eagerly create the Anthropic client so all calls reuse it.
  // The socketFetch promise is cached and resolved on first use.
  let anthropicPromise: Promise<Anthropic> | null = null;

  function getClient(): Promise<Anthropic> {
    if (!anthropicPromise) {
      anthropicPromise = (async () => {
        const [socketFetch, { default: AnthropicSDK }] = await Promise.all([
          createSocketFetch(proxySocket),
          import('@anthropic-ai/sdk'),
        ]);
        return new AnthropicSDK({
          apiKey: 'ax-proxy',  // Proxy doesn't validate keys — it injects real credentials
          baseURL: 'http://localhost',  // SDK adds /v1/messages — don't include /v1
          fetch: socketFetch,
        });
      })();
    }
    return anthropicPromise;
  }

  return (model: Model<any>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream => {
    const stream = createAssistantMessageEventStream();

    const msgCount = context.messages.length;
    const toolCount = context.tools?.length ?? 0;
    debug(SRC, 'proxy_stream_start', {
      model: model?.id,
      messageCount: msgCount,
      toolCount,
      hasSystemPrompt: !!context.systemPrompt,
    });

    // Convert pi-ai messages to Anthropic SDK MessageParam[] format.
    // The Anthropic API rejects messages with empty content.
    const messages: MessageParam[] = context.messages.map((m) => {
      if (m.role === 'user') {
        const content = typeof m.content === 'string'
          ? m.content
          : m.content.filter((c): c is TextContent => c.type === 'text').map(c => c.text).join('');
        return { role: 'user' as const, content: content || '.' };
      }
      if (m.role === 'assistant') {
        const blocks: Anthropic.Messages.ContentBlockParam[] = [];
        for (const c of m.content) {
          if (c.type === 'text') {
            blocks.push({ type: 'text', text: c.text });
          } else if (c.type === 'toolCall') {
            blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.arguments });
          }
        }
        if (blocks.length === 0) {
          return { role: 'assistant' as const, content: '.' };
        }
        if (blocks.length > 0 && blocks.every(b => b.type === 'text')) {
          const text = blocks.map(b => (b as Anthropic.Messages.TextBlockParam).text).join('');
          return { role: 'assistant' as const, content: text || '.' };
        }
        return { role: 'assistant' as const, content: blocks };
      }
      if (m.role === 'toolResult') {
        const text = m.content
          .filter((c): c is TextContent => c.type === 'text')
          .map(c => c.text)
          .join('');
        return {
          role: 'user' as const,
          content: [{
            type: 'tool_result' as const,
            tool_use_id: m.toolCallId,
            content: text || '[no output]',
          }],
        };
      }
      return { role: 'user' as const, content: '.' };
    });

    // Convert pi-ai tools to Anthropic SDK Tool[] format.
    const tools: AnthropicTool[] | undefined = context.tools?.map(t => ({
      name: t.name,
      description: t.description ?? '',
      input_schema: (t.parameters ?? { type: 'object', properties: {} }) as AnthropicTool['input_schema'],
    }));

    const maxTokens = options?.maxTokens ?? model?.maxTokens ?? 8192;

    (async () => {
      try {
        const anthropic = await getClient();

        debug(SRC, 'proxy_call', { messageCount: messages.length, toolCount: tools?.length ?? 0, maxTokens });

        // Use .stream() for SSE streaming, then extract from finalMessage.
        // Event listeners (.on('contentBlockDelta')) are unreliable because the
        // SDK may process chunks before we can attach them. Instead we use
        // finalMessage() which accumulates everything server-side.
        const sdkStream = anthropic.messages.stream({
          model: model?.id ?? 'claude-sonnet-4-5-20250929',
          max_tokens: maxTokens,
          system: context.systemPrompt || undefined,
          messages,
          tools: tools && tools.length > 0 ? tools : undefined,
        });

        // Wait for the full message
        const finalMessage = await sdkStream.finalMessage();

        // Build the pi-ai AssistantMessage from the final response.
        // Extract text and tool_use blocks from finalMessage.content.
        const contentArr: (TextContent | ToolCall)[] = [];
        const toolCalls: ToolCall[] = [];
        const textParts: string[] = [];

        for (const block of finalMessage.content) {
          if (block.type === 'text') {
            textParts.push(block.text);
          } else if (block.type === 'tool_use') {
            toolCalls.push({
              type: 'toolCall',
              id: block.id,
              name: block.name,
              arguments: block.input as Record<string, unknown>,
            });
          }
        }

        const fullText = textParts.join('');
        if (fullText) contentArr.push({ type: 'text', text: fullText });
        contentArr.push(...toolCalls);

        const stopReason = finalMessage.stop_reason === 'tool_use' ? 'toolUse' : 'stop';
        const usage = {
          input: finalMessage.usage?.input_tokens ?? 0,
          output: finalMessage.usage?.output_tokens ?? 0,
          cacheRead: (finalMessage.usage as Record<string, number>)?.cache_read_input_tokens ?? 0,
          cacheWrite: (finalMessage.usage as Record<string, number>)?.cache_creation_input_tokens ?? 0,
          totalTokens: (finalMessage.usage?.input_tokens ?? 0) + (finalMessage.usage?.output_tokens ?? 0),
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        };

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

        // Emit pi-ai events
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

        debug(SRC, 'proxy_stream_done', {
          stopReason,
          textLength: fullText.length,
          toolCallCount: toolCalls.length,
          toolNames: toolCalls.map(t => t.name),
          usage,
        });
        stream.push({ type: 'done', reason: stopReason as 'stop' | 'toolUse', message: msg });
      } catch (err: unknown) {
        debug(SRC, 'proxy_stream_error', { error: (err as Error).message, stack: (err as Error).stack });
        const errMsg = makeErrorMessage((err as Error).message, 'ax-proxy');
        stream.push({ type: 'start', partial: errMsg });
        stream.push({ type: 'error', reason: 'error', error: errMsg });
      }
    })();

    return stream;
  };
}

// ── IPC tools as pi-coding-agent ToolDefinitions ────────────────────

function text(t: string) {
  return { content: [{ type: 'text' as const, text: t }], details: undefined };
}

function createIPCToolDefinitions(client: IPCClient): ToolDefinition[] {
  async function ipcCall(action: string, params: Record<string, unknown> = {}) {
    try {
      debug(SRC, 'tool_ipc_call', { action });
      const result = await client.call({ action, ...params });
      return text(JSON.stringify(result));
    } catch (err: unknown) {
      debug(SRC, 'tool_ipc_error', { action, error: (err as Error).message });
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

// Import shared buildSystemPrompt from runner (supports identity files + bootstrap mode)
import { buildSystemPrompt } from '../runner.js';

// ── Main runner ─────────────────────────────────────────────────────

export async function runPiSession(config: AgentConfig): Promise<void> {
  const userMessage = config.userMessage ?? '';
  if (!userMessage.trim()) {
    debug(SRC, 'skip_empty');
    return;
  }

  // Decide LLM transport: proxy (direct Anthropic SDK) or IPC fallback
  const useProxy = !!config.proxySocket;
  const activeModel = useProxy ? createProxyModel(config.maxTokens) : createIPCModel(config.maxTokens);
  const apiName = useProxy ? 'ax-proxy' : 'ax-ipc';

  debug(SRC, 'session_start', {
    workspace: config.workspace,
    messageLength: userMessage.length,
    messagePreview: truncate(userMessage, 200),
    maxTokens: activeModel.maxTokens,
    llmTransport: useProxy ? 'proxy' : 'ipc',
    proxySocket: config.proxySocket,
  });

  if (!useProxy) {
    debug(SRC, 'proxy_unavailable', { reason: 'config.proxySocket not set, falling back to IPC for LLM calls' });
  }

  const client = new IPCClient({ socketPath: config.ipcSocket });
  await client.connect();

  // Register LLM provider (replaces built-in providers — no network in sandbox)
  clearApiProviders();
  if (useProxy) {
    const proxyStreamFn = createProxyStreamFunction(config.proxySocket!);
    registerApiProvider({
      api: 'ax-proxy',
      stream: proxyStreamFn,
      streamSimple: proxyStreamFn,
    });
  } else {
    const ipcStreamFn = createIPCStreamFunction(client);
    registerApiProvider({
      api: 'ax-ipc',
      stream: ipcStreamFn,
      streamSimple: ipcStreamFn,
    });
  }
  debug(SRC, 'provider_registered', { api: apiName });

  // Build system prompt
  const context = loadContext(config.workspace);
  const skills = loadSkills(config.skills);
  const systemPrompt = buildSystemPrompt(context, skills, config.agentDir);

  // Create coding tools bound to the workspace directory.
  // IMPORTANT: codingTools (the pre-instantiated export) captures process.cwd()
  // at import time via closures — those tools would write to the wrong directory.
  // createCodingTools(cwd) creates fresh tools bound to the workspace.
  const tools = createCodingTools(config.workspace);

  // Create IPC tool definitions for pi-coding-agent
  const ipcToolDefs = createIPCToolDefinitions(client);

  debug(SRC, 'session_config', {
    systemPromptLength: systemPrompt.length,
    codingToolCount: tools.length,
    ipcToolCount: ipcToolDefs.length,
    codingToolNames: tools.map(t => t.name),
    ipcToolNames: ipcToolDefs.map(t => t.name),
  });

  // Create auth storage with a dummy key for the 'ax' IPC provider.
  // Without this, both AgentSession.prompt() and the Agent loop throw
  // "No API key found for ax" because the model registry doesn't know
  // about our IPC provider. The host handles real auth — no keys in sandbox.
  const authStorage = new AuthStorage(join(config.workspace, 'auth.json'));
  authStorage.setRuntimeApiKey(activeModel.provider, apiName);

  // Create session with in-memory manager (no persistence in sandbox)
  debug(SRC, 'creating_agent_session');
  const { session } = await createAgentSession({
    model: activeModel,
    tools,
    customTools: ipcToolDefs,
    cwd: config.workspace,
    authStorage,
    sessionManager: SessionManager.inMemory(config.workspace),
  });
  debug(SRC, 'agent_session_created');

  // Override system prompt
  session.agent.state.systemPrompt = systemPrompt;

  // Prepopulate conversation history from prior turns (server sends this via stdin).
  // Without this, each request starts a fresh conversation and the agent can't
  // remember anything from earlier exchanges.
  if (config.history && config.history.length > 0) {
    debug(SRC, 'history_load', { turns: config.history.length });
    const compacted = await compactHistory(config.history, client);
    const historyMessages = historyToPiMessages(compacted);
    session.agent.state.messages = historyMessages;
    debug(SRC, 'history_loaded', {
      originalTurns: config.history.length,
      compactedTurns: compacted.length,
      piMessages: historyMessages.length,
    });
  }

  // Subscribe to events — stream text to stdout, log ALL events for debugging
  let hasOutput = false;
  let eventCount = 0;
  let turnCount = 0;
  session.subscribe((event) => {
    eventCount++;
    if (event.type === 'message_update') {
      const ame = event.assistantMessageEvent;
      debug(SRC, 'agent_event', { type: ame.type, eventCount });

      if (ame.type === 'text_start' && hasOutput) {
        process.stdout.write('\n\n');
      }
      if (ame.type === 'text_delta') {
        process.stdout.write(ame.delta);
        hasOutput = true;
      }
      if (ame.type === 'toolcall_end') {
        debug(SRC, 'tool_call_event', { toolName: ame.toolCall.name, toolId: ame.toolCall.id });
        if (config.verbose) {
          process.stderr.write(`[tool] ${ame.toolCall.name}\n`);
        }
      }
      if (ame.type === 'error') {
        const errText = ame.error?.errorMessage ?? String(ame.error);
        debug(SRC, 'agent_error_event', { error: errText });
        process.stderr.write(`Agent error: ${errText}\n`);
      }
      if (ame.type === 'done') {
        turnCount++;
        debug(SRC, 'agent_done_event', { reason: ame.reason });
        if (config.verbose) {
          process.stderr.write(`[turn ${turnCount}] ${ame.reason}\n`);
        }
      }
    }
  });

  // Send message and wait
  debug(SRC, 'prompt_start', { messagePreview: truncate(userMessage, 200) });
  await session.prompt(userMessage);
  await session.agent.waitForIdle();

  debug(SRC, 'session_complete', { eventCount, hasOutput });
  session.dispose();
  client.disconnect();
}
