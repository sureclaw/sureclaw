import { join } from 'node:path';
import { Agent } from '@mariozechner/pi-agent-core';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import {
  createAssistantMessageEventStream,
} from '@mariozechner/pi-ai';
import type {
  Model,
  UserMessage,
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  SimpleStreamOptions,
  TextContent,
  ToolCall,
} from '@mariozechner/pi-ai';
import type { MessageParam, Tool as AnthropicTool } from '@anthropic-ai/sdk/resources/messages';
import { estimateTokens } from '@mariozechner/pi-coding-agent';
import { IPCClient } from './ipc-client.js';
import { createIPCStreamFn } from './ipc-transport.js';
import { createLocalTools } from './local-tools.js';
import { createIPCTools } from './ipc-tools.js';
import { convertPiMessages, emitStreamEvents, createLazyAnthropicClient, loadContext, loadSkills } from './stream-utils.js';
import { PromptBuilder } from './prompt/builder.js';
import { loadIdentityFiles } from './identity-loader.js';
import { getLogger, truncate } from '../logger.js';

const logger = getLogger().child({ component: 'runner' });

// Default model — the actual model ID is forwarded through IPC to the host,
// which routes it to the configured LLM provider. This just needs to be a
// valid Model object for pi-agent-core's Agent class.
const DEFAULT_MODEL_ID = 'claude-sonnet-4-5-20250929';
const DEFAULT_CONTEXT_WINDOW = 200000;

function createDefaultModel(maxTokens?: number): Model<any> {
  return {
    id: DEFAULT_MODEL_ID,
    name: 'Claude Sonnet 4.5',
    api: 'anthropic-messages',
    provider: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: maxTokens ?? 8192,
  };
}

// Compaction thresholds
const COMPACTION_THRESHOLD = 0.75; // Trigger at 75% of context window
const KEEP_RECENT_TURNS = 6;      // Keep last 6 turns (3 user + 3 assistant)

export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
}

export type AgentType = 'pi-agent-core' | 'pi-coding-agent' | 'claude-code';

export interface AgentConfig {
  agent?: AgentType;
  ipcSocket: string;
  workspace: string;
  skills: string;
  proxySocket?: string;
  maxTokens?: number;
  verbose?: boolean;
  userMessage?: string;
  history?: ConversationTurn[];
  agentDir?: string;
  userId?: string;
  // Taint state from host (via stdin payload)
  taintRatio?: number;
  taintThreshold?: number;
  profile?: string;
  sandboxType?: string;
}

/**
 * Convert stored conversation history to pi-ai message format
 * for pre-populating the Agent's state.
 */
export function historyToPiMessages(history: ConversationTurn[]): AgentMessage[] {
  return history.map((turn): AgentMessage => {
    if (turn.role === 'user') {
      return {
        role: 'user',
        content: turn.content,
        timestamp: Date.now(),
      } satisfies UserMessage;
    }
    return {
      role: 'assistant',
      content: [{ type: 'text', text: turn.content }],
      api: 'anthropic-messages',
      provider: 'anthropic',
      model: DEFAULT_MODEL_ID,
      usage: { inputTokens: 0, outputTokens: 0, inputCachedTokens: 0, reasoningTokens: 0, totalCost: 0 },
      stopReason: 'stop',
      timestamp: Date.now(),
    } satisfies AssistantMessage;
  });
}

/**
 * Estimate total tokens in a conversation history using pi-coding-agent's
 * token estimator (chars/4 heuristic, conservative).
 */
function estimateHistoryTokens(messages: AgentMessage[]): number {
  return messages.reduce((sum, msg) => sum + estimateTokens(msg), 0);
}

/**
 * Compact conversation history if it exceeds the context window threshold.
 * Uses IPC to make an LLM call for summarization — no API keys needed in container.
 *
 * Returns compacted history as ConversationTurn[]. If no compaction needed,
 * returns the original history unchanged.
 */
