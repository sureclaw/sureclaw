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
import { IPCClient } from '../ipc-client.js';
import { compactHistory, historyToPiMessages } from '../runner.js';
import type { AgentConfig } from '../runner.js';
import { convertPiMessages, emitStreamEvents } from '../stream-utils.js';
import { createProxyStreamFn } from '../proxy-stream.js';
import { makeProxyErrorMessage } from '../proxy-stream.js';
import { buildSystemPrompt, subscribeAgentEvents } from '../agent-setup.js';
import { getLogger, truncate } from '../../logger.js';

const logger = getLogger().child({ component: 'pi-session' });

// LLM calls can take minutes for complex prompts. The default IPC timeout
// (30s) is far too short. Configurable via AX_LLM_TIMEOUT_MS, defaults to 10 minutes.
const LLM_CALL_TIMEOUT_MS = parseInt(process.env.AX_LLM_TIMEOUT_MS ?? '', 10) || 10 * 60 * 1000;

// ── IPC model definition ────────────────────────────────────────────

function createIPCModel(maxTokens?: number, modelId?: string): Model<any> {
  return {
    id: modelId ?? 'claude-sonnet-4-5-20250929',
    name: modelId ? `${modelId} (via IPC)` : 'Claude Sonnet 4.5 (via IPC)',
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

function createProxyModel(maxTokens?: number, modelId?: string): Model<any> {
  return {
    id: modelId ?? 'claude-sonnet-4-5-20250929',
    name: modelId ? `${modelId} (via proxy)` : 'Claude Sonnet 4.5 (via proxy)',
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
        logger.debug('ipc_llm_call', { messageCount: allMessages.length, toolCount: tools?.length ?? 0, maxTokens, model: model?.id });
        process.stderr.write(`[diag] ipc_llm_call model=${model?.id} messages=${allMessages.length} tools=${tools?.length ?? 0}\n`);
        const response = await client.call({
          action: 'llm_call',
          model: model?.id,
          messages: allMessages,
          tools,
          maxTokens,
        }, LLM_CALL_TIMEOUT_MS) as unknown as IPCResponse;

        if (!response.ok) {
          logger.debug('ipc_llm_error', { error: response.error });
          process.stderr.write(`[diag] ipc_llm_error: ${response.error}\n`);
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

        logger.debug('ipc_llm_result', {
          stopReason,
          textLength: fullText.length,
          textPreview: fullText.slice(0, 200),
          toolCallCount: toolCalls.length,
          toolNames: toolCalls.map(t => t.name),
        });
        process.stderr.write(`[diag] ipc_llm_result stop=${stopReason} text=${fullText.length}chars tools=[${toolCalls.map(t => t.name).join(',')}]\n`);
        emitStreamEvents(stream, msg, fullText, toolCalls, stopReason as 'stop' | 'toolUse');
      } catch (err: unknown) {
        logger.debug('ipc_llm_stream_error', { error: (err as Error).message, stack: (err as Error).stack });
        process.stderr.write(`[diag] ipc_llm_stream_error: ${(err as Error).message}\n`);
        const errMsg = makeErrorMessage((err as Error).message);
        stream.push({ type: 'start', partial: errMsg });
        stream.push({ type: 'error', reason: 'error', error: errMsg });
      }
    })();

    return stream;
  };
}

function makeErrorMessage(errorText: string, api = 'ax-ipc'): AssistantMessage {
  return makeProxyErrorMessage(errorText, api);
}

// ── IPC tools as pi-coding-agent ToolDefinitions ────────────────────

import { TOOL_CATALOG, normalizeOrigin, normalizeIdentityFile } from '../tool-catalog.js';

function text(t: string) {
  return { content: [{ type: 'text' as const, text: t }], details: undefined };
}

interface IPCToolDefsOptions {
  /** Current user ID — included in user_write calls for per-user scoping. */
  userId?: string;
}

