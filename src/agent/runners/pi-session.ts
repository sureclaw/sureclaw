/**
 * pi-coding-agent runner — uses createAgentSession() with a custom LLM
 * provider. When a proxy socket is available, LLM calls go directly through
 * the Anthropic SDK via the credential-injecting proxy (no IPC overhead).
 * Falls back to IPC-based LLM transport when no proxy socket is configured.
 * Non-LLM tools (memory, web, audit) always use IPC.
 */

import { join } from 'node:path';
import { existsSync } from 'node:fs';
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
  SessionManager,
  AuthStorage,
} from '@mariozechner/pi-coding-agent';
import type { ToolDefinition } from '@mariozechner/pi-coding-agent';
import { IPCClient } from '../ipc-client.js';
import { startWebProxyBridge, type WebProxyBridge } from '../web-proxy-bridge.js';
import { compactHistory, historyToPiMessages } from '../runner.js';
import type { AgentConfig, IIPCClient } from '../runner.js';
import { convertPiMessages, emitStreamEvents, injectFileBlocks } from '../stream-utils.js';
import { createProxyStreamFn } from '../proxy-stream.js';
import { makeProxyErrorMessage } from '../proxy-stream.js';
import type { ContentBlock } from '../../types.js';
import { buildSystemPrompt, fetchSkillsIndex, subscribeAgentEvents } from '../agent-setup.js';
import { GitWorkspace } from '../git-workspace.js';
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