export async function compactHistory(
  history: ConversationTurn[],
  client: IPCClient,
  contextWindow: number = DEFAULT_CONTEXT_WINDOW,
): Promise<ConversationTurn[]> {
  if (history.length <= KEEP_RECENT_TURNS) return history;

  const piMessages = historyToPiMessages(history);
  const totalTokens = estimateHistoryTokens(piMessages);
  const threshold = contextWindow * COMPACTION_THRESHOLD;

  if (totalTokens <= threshold) return history;

  // Split: old turns to summarize, recent turns to keep verbatim
  const oldTurns = history.slice(0, -KEEP_RECENT_TURNS);
  const recentTurns = history.slice(-KEEP_RECENT_TURNS);

  // Build a conversation transcript for the summarizer
  const transcript = oldTurns
    .map(t => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.content}`)
    .join('\n\n');

  const summaryPrompt =
    'Summarize the following conversation concisely, preserving key facts, ' +
    'decisions, code references, and any action items. The summary will replace ' +
    'the original messages to save context space.\n\n' +
    '---\n' + transcript + '\n---\n\n' +
    'Provide a clear, structured summary.';

  // Use IPC to call the LLM for summarization
  const response = await client.call({
    action: 'llm_call',
    model: DEFAULT_MODEL_ID,
    messages: [
      { role: 'system', content: 'You are a conversation summarizer. Be concise and preserve important details.' },
      { role: 'user', content: summaryPrompt },
    ],
  }) as { ok: boolean; chunks?: Array<{ type: string; content?: string }> };

  if (!response.ok || !response.chunks) {
    // If summarization fails, fall back to truncation
    return recentTurns;
  }

  const summaryText = response.chunks
    .filter(c => c.type === 'text' && c.content)
    .map(c => c.content!)
    .join('');

  if (!summaryText.trim()) return recentTurns;

  // Return summary as a system-like user message + recent turns
  return [
    { role: 'user', content: `[Conversation summary of ${oldTurns.length} earlier messages]\n\n${summaryText}` },
    { role: 'assistant', content: 'I understand the conversation context from the summary. How can I help?' },
    ...recentTurns,
  ];
}

function parseArgs(): AgentConfig {
  const args = process.argv.slice(2);
  let agent: AgentType = 'pi-agent-core';
  let ipcSocket = '';
  let workspace = '';
  let skills = '';
  let proxySocket = '';
  let maxTokens = 0;
  let verbose = false;
  let agentDir = '';

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--agent': agent = args[++i] as AgentType; break;
      case '--ipc-socket': ipcSocket = args[++i]; break;
      case '--workspace': workspace = args[++i]; break;
      case '--skills': skills = args[++i]; break;
      case '--proxy-socket': proxySocket = args[++i]; break;
      case '--max-tokens': maxTokens = parseInt(args[++i], 10) || 0; break;
      case '--verbose': verbose = true; break;
      case '--agent-dir': agentDir = args[++i]; break;
    }
  }

  ipcSocket = ipcSocket || process.env.AX_IPC_SOCKET || '';
  workspace = workspace || process.env.AX_WORKSPACE || '';
  skills = skills || process.env.AX_SKILLS || '';

  if (!ipcSocket || !workspace) {
    logger.error('missing_args', { message: 'Usage: agent-runner --agent <type> --ipc-socket <path> --workspace <path> [--skills <path>]' });
    process.exit(1);
  }

  return {
    agent, ipcSocket, workspace, skills,
    proxySocket: proxySocket || undefined,
    maxTokens: maxTokens || undefined,
    verbose,
    agentDir: agentDir || undefined,
  };
}

// ── Proxy-based StreamFn (Anthropic SDK via Unix socket) ─────────────

function makeProxyErrorMessage(errorText: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: errorText }],
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'unknown',
    usage: { inputTokens: 0, outputTokens: 0, inputCachedTokens: 0, reasoningTokens: 0, totalCost: 0 },
    stopReason: 'stop',
    errorMessage: errorText,
    timestamp: Date.now(),
  };
}

/**
 * Create a StreamFn that routes LLM calls through the credential-injecting
 * proxy via the Anthropic SDK. The proxy injects real API credentials — the
 * container never sees them.
 *
 * This is an async StreamFn (returns Promise<AssistantMessageEventStream>),
 * which pi-agent-core's Agent class supports.
 */
function createProxyStreamFn(proxySocket: string) {
  const getClient = createLazyAnthropicClient(proxySocket);

  return async (model: Model<any>, context: Context, options?: SimpleStreamOptions): Promise<AssistantMessageEventStream> => {
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
        const sdkStream = anthropic.messages.stream({
          model: model?.id ?? DEFAULT_MODEL_ID,
          max_tokens: maxTokens,
          system: context.systemPrompt || undefined,
          messages,
          tools: tools && tools.length > 0 ? tools : undefined,
        });

        const finalMessage = await sdkStream.finalMessage();

        // Build pi-ai AssistantMessage from the final response.
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
          inputTokens: finalMessage.usage?.input_tokens ?? 0,
          outputTokens: finalMessage.usage?.output_tokens ?? 0,
          inputCachedTokens: (finalMessage.usage as Record<string, number>)?.cache_read_input_tokens ?? 0,
          reasoningTokens: 0,
          totalCost: 0,
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
        const errMsg = makeProxyErrorMessage((err as Error).message);
        stream.push({ type: 'start', partial: errMsg });
        stream.push({ type: 'error', reason: 'error', error: errMsg });
      }
    })();

    return stream;
  };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

export async function runPiCore(config: AgentConfig): Promise<void> {
  const userMessage = config.userMessage ?? '';
  if (!userMessage.trim()) {
    logger.debug('pi_core_skip_empty');
    return;
  }

  // Decide LLM transport: proxy (direct Anthropic SDK) or IPC fallback
  const useProxy = !!config.proxySocket;

  logger.debug('pi_core_start', {
    workspace: config.workspace,
    messageLength: userMessage.length,
    historyTurns: config.history?.length ?? 0,
    llmTransport: useProxy ? 'proxy' : 'ipc',
    proxySocket: config.proxySocket,
  });

  if (!useProxy) {
    logger.debug('proxy_unavailable', { reason: 'config.proxySocket not set, falling back to IPC for LLM calls' });
  }

  const client = new IPCClient({ socketPath: config.ipcSocket });
  await client.connect();

  const contextContent = loadContext(config.workspace);
  const skills = loadSkills(config.skills);
  const identityFiles = loadIdentityFiles({
    agentDir: config.agentDir,
    userId: config.userId,
  });

  const promptBuilder = new PromptBuilder();
  const promptResult = promptBuilder.build({
    agentType: config.agent ?? 'pi-agent-core',
    workspace: config.workspace,
    skills,
    profile: config.profile ?? 'balanced',
    sandboxType: config.sandboxType ?? 'subprocess',
    taintRatio: config.taintRatio ?? 0,
    taintThreshold: config.taintThreshold ?? 1,
    identityFiles,
    contextContent,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    historyTokens: config.history?.length ? estimateTokens(JSON.stringify(config.history)) : 0,
  });
  const systemPrompt = promptResult.content;
  logger.debug('prompt_built', promptResult.metadata);

  // Build tools: local (execute in sandbox) + IPC (route to host)
  const localTools = createLocalTools(config.workspace);
  const ipcTools = createIPCTools(client, { userId: config.userId });
  const allTools = [...localTools, ...ipcTools];

  logger.debug('pi_core_tools', {
    localToolCount: localTools.length,
    ipcToolCount: ipcTools.length,
    toolNames: allTools.map(t => t.name),
    systemPromptLength: systemPrompt.length,
  });

  // Compact history if it's too long for the context window
  const history = config.history
    ? await compactHistory(config.history, client)
    : [];

  // Convert (possibly compacted) history to pi-ai messages
  const historyMessages = historyToPiMessages(history);

  const model = createDefaultModel(config.maxTokens);

  // Select stream function: proxy (Anthropic SDK via Unix socket) or IPC
  const streamFn = useProxy
    ? createProxyStreamFn(config.proxySocket!)
    : createIPCStreamFn(client);

  logger.debug('pi_core_agent_create', {
    historyMessages: historyMessages.length,
    model: model.id,
    maxTokens: model.maxTokens,
    llmTransport: useProxy ? 'proxy' : 'ipc',
  });

  // Create agent with selected LLM transport, pre-populated with history
  const agent = new Agent({
    initialState: {
      systemPrompt,
      model,
      tools: allTools,
      messages: historyMessages,
    },
    streamFn,
  });

  // Subscribe to events — stream text to stdout, log all events for debugging
  let hasOutput = false;
  let eventCount = 0;
  let turnCount = 0;
  agent.subscribe((event) => {
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
        logger.debug('tool_call', { toolName: ame.toolCall.name, toolId: ame.toolCall.id });
        if (config.verbose) {
          process.stderr.write(`[tool] ${ame.toolCall.name}\n`);
        }
      }
      if (ame.type === 'error') {
        const errText = ame.error?.errorMessage ?? String(ame.error);
        logger.error('agent_error_event', { error: errText });
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

  // Send the user message and wait for the agent to finish
  logger.debug('pi_core_prompt', { messagePreview: truncate(userMessage, 200) });
  await agent.prompt(userMessage);
  await agent.waitForIdle();

  logger.debug('pi_core_complete', { eventCount, hasOutput });
  client.disconnect();
}

export interface StdinPayload {
  message: string;
  history: ConversationTurn[];
  taintRatio: number;
  taintThreshold: number;
  profile: string;
  sandboxType: string;
  userId?: string;
}

/**
 * Parse stdin data. Supports two formats:
 * 1. JSON: {"history": [...], "message": "...", taintRatio, taintThreshold, profile, sandboxType}
 * 2. Plain text (backward compat): treated as the current message with no history
 */
export function parseStdinPayload(data: string): StdinPayload {
  const defaults: StdinPayload = {
    message: data,
    history: [],
    taintRatio: 0,
    taintThreshold: 1,   // permissive default (no blocking)
    profile: 'balanced',
    sandboxType: 'subprocess',
  };

  try {
    const parsed = JSON.parse(data);
    if (parsed && typeof parsed === 'object' && typeof parsed.message === 'string') {
      return {
        message: parsed.message,
        history: Array.isArray(parsed.history) ? parsed.history : [],
        taintRatio: typeof parsed.taintRatio === 'number' ? parsed.taintRatio : 0,
        taintThreshold: typeof parsed.taintThreshold === 'number' ? parsed.taintThreshold : 1,
        profile: typeof parsed.profile === 'string' ? parsed.profile : 'balanced',
        sandboxType: typeof parsed.sandboxType === 'string' ? parsed.sandboxType : 'subprocess',
        userId: typeof parsed.userId === 'string' ? parsed.userId : undefined,
      };
    }
  } catch {
    // Not JSON — fall through to plain text
  }
  return defaults;
}

/**
 * Dispatch to the appropriate agent implementation based on config.agent.
 */
export async function run(config: AgentConfig): Promise<void> {
  const agent = config.agent ?? 'pi-agent-core';
  logger.debug('dispatch', { agent, workspace: config.workspace, ipcSocket: config.ipcSocket });
  switch (agent) {
    case 'pi-agent-core':
      return runPiCore(config);
    case 'pi-coding-agent': {
      const { runPiSession } = await import('./runners/pi-session.js');
      return runPiSession(config);
    }
    case 'claude-code': {
      const { runClaudeCode } = await import('./runners/claude-code.js');
      return runClaudeCode(config);
    }
    default:
      logger.error('unknown_agent', { agent });
      process.exit(1);
  }
}

// Run if this is the main module
const isMain = process.argv[1]?.endsWith('runner.js') ||
               process.argv[1]?.endsWith('runner.ts');
if (isMain) {
  const config = parseArgs();
  logger.debug('main_start', { agent: config.agent, workspace: config.workspace });
  readStdin().then((data) => {
    const payload = parseStdinPayload(data);
    logger.debug('stdin_parsed', {
      messageLength: payload.message.length,
      historyTurns: payload.history.length,
      messagePreview: truncate(payload.message, 200),
      taintRatio: payload.taintRatio,
      profile: payload.profile,
    });
    config.userMessage = payload.message;
    config.history = payload.history;
    config.taintRatio = payload.taintRatio;
    config.taintThreshold = payload.taintThreshold;
    config.profile = payload.profile;
    config.sandboxType = payload.sandboxType;
    config.userId = payload.userId;
    return run(config);
  }).catch((err) => {
    logger.error('main_error', { error: (err as Error).message, stack: (err as Error).stack });
    // Use process.exitCode instead of process.exit() so Node.js drains
    // the event loop and flushes stderr before terminating. process.exit()
    // kills immediately and can lose piped stderr output.
    process.exitCode = 1;
    process.stderr.write(`Agent runner error: ${(err as Error).message ?? err}\n`);
  });
}
