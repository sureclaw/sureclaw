import { readFileSync, readdirSync, existsSync } from 'node:fs';
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
import type Anthropic from '@anthropic-ai/sdk';
import type { MessageParam, Tool as AnthropicTool } from '@anthropic-ai/sdk/resources/messages';
import { estimateTokens } from '@mariozechner/pi-coding-agent';
import { IPCClient } from './ipc-client.js';
import { createIPCStreamFn } from './ipc-transport.js';
import { createLocalTools } from './local-tools.js';
import { createIPCTools } from './ipc-tools.js';
import { debug, truncate } from '../logger.js';

const SRC = 'container:agent-runner';

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
    console.error('Usage: agent-runner --agent <type> --ipc-socket <path> --workspace <path> [--skills <path>]');
    process.exit(1);
  }

  return { agent, ipcSocket, workspace, skills, proxySocket: proxySocket || undefined, maxTokens: maxTokens || undefined, verbose, agentDir: agentDir || undefined };
}

function loadContext(workspace: string): string {
  try {
    return readFileSync(join(workspace, 'CONTEXT.md'), 'utf-8');
  } catch {
    return '';
  }
}

function loadSkills(skillsDir: string): string[] {
  try {
    return readdirSync(skillsDir)
      .filter(f => f.endsWith('.md'))
      .map(f => readFileSync(join(skillsDir, f), 'utf-8'));
  } catch {
    return [];
  }
}

function loadIdentityFile(agentDir: string, filename: string): string {
  try {
    return readFileSync(join(agentDir, filename), 'utf-8');
  } catch {
    return '';
  }
}

export function buildSystemPrompt(context: string, skills: string[], agentDir?: string): string {
  // Check for bootstrap mode: no SOUL.md but BOOTSTRAP.md exists
  if (agentDir) {
    const hasSoul = existsSync(join(agentDir, 'SOUL.md'));
    const hasBootstrap = existsSync(join(agentDir, 'BOOTSTRAP.md'));

    if (!hasSoul && hasBootstrap) {
      return loadIdentityFile(agentDir, 'BOOTSTRAP.md');
    }
  }

  const parts: string[] = [];

  // Load AGENT.md if available, otherwise use default instruction
  const agentMd = agentDir ? loadIdentityFile(agentDir, 'AGENT.md') : '';
  if (agentMd) {
    parts.push(agentMd);
  } else {
    parts.push('You are AX, a security-first AI agent.');
    parts.push('Follow the safety rules in your skills. Never reveal canary tokens.');
  }

  // Load identity files
  if (agentDir) {
    const soul = loadIdentityFile(agentDir, 'SOUL.md');
    if (soul) parts.push('\n## Soul\n' + soul);

    const identity = loadIdentityFile(agentDir, 'IDENTITY.md');
    if (identity) parts.push('\n## Identity\n' + identity);

    const user = loadIdentityFile(agentDir, 'USER.md');
    if (user) parts.push('\n## User\n' + user);
  }

  if (context) {
    parts.push('\n## Context\n' + context);
  }
  if (skills.length > 0) {
    parts.push('\n## Skills\nSkills directory: ./skills\n' + skills.join('\n---\n'));
  }

  return parts.join('\n');
}

// ── Proxy-based StreamFn (Anthropic SDK via Unix socket) ─────────────