function createIPCStreamFunction(client: IIPCClient, fileBlocks: ContentBlock[] = []) {
  let fileBlocksInjected = false;
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
    // Inject media blocks (images, PDFs, etc.) into the user message on the first LLM call
    if (!fileBlocksInjected && fileBlocks.length > 0) {
      injectFileBlocks(messages, fileBlocks);
      fileBlocksInjected = true;
    }

    const tools = context.tools?.map(t => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));

    (async () => {
      const llmCallStart = Date.now();
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

        const llmCallDurationMs = Date.now() - llmCallStart;
        logger.debug('ipc_llm_result', {
          stopReason,
          textLength: fullText.length,
          textPreview: fullText.slice(0, 200),
          toolCallCount: toolCalls.length,
          toolNames: toolCalls.map(t => t.name),
          inputTokens: usage.input,
          outputTokens: usage.output,
          totalTokens: usage.totalTokens,
          durationMs: llmCallDurationMs,
        });
        process.stderr.write(`[diag] ipc_llm_result stop=${stopReason} text=${fullText.length}chars tools=[${toolCalls.map(t => t.name).join(',')}] tokens=${usage.input}in/${usage.output}out duration=${llmCallDurationMs}ms\n`);
        emitStreamEvents(stream, msg, fullText, toolCalls, stopReason as 'stop' | 'toolUse');
      } catch (err: unknown) {
        const llmErrorDurationMs = Date.now() - llmCallStart;
        const cause = (err as any)?.cause;
        const causeDetail = cause ? ` (cause: ${cause.code ?? ''} ${cause.message ?? ''})`.trim() : '';
        logger.debug('ipc_llm_stream_error', {
          error: (err as Error).message,
          causeCode: cause?.code,
          causeMessage: cause?.message,
          stack: (err as Error).stack,
          model: model?.id,
          messageCount: messages.length,
          durationMs: llmErrorDurationMs,
        });
        process.stderr.write(`[diag] ipc_llm_stream_error model=${model?.id} messages=${messages.length} duration=${llmErrorDurationMs}ms: ${(err as Error).message}${causeDetail}\n`);
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

import { TOOL_CATALOG, filterTools } from '../tool-catalog.js';
import type { ToolFilterContext } from '../tool-catalog.js';
import { createLocalSandbox } from '../local-sandbox.js';
import { executeScript } from '../execute-script.js';

function text(t: string) {
  return { content: [{ type: 'text' as const, text: t }], details: undefined };
}

/** Maximum tool calls per session to prevent infinite retry loops.
 *  Matches claude-code runner's maxTurns: 20 (but counts individual tool
 *  calls, not LLM turns, so the limit is higher). */
const MAX_TOOL_CALLS = 50;

/** Maximum consecutive failed calls to the same IPC action before circuit-breaking.
 *  Prevents the LLM from burning tool budget retrying a failing action. */
const MAX_CONSECUTIVE_ACTION_FAILURES = 3;

/** Detect common failure indicators in a stringified IPC result. */
function isFailureResult(resultStr: string): boolean {
  try {
    const parsed = JSON.parse(resultStr);
    // unwrap text wrapper: { content: [{ text: "..." }] }
    const inner = parsed?.content?.[0]?.text;
    if (typeof inner === 'string') {
      if (inner.startsWith('Error:')) return true;
      try {
        const obj = JSON.parse(inner);
        if (obj.installed === false || obj.ok === false) return true;
        if (typeof obj.error === 'string') return true;
      } catch { /* not JSON inner — not a structured failure */ }
    }
  } catch { /* not JSON at all */ }
  return false;
}

interface IPCToolDefsOptions {
  /** Current user ID (kept for backward compatibility). */
  userId?: string;
  /** Tool filter context — excludes tools irrelevant to the current session. */
  filter?: ToolFilterContext;
  /** When set, sandbox tools execute locally with host audit gate. */
  localSandbox?: { client: IIPCClient; workspace: string };
}

function createIPCToolDefinitions(client: IIPCClient, opts?: IPCToolDefsOptions): ToolDefinition[] {
  async function ipcCall(action: string, params: Record<string, unknown> = {}, timeoutMs?: number) {
    try {
      logger.debug('tool_ipc_call', { action });
      const result = await client.call({ action, ...params }, timeoutMs);
      return text(JSON.stringify(result));
    } catch (err: unknown) {
      logger.debug('tool_ipc_error', { action, error: (err as Error).message });
      return text(`Error: ${(err as Error).message}`);
    }
  }

  // Lazily create local sandbox executor if configured
  const sandbox = opts?.localSandbox
    ? createLocalSandbox({ client: opts.localSandbox.client, workspace: opts.localSandbox.workspace })
    : null;

  // Cast params to Record<string, unknown> since TypeBox Static types
  // resolve to unknown in this context but IPC just forwards them as-is.
  const p = (v: unknown) => v as Record<string, unknown>;

  const catalog = opts?.filter ? filterTools(opts.filter) : TOOL_CATALOG;
  let toolCallCount = 0;

  // Per-action failure tracking for circuit-breaking retry loops
  const actionFailures = new Map<string, number>();

  return catalog.map(spec => ({
    name: spec.name,
    label: spec.label,
    description: spec.description,
    parameters: spec.parameters,
    async execute(_id: string, params: unknown) {
      toolCallCount++;
      if (toolCallCount > MAX_TOOL_CALLS) {
        logger.warn('max_tool_calls_exceeded', { count: toolCallCount, limit: MAX_TOOL_CALLS });
        return text('Error: Maximum tool call limit reached (' + MAX_TOOL_CALLS + ' calls). Please provide your final response to the user.');
      }
      const toolStart = Date.now();
      process.stderr.write(`[diag] tool_execute name=${spec.name}\n`);
      logger.debug('tool_execute', { name: spec.name, category: spec.category });
      const raw = p(params);
      let action: string;
      let callParams: Record<string, unknown>;

      if (spec.actionMap) {
        const { type, ...rest } = raw;
        action = spec.actionMap[type as string];
        if (!action) return text(`Error: unknown type "${type}" for tool "${spec.name}"`);
        callParams = rest;
      } else {
        action = spec.singletonAction ?? spec.name;
        callParams = raw;
      }

      // Circuit-breaker: stop retrying an action that keeps failing
      const priorFailures = actionFailures.get(action) ?? 0;
      if (priorFailures >= MAX_CONSECUTIVE_ACTION_FAILURES) {
        logger.warn('action_circuit_breaker', { action, failures: priorFailures });
        return text(
          `Error: "${action}" has failed ${priorFailures} consecutive times. ` +
          'Do NOT retry — inform the user what went wrong and move on.',
        );
      }

      // execute_script always runs locally — it only needs Node.js and the filesystem
      if (action === 'execute_script') {
        const result = executeScript(
          { code: callParams.code as string, timeoutMs: callParams.timeoutMs as number | undefined },
          opts?.localSandbox?.workspace ?? process.cwd(),
        );
        return text(JSON.stringify(result));
      }

      // Route sandbox tools to local executor when in container
      if (sandbox && spec.category === 'sandbox') {
        switch (action) {
          case 'sandbox_bash':
            return text(JSON.stringify(await sandbox.bash(callParams.command as string)));
          case 'sandbox_read_file':
            return text(JSON.stringify(await sandbox.readFile(callParams.path as string)));
          case 'sandbox_write_file':
            return text(JSON.stringify(await sandbox.writeFile(callParams.path as string, callParams.content as string)));
          case 'sandbox_edit_file':
            return text(JSON.stringify(await sandbox.editFile(callParams.path as string, callParams.old_string as string, callParams.new_string as string)));
          case 'sandbox_glob':
            return text(JSON.stringify(await sandbox.glob(
              callParams.pattern as string,
              {
                path: callParams.path as string | undefined,
                max_results: callParams.max_results as number | undefined,
              },
            )));
          case 'sandbox_grep':
            return text(JSON.stringify(await sandbox.grep(
              callParams.pattern as string,
              {
                path: callParams.path as string | undefined,
                glob: callParams.glob as string | undefined,
                max_results: callParams.max_results as number | undefined,
                include_line_numbers: callParams.include_line_numbers as boolean | undefined,
                context_lines: callParams.context_lines as number | undefined,
              },
            )));
        }
      }

      const result = await ipcCall(action, callParams, spec.timeoutMs);
      const toolDurationMs = Date.now() - toolStart;
      const resultStr = JSON.stringify(result);
      logger.debug('tool_result', { name: spec.name, action, durationMs: toolDurationMs, resultLength: resultStr.length });

      // Track failures for circuit-breaker (check for common failure indicators)
      if (isFailureResult(resultStr)) {
        actionFailures.set(action, priorFailures + 1);
      } else {
        actionFailures.delete(action); // reset on success
      }
      process.stderr.write(`[diag] tool_result name=${spec.name} action=${action} duration=${toolDurationMs}ms resultLen=${resultStr.length}\n`);
      return result;
    },
  })) as ToolDefinition[];
}

// ── Main runner ─────────────────────────────────────────────────────

export async function runPiSession(config: AgentConfig): Promise<void> {
  const rawMsg = config.userMessage ?? '';
  const userMessage = typeof rawMsg === 'string'
    ? rawMsg
    : rawMsg.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join('\n');
  if (!userMessage.trim()) {
    logger.debug('skip_empty');
    return;
  }

  // Extract inline media blocks (images, PDFs, etc.) for forwarding to the LLM
  const fileBlocks = Array.isArray(rawMsg)
    ? rawMsg.filter(b => b.type === 'file_data' || b.type === 'image_data')
    : [];

  // Start web proxy bridge for outbound HTTP/HTTPS access if available
  let webProxyBridge: WebProxyBridge | undefined;
  const webProxySocket = process.env.AX_WEB_PROXY_SOCKET;
  const webProxyUrl = process.env.AX_WEB_PROXY_URL;
  const webProxyPort = process.env.AX_PROXY_LISTEN_PORT;
  if (webProxySocket) {
    try {
      webProxyBridge = await startWebProxyBridge(webProxySocket);
      logger.info('web_proxy_bridge_started', { port: webProxyBridge.port });
    } catch (err) {
      logger.warn('web_proxy_bridge_failed', { error: (err as Error).message });
    }
  }

  // Set HTTP_PROXY env vars for child processes
  const webProxyEnvUrl = webProxyBridge
    ? `http://127.0.0.1:${webProxyBridge.port}`
    : webProxyUrl
      ? webProxyUrl
      : webProxyPort
        ? `http://127.0.0.1:${webProxyPort}`
        : undefined;
  if (webProxyEnvUrl) {
    process.env.HTTP_PROXY = webProxyEnvUrl;
    process.env.HTTPS_PROXY = webProxyEnvUrl;
    process.env.http_proxy = webProxyEnvUrl;
    process.env.https_proxy = webProxyEnvUrl;
    logger.info('web_proxy_env_set', {
      url: webProxyEnvUrl,
      source: webProxyBridge ? 'bridge' : webProxyUrl ? 'AX_WEB_PROXY_URL' : 'AX_PROXY_LISTEN_PORT',
    });
  } else {
    logger.info('web_proxy_env_none', {
      socket: webProxySocket ?? 'unset',
      url: webProxyUrl ?? 'unset',
      port: webProxyPort ?? 'unset',
    });
  }

  // Initialize git workspace if WORKSPACE_REPO_URL is set.
  // In k8s, the git-init container already cloned the repo and locked .git to UID 1001.
  // The agent (UID 1000) can read/write workspace files but cannot access .git.
  // A git-sidecar container (UID 1001) handles commit+push when signalled.
  const hasGitWorkspace = !!process.env.WORKSPACE_REPO_URL;
  const hasSidecar = hasGitWorkspace && config.sandboxType === 'k8s';
  let gitWorkspace: GitWorkspace | null = null;
  if (hasGitWorkspace && !hasSidecar) {
    // Non-k8s mode: agent owns git operations directly
    logger.info('git_workspace_init', { workspace: config.workspace, url: process.env.WORKSPACE_REPO_URL });
    gitWorkspace = new GitWorkspace(config.workspace, process.env.WORKSPACE_REPO_URL!);
    try {
      await gitWorkspace.clone();
      await gitWorkspace.init();
      await gitWorkspace.pull();
      logger.info('git_workspace_ready', { workspace: config.workspace, url: process.env.WORKSPACE_REPO_URL });
    } catch (err) {
      logger.error('git_workspace_init_failed', { error: (err as Error).message });
      throw err;
    }
  } else if (hasSidecar) {
    // K8s mode: pull latest via sidecar. Retry handles sidecar startup race
    // (both containers start simultaneously, sidecar may not be listening yet).
    const sidecarPort = process.env.AX_GIT_SIDECAR_PORT || '9099';
    const sidecarUrl = `http://localhost:${sidecarPort}`;
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        const resp = await fetch(`${sidecarUrl}/pull`, { method: 'POST' });
        const result = await resp.json() as { ok: boolean; error?: string };
        if (result.ok) {
          logger.info('sidecar_pull_complete', { attempt });
          break;
        }
        logger.warn('sidecar_pull_failed', { error: result.error, attempt });
        if (attempt < 9) await new Promise(r => setTimeout(r, 500));
      } catch (err) {
        if (attempt < 9) {
          logger.debug('sidecar_not_ready', { attempt, error: (err as Error).message });
          await new Promise(r => setTimeout(r, 500));
        } else {
          logger.warn('sidecar_pull_failed_all_retries', { error: (err as Error).message });
        }
      }
    }
  }

  // Skill dependencies are installed lazily when the agent reads a SKILL.md
  // and runs its install commands via bash — not eagerly at startup.

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

  // Use pre-connected client if available (listen mode starts before stdin read).
  // Otherwise create a new client and connect.
  const client = config.ipcClient ?? new IPCClient({ socketPath: config.ipcSocket, listen: config.ipcListen, sessionId: config.sessionId, requestId: config.requestId, userId: config.userId, sessionScope: config.sessionScope });
  if (!config.ipcClient) await client.connect();

  // Fetch host-authoritative skills index before building the prompt. Guard on
  // `skills === undefined` so injected skills (e.g., tests) take precedence.
  // fetchSkillsIndex returns undefined on transport errors — buildSystemPrompt
  // then falls back to the workspace filesystem scan.
  if (config.skills === undefined) {
    const fetched = await fetchSkillsIndex(client);
    if (fetched) config.skills = fetched;
  }

  // Register LLM provider (replaces built-in providers — no network in sandbox)
  clearApiProviders();
  if (useProxy) {
    const proxyStreamFn = createProxyStreamFn(config.proxySocket!, fileBlocks);
    registerApiProvider({
      api: 'ax-proxy',
      stream: proxyStreamFn,
      streamSimple: proxyStreamFn,
    });
  } else {
    const ipcStreamFn = createIPCStreamFunction(client, fileBlocks);
    registerApiProvider({
      api: 'ax-ipc',
      stream: ipcStreamFn,
      streamSimple: ipcStreamFn,
    });
  }
  logger.debug('provider_registered', { api: apiName });

  // Build system prompt via shared prompt builder
  const { systemPrompt, toolFilter } = buildSystemPrompt(config);

  // All tools (including bash/file ops) now come through IPC to the host process.
  // When running in a container (docker/apple/k8s), sandbox tools execute locally
  // with host audit gate instead of dispatching through the host.
  const CONTAINER_SANDBOXES = new Set(['docker', 'apple', 'k8s']);
  const useLocalSandbox = CONTAINER_SANDBOXES.has(config.sandboxType ?? '');
  logger.info('sandbox_type_check', { sandboxType: config.sandboxType, useLocalSandbox });
  const ipcToolDefs = createIPCToolDefinitions(client, {
    userId: config.userId,
    filter: toolFilter,
    ...(useLocalSandbox ? { localSandbox: { client, workspace: config.workspace } } : {}),
  });

  logger.debug('session_config', {
    systemPromptLength: systemPrompt.length,
    ipcToolCount: ipcToolDefs.length,
    ipcToolNames: ipcToolDefs.map(t => t.name),
  });

  // Create auth storage with a dummy key for the 'ax' IPC provider.
  // Without this, both AgentSession.prompt() and the Agent loop throw
  // "No API key found for ax" because the model registry doesn't know
  // about our IPC provider. The host handles real auth — no keys in sandbox.
  const authStorage = AuthStorage.create(join('/tmp/.ax-agent', 'auth.json'));
  authStorage.setRuntimeApiKey(activeModel.provider, apiName);

  // Create session with in-memory manager (no persistence in sandbox)
  logger.debug('creating_agent_session');
  const { session } = await createAgentSession({
    model: activeModel,
    tools: [],
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

  // Buffer text when response goes via IPC (k8s HTTP or Apple Container bridge).
  // For Docker/subprocess, stream to stdout — the host reads from stdout.
  const useIPCResponse = !!process.env.AX_HOST_URL || process.env.AX_IPC_LISTEN === '1';
  const textBuffer: string[] = [];

  // Subscribe to events — buffer text (IPC mode) or stream to stdout (Docker/subprocess)
  const eventState = subscribeAgentEvents(session, config, useIPCResponse ? { buffer: textBuffer } : undefined);

  // Send message and wait — log tools that are actually on the agent
  const agentTools = (session.agent.state as any).tools ?? [];
  const agentToolNames = agentTools.map((t: any) => t.name);
  process.stderr.write(`[diag] agent_tools count=${agentTools.length} names=[${agentToolNames.join(',')}]\n`);
  const promptStartTime = Date.now();
  process.stderr.write(`[diag] prompt_start\n`);
  logger.debug('prompt_start', { messagePreview: truncate(userMessage, 200), agentToolNames });
  await session.prompt(userMessage);
  const promptDurationMs = Date.now() - promptStartTime;
  process.stderr.write(`[diag] prompt_returned events=${eventState.eventCount()} hasOutput=${eventState.hasOutput()} duration=${promptDurationMs}ms\n`);
  logger.debug('prompt_returned', { eventCount: eventState.eventCount(), hasOutput: eventState.hasOutput(), durationMs: promptDurationMs });
  const idleStartTime = Date.now();
  await session.agent.waitForIdle();
  const idleDurationMs = Date.now() - idleStartTime;
  const totalDurationMs = Date.now() - promptStartTime;
  process.stderr.write(`[diag] wait_idle_returned events=${eventState.eventCount()} hasOutput=${eventState.hasOutput()} idleWait=${idleDurationMs}ms total=${totalDurationMs}ms\n`);
  logger.debug('wait_idle_returned', { eventCount: eventState.eventCount(), hasOutput: eventState.hasOutput(), idleDurationMs, totalDurationMs });

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

  // Persist workspace changes
  if (gitWorkspace) {
    // Non-k8s: agent owns git directly
    try {
      const timestamp = new Date().toISOString();
      await gitWorkspace.commitAndPush(`agent-turn: ${timestamp}`);
    } catch (err) {
      logger.error('git_turn_commit_failed', { error: (err as Error).message });
    }
  } else if (hasSidecar) {
    // Signal git-sidecar via HTTP — containers share localhost in the same pod
    const sidecarPort = process.env.AX_GIT_SIDECAR_PORT || '9099';
    try {
      const resp = await fetch(`http://localhost:${sidecarPort}/turn-complete`, { method: 'POST' });
      const result = await resp.json() as { ok: boolean; hash?: string; files?: number; error?: string };
      if (result.ok) {
        logger.info('sidecar_commit_complete', { hash: result.hash, files: result.files });
      } else {
        logger.error('sidecar_commit_failed', { error: result.error });
      }
    } catch (err) {
      logger.error('sidecar_signal_failed', { error: (err as Error).message });
    }
  }

  // Send response back to host via agent_response IPC action (k8s/bridge only).
  // Docker/subprocess response goes via stdout — no IPC needed.
  if (useIPCResponse) {
    const buffered = eventState.getBuffered();
    logger.debug('agent_response', { contentLength: buffered.length });
    try {
      await client.call({ action: 'agent_response', content: buffered }, 5000);
    } catch (err) {
      logger.error('agent_response_failed', { error: (err as Error).message });
      process.stderr.write(`Failed to send agent_response: ${(err as Error).message}\n`);
    }
  }

  session.dispose();
  if (webProxyBridge) webProxyBridge.stop();
  client.disconnect();
}
