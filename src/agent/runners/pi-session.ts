/**
 * pi-coding-agent runner — uses createAgentSession() with a custom LLM
 * provider. When a proxy socket is available, LLM calls go directly through
 * the Anthropic SDK via the credential-injecting proxy (no IPC overhead).
 * Falls back to IPC-based LLM transport when no proxy socket is configured.
 * Non-LLM tools (memory, web, audit) always use IPC.
 */

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
import type { MessageParam, Tool as AnthropicTool } from '@anthropic-ai/sdk/resources/messages';
import { IPCClient } from '../ipc-client.js';
import { compactHistory, historyToPiMessages } from '../runner.js';
import type { AgentConfig } from '../runner.js';
import { convertPiMessages, emitStreamEvents, createLazyAnthropicClient, loadContext, loadSkills } from '../stream-utils.js';
import { getLogger, truncate } from '../../logger.js';

const logger = getLogger().child({ component: 'pi-session' });

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
    logger.debug('stream_start', {
      model: model?.id,
      messageCount: msgCount,
      toolCount,
      hasSystemPrompt: !!context.systemPrompt,
    });

    const messages = convertPiMessages(context.messages);

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
        logger.debug('ipc_call', { messageCount: allMessages.length, toolCount: tools?.length ?? 0, maxTokens });
        const response = await client.call({
          action: 'llm_call',
          model: model?.id,
          messages: allMessages,
          tools,
          maxTokens,
        }, LLM_CALL_TIMEOUT_MS) as unknown as IPCResponse;

        if (!response.ok) {
          logger.debug('ipc_error', { error: response.error });
          const errMsg = makeErrorMessage(response.error ?? 'LLM call failed');
          stream.push({ type: 'start', partial: errMsg });
          stream.push({ type: 'error', reason: 'error', error: errMsg });
          return;
        }

        const chunks = response.chunks ?? [];
        logger.debug('ipc_response', { chunkCount: chunks.length, chunkTypes: chunks.map(c => c.type) });
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

        logger.debug('stream_done', {
          stopReason,
          textLength: fullText.length,
          toolCallCount: toolCalls.length,
          toolNames: toolCalls.map(t => t.name),
          usage,
        });
        emitStreamEvents(stream, msg, fullText, toolCalls, stopReason as 'stop' | 'toolUse');
      } catch (err: unknown) {
        logger.debug('stream_error', { error: (err as Error).message, stack: (err as Error).stack });
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

function createProxyStreamFunction(proxySocket: string) {
  const getClient = createLazyAnthropicClient(proxySocket);

  return (model: Model<any>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream => {
    const stream = createAssistantMessageEventStream();

    const msgCount = context.messages.length;
    const toolCount = context.tools?.length ?? 0;
    logger.debug('proxy_stream_start', {
      model: model?.id,
      messageCount: msgCount,
      toolCount,
      hasSystemPrompt: !!context.systemPrompt,
    });

    const messages = convertPiMessages(context.messages) as MessageParam[];

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

        logger.debug('proxy_call', { messageCount: messages.length, toolCount: tools?.length ?? 0, maxTokens });

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

        logger.debug('proxy_stream_done', {
          stopReason,
          textLength: fullText.length,
          toolCallCount: toolCalls.length,
          toolNames: toolCalls.map(t => t.name),
          usage,
        });
        emitStreamEvents(stream, msg, fullText, toolCalls, stopReason as 'stop' | 'toolUse');
      } catch (err: unknown) {
        logger.debug('proxy_stream_error', { error: (err as Error).message, stack: (err as Error).stack });
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
      logger.debug('tool_ipc_call', { action });
      const result = await client.call({ action, ...params });
      return text(JSON.stringify(result));
    } catch (err: unknown) {
      logger.debug('tool_ipc_error', { action, error: (err as Error).message });
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

// Import shared buildSystemPrompt from runner (supports identity files + bootstrap mode)
import { buildSystemPrompt } from '../runner.js';

// ── Main runner ─────────────────────────────────────────────────────

export async function runPiSession(config: AgentConfig): Promise<void> {
  const userMessage = config.userMessage ?? '';
  if (!userMessage.trim()) {
    logger.debug('skip_empty');
    return;
  }

  // Decide LLM transport: proxy (direct Anthropic SDK) or IPC fallback
  const useProxy = !!config.proxySocket;
  const activeModel = useProxy ? createProxyModel(config.maxTokens) : createIPCModel(config.maxTokens);
  const apiName = useProxy ? 'ax-proxy' : 'ax-ipc';

  logger.debug('session_start', {
    workspace: config.workspace,
    messageLength: userMessage.length,
    messagePreview: truncate(userMessage, 200),
    maxTokens: activeModel.maxTokens,
    llmTransport: useProxy ? 'proxy' : 'ipc',
    proxySocket: config.proxySocket,
  });

  if (!useProxy) {
    logger.debug('proxy_unavailable', { reason: 'config.proxySocket not set, falling back to IPC for LLM calls' });
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
  logger.debug('provider_registered', { api: apiName });

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

  logger.debug('session_config', {
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
  logger.debug('creating_agent_session');
  const { session } = await createAgentSession({
    model: activeModel,
    tools,
    customTools: ipcToolDefs,
    cwd: config.workspace,
    authStorage,
    sessionManager: SessionManager.inMemory(config.workspace),
  });
  logger.debug('agent_session_created');

  // Override system prompt
  session.agent.state.systemPrompt = systemPrompt;

  // Prepopulate conversation history from prior turns (server sends this via stdin).
  // Without this, each request starts a fresh conversation and the agent can't
  // remember anything from earlier exchanges.
  if (config.history && config.history.length > 0) {
    logger.debug('history_load', { turns: config.history.length });
    const compacted = await compactHistory(config.history, client);
    const historyMessages = historyToPiMessages(compacted);
    session.agent.state.messages = historyMessages;
    logger.debug('history_loaded', {
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
      logger.debug('agent_event', { type: ame.type, eventCount });

      if (ame.type === 'text_start' && hasOutput) {
        process.stdout.write('\n\n');
      }
      if (ame.type === 'text_delta') {
        process.stdout.write(ame.delta);
        hasOutput = true;
      }
      if (ame.type === 'toolcall_end') {
        logger.debug('tool_call_event', { toolName: ame.toolCall.name, toolId: ame.toolCall.id });
        if (config.verbose) {
          process.stderr.write(`[tool] ${ame.toolCall.name}\n`);
        }
      }
      if (ame.type === 'error') {
        const errText = ame.error?.errorMessage ?? String(ame.error);
        logger.debug('agent_error_event', { error: errText });
        process.stderr.write(`Agent error: ${errText}\n`);
      }
      if (ame.type === 'done') {
        turnCount++;
        logger.debug('agent_done_event', { reason: ame.reason });
        if (config.verbose) {
          process.stderr.write(`[turn ${turnCount}] ${ame.reason}\n`);
        }
      }
    }
  });

  // Send message and wait
  logger.debug('prompt_start', { messagePreview: truncate(userMessage, 200) });
  await session.prompt(userMessage);
  await session.agent.waitForIdle();

  logger.debug('session_complete', { eventCount, hasOutput });
  session.dispose();
  client.disconnect();
}