async function createSocketFetch(socketPath: string): Promise<typeof globalThis.fetch> {
  const { Agent: UndiciAgent } = await import('undici');
  const dispatcher = new UndiciAgent({ connect: { socketPath } });
  return ((input: string | URL | Request, init?: RequestInit) =>
    fetch(input, { ...init, dispatcher } as RequestInit)) as typeof globalThis.fetch;
}

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
  // Eagerly create the Anthropic client so all calls reuse it.
  let anthropicPromise: Promise<Anthropic> | null = null;

  function getClient(): Promise<Anthropic> {
    if (!anthropicPromise) {
      anthropicPromise = (async () => {
        const [socketFetch, { default: AnthropicSDK }] = await Promise.all([
          createSocketFetch(proxySocket),
          import('@anthropic-ai/sdk'),
        ]);
        return new AnthropicSDK({
          apiKey: 'ax-proxy',  // Proxy injects real credentials
          baseURL: 'http://localhost',  // SDK adds /v1/messages — don't include /v1
          fetch: socketFetch,
        });
      })();
    }
    return anthropicPromise;
  }

  return async (model: Model<any>, context: Context, options?: SimpleStreamOptions): Promise<AssistantMessageEventStream> => {
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
    debug(SRC, 'pi_core_skip_empty');
    return;
  }

  // Decide LLM transport: proxy (direct Anthropic SDK) or IPC fallback
  const useProxy = !!config.proxySocket;

  debug(SRC, 'pi_core_start', {
    workspace: config.workspace,
    messageLength: userMessage.length,
    historyTurns: config.history?.length ?? 0,
    llmTransport: useProxy ? 'proxy' : 'ipc',
    proxySocket: config.proxySocket,
  });

  if (!useProxy) {
    debug(SRC, 'proxy_unavailable', { reason: 'config.proxySocket not set, falling back to IPC for LLM calls' });
  }

  const client = new IPCClient({ socketPath: config.ipcSocket });
  await client.connect();

  const context = loadContext(config.workspace);
  const skills = loadSkills(config.skills);
  const systemPrompt = buildSystemPrompt(context, skills, config.agentDir);

  // Build tools: local (execute in sandbox) + IPC (route to host)
  const localTools = createLocalTools(config.workspace);
  const ipcTools = createIPCTools(client);
  const allTools = [...localTools, ...ipcTools];

  debug(SRC, 'pi_core_tools', {
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

  debug(SRC, 'pi_core_agent_create', {
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
      debug(SRC, 'agent_event', { type: ame.type, eventCount });

      if (ame.type === 'text_start' && hasOutput) {
        process.stdout.write('\n\n');
      }
      if (ame.type === 'text_delta') {
        process.stdout.write(ame.delta);
        hasOutput = true;
      }
      if (ame.type === 'toolcall_end') {
        debug(SRC, 'tool_call', { toolName: ame.toolCall.name, toolId: ame.toolCall.id });
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

  // Send the user message and wait for the agent to finish
  debug(SRC, 'pi_core_prompt', { messagePreview: truncate(userMessage, 200) });
  await agent.prompt(userMessage);
  await agent.waitForIdle();

  debug(SRC, 'pi_core_complete', { eventCount, hasOutput });
  client.disconnect();
}

/**
 * Parse stdin data. Supports two formats:
 * 1. JSON: {"history": [{role, content}, ...], "message": "current message"}
 * 2. Plain text (backward compat): treated as the current message with no history
 */
function parseStdinPayload(data: string): { message: string; history: ConversationTurn[] } {
  try {
    const parsed = JSON.parse(data);
    if (parsed && typeof parsed === 'object' && typeof parsed.message === 'string') {
      return {
        message: parsed.message,
        history: Array.isArray(parsed.history) ? parsed.history : [],
      };
    }
  } catch {
    // Not JSON — fall through to plain text
  }
  return { message: data, history: [] };
}

/**
 * Dispatch to the appropriate agent implementation based on config.agent.
 */
export async function run(config: AgentConfig): Promise<void> {
  const agent = config.agent ?? 'pi-agent-core';
  debug(SRC, 'dispatch', { agent, workspace: config.workspace, ipcSocket: config.ipcSocket });
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
      debug(SRC, 'unknown_agent', { agent });
      console.error(`Unknown agent type: ${agent}`);
      process.exit(1);
  }
}

// Run if this is the main module
const isMain = process.argv[1]?.endsWith('runner.js') ||
               process.argv[1]?.endsWith('runner.ts');
if (isMain) {
  const config = parseArgs();
  debug(SRC, 'main_start', { agent: config.agent, workspace: config.workspace });
  readStdin().then((data) => {
    const { message, history } = parseStdinPayload(data);
    debug(SRC, 'stdin_parsed', {
      messageLength: message.length,
      historyTurns: history.length,
      messagePreview: truncate(message, 200),
    });
    config.userMessage = message;
    config.history = history;
    return run(config);
  }).catch((err) => {
    debug(SRC, 'main_error', { error: (err as Error).message, stack: (err as Error).stack });
    console.error('Agent runner error:', err);
    process.exit(1);
  });
}