function createIPCToolDefinitions(client: IPCClient, opts?: IPCToolDefsOptions): ToolDefinition[] {
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

  const TOOLS_WITH_ORIGIN = new Set(['identity_write', 'user_write']);

  return TOOL_CATALOG.map(spec => ({
    name: spec.name,
    label: spec.label,
    description: spec.description,
    parameters: spec.parameters,
    async execute(_id: string, params: unknown) {
      process.stderr.write(`[diag] tool_execute name=${spec.name}\n`);
      let callParams = spec.injectUserId
        ? { ...p(params), userId: opts?.userId ?? '' }
        : p(params);
      // Normalize enum-like fields for weaker models that send free text
      if (TOOLS_WITH_ORIGIN.has(spec.name) && 'origin' in callParams) {
        callParams = { ...callParams, origin: normalizeOrigin(callParams.origin) };
      }
      if (spec.name === 'identity_write' && 'file' in callParams) {
        callParams = { ...callParams, file: normalizeIdentityFile(callParams.file) };
      }
      return ipcCall(spec.name, callParams);
    },
  })) as ToolDefinition[];
}

// ── Main runner ─────────────────────────────────────────────────────

export async function runPiSession(config: AgentConfig): Promise<void> {
  const userMessage = config.userMessage ?? '';
  if (!userMessage.trim()) {
    logger.debug('skip_empty');
    return;
  }

  // Decide LLM transport: proxy (direct Anthropic SDK) or IPC fallback
  const useProxy = !!config.proxySocket;
  const activeModel = useProxy ? createProxyModel(config.maxTokens, config.model) : createIPCModel(config.maxTokens, config.model);
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
    const proxyStreamFn = createProxyStreamFn(config.proxySocket!);
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

  // Build system prompt via shared prompt builder
  const { systemPrompt } = buildSystemPrompt(config);

  // Create coding tools bound to the workspace directory.
  // IMPORTANT: codingTools (the pre-instantiated export) captures process.cwd()
  // at import time via closures — those tools would write to the wrong directory.
  // createCodingTools(cwd) creates fresh tools bound to the workspace.
  const tools = createCodingTools(config.workspace);

  // Create IPC tool definitions for pi-coding-agent
  const ipcToolDefs = createIPCToolDefinitions(client, { userId: config.userId });

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

  // Override system prompt.
  // Must set _baseSystemPrompt — the session resets agent.state.systemPrompt
  // to _baseSystemPrompt before every prompt() call (line ~551 in agent-session.js).
  // Setting only agent.state.systemPrompt gets overwritten immediately.
  (session as any)._baseSystemPrompt = systemPrompt;
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

  // Subscribe to events — stream text to stdout, log tools/errors to stderr
  const eventState = subscribeAgentEvents(session, config);

  // Send message and wait — log tools that are actually on the agent
  const agentTools = (session.agent.state as any).tools ?? [];
  const agentToolNames = agentTools.map((t: any) => t.name);
  process.stderr.write(`[diag] agent_tools count=${agentTools.length} names=[${agentToolNames.join(',')}]\n`);
  process.stderr.write(`[diag] prompt_start\n`);
  logger.debug('prompt_start', { messagePreview: truncate(userMessage, 200), agentToolNames });
  await session.prompt(userMessage);
  process.stderr.write(`[diag] prompt_returned events=${eventState.eventCount()} hasOutput=${eventState.hasOutput()}\n`);
  logger.debug('prompt_returned', { eventCount: eventState.eventCount(), hasOutput: eventState.hasOutput() });
  await session.agent.waitForIdle();
  process.stderr.write(`[diag] wait_idle_returned events=${eventState.eventCount()} hasOutput=${eventState.hasOutput()}\n`);
  logger.debug('wait_idle_returned', { eventCount: eventState.eventCount(), hasOutput: eventState.hasOutput() });

  // Log final agent state for debugging
  const finalMessages = session.agent.state.messages;
  const lastMsg = finalMessages[finalMessages.length - 1];
  if (lastMsg && lastMsg.role === 'assistant') {
    const content = (lastMsg as any).content;
    const contentTypes = Array.isArray(content)
      ? content.map((c: any) => c.type)
      : [typeof content];
    process.stderr.write(`[diag] final_assistant_message contentTypes=[${contentTypes}] stopReason=${(lastMsg as any).stopReason} totalMessages=${finalMessages.length}\n`);
    logger.debug('final_assistant_message', {
      contentTypes,
      stopReason: (lastMsg as any).stopReason,
      messageCount: finalMessages.length,
    });
  }

  logger.debug('session_complete', { eventCount: eventState.eventCount(), hasOutput: eventState.hasOutput() });
  session.dispose();
  client.disconnect();
}
