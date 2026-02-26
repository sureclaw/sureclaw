import { join } from 'node:path';
import { Agent } from '@mariozechner/pi-agent-core';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type {
  Model,
  UserMessage,
  AssistantMessage,
} from '@mariozechner/pi-ai';

import { IPCClient } from './ipc-client.js';
import { createIPCStreamFn } from './ipc-transport.js';
import { createLocalTools } from './local-tools.js';
import { createIPCTools } from './ipc-tools.js';
import { createProxyStreamFn } from './proxy-stream.js';
import { buildSystemPrompt, subscribeAgentEvents } from './agent-setup.js';
import { getLogger, truncate } from '../logger.js';
import type { ContentBlock } from '../types.js';

const logger = getLogger().child({ component: 'runner' });

// Default model — the actual model ID is forwarded through IPC to the host,
// which routes it to the configured LLM provider. This just needs to be a
// valid Model object for pi-agent-core's Agent class.
const DEFAULT_MODEL_ID = 'claude-sonnet-4-5-20250929';
const DEFAULT_CONTEXT_WINDOW = 200000;

function createDefaultModel(maxTokens?: number, modelId?: string): Model<any> {
  return {
    id: modelId ?? DEFAULT_MODEL_ID,
    name: modelId ?? 'Claude Sonnet 4.5',
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
  content: string | ContentBlock[];
  sender?: string;
}

export type AgentType = 'pi-agent-core' | 'pi-coding-agent' | 'claude-code';

export interface AgentConfig {
  agent?: AgentType;
  model?: string;          // e.g. 'moonshotai/kimi-k2-instruct-0905' (provider prefix already stripped)
  ipcSocket: string;
  workspace: string;
  skills: string;
  proxySocket?: string;
  maxTokens?: number;
  verbose?: boolean;
  userMessage?: string | ContentBlock[];
  history?: ConversationTurn[];
  agentDir?: string;
  userId?: string;
  // Taint state from host (via stdin payload)
  taintRatio?: number;
  taintThreshold?: number;
  profile?: string;
  sandboxType?: string;
  replyOptional?: boolean;
  // Enterprise fields
  agentId?: string;
  agentWorkspace?: string;
  userWorkspace?: string;
  scratchDir?: string;
}

/** Sanitize a sender name: only alphanumeric, underscore, dot, dash; max 100 chars. */
function sanitizeSender(sender: string): string {
  return sender.replace(/[^a-zA-Z0-9_.\-]/g, '').slice(0, 100);
}

/**
 * Convert stored conversation history to pi-ai message format
 * for pre-populating the Agent's state.
 */
/** Extract text content from a string or ContentBlock[]. */
function extractText(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map(b => b.text)
    .join('\n');
}

export function historyToPiMessages(history: ConversationTurn[]): AgentMessage[] {
  return history.map((turn): AgentMessage => {
    if (turn.role === 'user') {
      // Extract text for pi-agent-core (which only supports text messages).
      // Image content blocks are handled at the IPC/LLM level, not the agent level.
      let text = extractText(turn.content);
      if (turn.sender) {
        const safe = sanitizeSender(turn.sender);
        if (safe) {
          text = `[${safe}]: ${text}`;
        }
      }
      return {
        role: 'user',
        content: text,
        timestamp: Date.now(),
      } satisfies UserMessage;
    }
    return {
      role: 'assistant',
      content: [{ type: 'text', text: extractText(turn.content) }],
      api: 'anthropic-messages',
      provider: 'anthropic',
      model: DEFAULT_MODEL_ID,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'stop',
      timestamp: Date.now(),
    } satisfies AssistantMessage;
  });
}

/**
 * Estimate total tokens in a conversation history (chars/4 heuristic, conservative).
 */
function estimateHistoryTokens(messages: AgentMessage[]): number {
  return messages.reduce((sum, msg) => sum + Math.ceil(JSON.stringify(msg).length / 4), 0);
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

  // Use IPC to call the LLM for summarization — request the 'fast' task type
  // so the host-side router picks a cheap/fast model if one is configured.
  const response = await client.call({
    action: 'llm_call',
    taskType: 'fast',
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
  let model = '';
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
      case '--model': model = args[++i]; break;
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
    model: model || undefined,
    proxySocket: proxySocket || undefined,
    maxTokens: maxTokens || undefined,
    verbose,
    agentDir: agentDir || undefined,
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
  process.stderr.write(`[diag] runPiCore start\n`);
  // Extract text for the agent prompt — pi-agent-core only supports text input.
  // Image blocks (image or image_data) are preserved separately and injected
  // into IPC LLM calls so the host-side Anthropic provider can send them to Claude.
  const rawMessage = config.userMessage ?? '';
  const userMessage = typeof rawMessage === 'string' ? rawMessage : extractText(rawMessage);
  const imageBlocks: ContentBlock[] = Array.isArray(rawMessage)
    ? rawMessage.filter((b): b is ContentBlock => b.type === 'image' || b.type === 'image_data')
    : [];
  if (!userMessage.trim() && imageBlocks.length === 0) {
    logger.debug('pi_core_skip_empty');
    return;
  }
  // If images are attached but no text, provide a minimal prompt so
  // pi-agent-core has something to work with.
  const promptText = userMessage.trim() || (imageBlocks.length > 0 ? '[image attached]' : '.');

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

  const { systemPrompt } = buildSystemPrompt(config);

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

  const model = createDefaultModel(config.maxTokens, config.model);

  // Select stream function: proxy (Anthropic SDK via Unix socket) or IPC.
  // Image blocks are passed to IPC transport for host-side resolution.
  const streamFn = useProxy
    ? createProxyStreamFn(config.proxySocket!)
    : createIPCStreamFn(client, imageBlocks.length > 0 ? imageBlocks : undefined);

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

  // Subscribe to events — stream text to stdout, log tools/errors to stderr
  const eventState = subscribeAgentEvents(agent, config);

  // Send the user message and wait for the agent to finish
  process.stderr.write(`[diag] pi_core_prompt\n`);
  logger.debug('pi_core_prompt', { messagePreview: truncate(promptText, 200), imageCount: imageBlocks.length });
  await agent.prompt(promptText);
  process.stderr.write(`[diag] pi_core_prompt_returned events=${eventState.eventCount()} hasOutput=${eventState.hasOutput()}\n`);
  await agent.waitForIdle();
  process.stderr.write(`[diag] pi_core_idle events=${eventState.eventCount()} hasOutput=${eventState.hasOutput()}\n`);

  logger.debug('pi_core_complete', { eventCount: eventState.eventCount(), hasOutput: eventState.hasOutput() });
  client.disconnect();
}

export interface StdinPayload {
  /** User message — may be plain text or structured content with image blocks. */
  message: string | ContentBlock[];
  history: ConversationTurn[];
  taintRatio: number;
  taintThreshold: number;
  profile: string;
  sandboxType: string;
  userId?: string;
  replyOptional?: boolean;
  // Enterprise fields
  agentId?: string;
  agentWorkspace?: string;
  userWorkspace?: string;
  scratchDir?: string;
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
    if (parsed && typeof parsed === 'object' &&
        (typeof parsed.message === 'string' || Array.isArray(parsed.message))) {
      return {
        message: parsed.message,
        history: Array.isArray(parsed.history) ? parsed.history.map((h: Record<string, unknown>) => ({
          role: h.role as 'user' | 'assistant',
          content: (typeof h.content === 'string' ? h.content : Array.isArray(h.content) ? h.content : String(h.content)) as string | ContentBlock[],
          ...(typeof h.sender === 'string' ? { sender: h.sender } : {}),
        })) : [],
        taintRatio: typeof parsed.taintRatio === 'number' ? parsed.taintRatio : 0,
        taintThreshold: typeof parsed.taintThreshold === 'number' ? parsed.taintThreshold : 1,
        profile: typeof parsed.profile === 'string' ? parsed.profile : 'balanced',
        sandboxType: typeof parsed.sandboxType === 'string' ? parsed.sandboxType : 'subprocess',
        userId: typeof parsed.userId === 'string' ? parsed.userId : undefined,
        replyOptional: parsed.replyOptional === true,
        // Enterprise fields
        agentId: typeof parsed.agentId === 'string' ? parsed.agentId : undefined,
        agentWorkspace: typeof parsed.agentWorkspace === 'string' ? parsed.agentWorkspace : undefined,
        userWorkspace: typeof parsed.userWorkspace === 'string' ? parsed.userWorkspace : undefined,
        scratchDir: typeof parsed.scratchDir === 'string' ? parsed.scratchDir : undefined,
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
  process.stderr.write(`[diag] dispatch agent=${agent}\n`);
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
    const msgText = typeof payload.message === 'string' ? payload.message : extractText(payload.message);
    logger.debug('stdin_parsed', {
      messageLength: msgText.length,
      historyTurns: payload.history.length,
      messagePreview: truncate(msgText, 200),
      taintRatio: payload.taintRatio,
      profile: payload.profile,
      hasImageBlocks: typeof payload.message !== 'string',
    });
    config.userMessage = payload.message;
    config.history = payload.history;
    config.taintRatio = payload.taintRatio;
    config.taintThreshold = payload.taintThreshold;
    config.profile = payload.profile;
    config.sandboxType = payload.sandboxType;
    config.userId = payload.userId;
    config.replyOptional = payload.replyOptional;
    // Enterprise fields
    config.agentId = payload.agentId;
    config.agentWorkspace = payload.agentWorkspace;
    config.userWorkspace = payload.userWorkspace;
    config.scratchDir = payload.scratchDir;
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
