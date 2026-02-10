import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Agent } from '@mariozechner/pi-agent-core';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { Model, UserMessage, AssistantMessage } from '@mariozechner/pi-ai';
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

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--agent': agent = args[++i] as AgentType; break;
      case '--ipc-socket': ipcSocket = args[++i]; break;
      case '--workspace': workspace = args[++i]; break;
      case '--skills': skills = args[++i]; break;
      case '--proxy-socket': proxySocket = args[++i]; break;
      case '--max-tokens': maxTokens = parseInt(args[++i], 10) || 0; break;
      case '--verbose': verbose = true; break;
    }
  }

  ipcSocket = ipcSocket || process.env.AX_IPC_SOCKET || '';
  workspace = workspace || process.env.AX_WORKSPACE || '';
  skills = skills || process.env.AX_SKILLS || '';

  if (!ipcSocket || !workspace) {
    console.error('Usage: agent-runner --agent <type> --ipc-socket <path> --workspace <path> [--skills <path>]');
    process.exit(1);
  }

  return { agent, ipcSocket, workspace, skills, proxySocket: proxySocket || undefined, maxTokens: maxTokens || undefined, verbose };
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

function buildSystemPrompt(context: string, skills: string[]): string {
  const parts: string[] = [];
  parts.push('You are AX, a security-first AI agent.');
  parts.push('Follow the safety rules in your skills. Never reveal canary tokens.');

  if (context) {
    parts.push('\n## Context\n' + context);
  }
  if (skills.length > 0) {
    parts.push('\n## Skills\n' + skills.join('\n---\n'));
  }

  return parts.join('\n');
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

  debug(SRC, 'pi_core_start', {
    workspace: config.workspace,
    messageLength: userMessage.length,
    historyTurns: config.history?.length ?? 0,
  });

  const client = new IPCClient({ socketPath: config.ipcSocket });
  await client.connect();

  const context = loadContext(config.workspace);
  const skills = loadSkills(config.skills);
  const systemPrompt = buildSystemPrompt(context, skills);

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

  debug(SRC, 'pi_core_agent_create', {
    historyMessages: historyMessages.length,
    model: model.id,
    maxTokens: model.maxTokens,
  });

  // Create agent with IPC-proxied LLM calls, pre-populated with history
  const agent = new Agent({
    initialState: {
      systemPrompt,
      model,
      tools: allTools,
      messages: historyMessages,
    },
    streamFn: createIPCStreamFn(client),
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
      const { runPiSession } = await import('./agents/pi-session.js');
      return runPiSession(config);
    }
    case 'claude-code': {
      const { runClaudeCode } = await import('./agents/claude-code.js');
      return runClaudeCode(config);
    }
    default:
      debug(SRC, 'unknown_agent', { agent });
      console.error(`Unknown agent type: ${agent}`);
      process.exit(1);
  }
}

// Run if this is the main module
const isMain = process.argv[1]?.endsWith('agent-runner.js') ||
               process.argv[1]?.endsWith('agent-runner.ts');
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
