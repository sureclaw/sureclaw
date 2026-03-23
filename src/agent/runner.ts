import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type {
  UserMessage,
  AssistantMessage,
} from '@mariozechner/pi-ai';

import { IPCClient } from './ipc-client.js';
import { getLogger, truncate } from '../logger.js';
import type { ContentBlock } from '../types.js';
import type { IdentityFiles, SkillSummary } from './prompt/types.js';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';

const logger = getLogger().child({ component: 'runner' });

const DEFAULT_MODEL_ID = 'claude-sonnet-4-5-20250929';
const DEFAULT_CONTEXT_WINDOW = 200000;

// Compaction thresholds
const COMPACTION_THRESHOLD = 0.75; // Trigger at 75% of context window
const KEEP_RECENT_TURNS = 6;      // Keep last 6 turns (3 user + 3 assistant)

export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
  sender?: string;
}

export type AgentType = 'pi-coding-agent' | 'claude-code';

/** Minimal IPC client interface satisfied by both IPCClient and HttpIPCClient. */
export interface IIPCClient {
  call(request: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>;
  connect(): Promise<void>;
  disconnect(): void;
  setContext(ctx: { sessionId?: string; requestId?: string; userId?: string; sessionScope?: string; token?: string }): void;
}

export interface AgentConfig {
  agent?: AgentType;
  model?: string;          // e.g. 'moonshotai/kimi-k2-instruct-0905' (provider prefix already stripped)
  ipcSocket: string;
  /** If true, the IPC client listens for an incoming connection instead of
   *  connecting out. Used by Apple Container sandbox (reverse bridge). */
  ipcListen?: boolean;
  /** Pre-connected IPC client (created before stdin read in listen/HTTP mode).
   *  Runners should use this instead of creating a new IPCClient. */
  ipcClient?: IIPCClient;
  workspace: string;
  proxySocket?: string;
  maxTokens?: number;
  verbose?: boolean;
  userMessage?: string | ContentBlock[];
  history?: ConversationTurn[];
  userId?: string;
  // Taint state from host (via stdin payload)
  taintRatio?: number;
  taintThreshold?: number;
  profile?: string;
  sandboxType?: string;
  replyOptional?: boolean;
  /** Session ID from host — used to scope IPC requests (e.g. image generation). */
  sessionId?: string;
  /** HTTP request ID from host — used for event bus routing so SSE subscribers receive events. */
  requestId?: string;
  /** Session scope from channel provider — determines memory scoping (dm = user-scoped, channel = agent-scoped). */
  sessionScope?: 'dm' | 'channel' | 'thread' | 'group';
  // Enterprise fields
  agentId?: string;
  agentWorkspace?: string;
  userWorkspace?: string;
  /** Configured workspace provider name (e.g. 'none', 'local', 'gcs'). */
  workspaceProvider?: string;
  /** Pre-loaded identity files from host (via stdin payload). Skips filesystem reads when present. */
  identity?: IdentityFiles;
}

/** Sanitize a sender name: only alphanumeric, underscore, dot, dash; max 100 chars. */
function sanitizeSender(sender: string): string {
  return sender.replace(/[^a-zA-Z0-9_.\-]/g, '').slice(0, 100);
}

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
      // Extract text content — image content blocks are handled at the IPC/LLM level.
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
  client: IIPCClient,
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
  let agent: AgentType = 'pi-coding-agent';
  let model = '';
  let ipcSocket = '';
  let proxySocket = '';
  let maxTokens = 0;
  let verbose = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--agent': agent = args[++i] as AgentType; break;
      case '--model': model = args[++i]; break;
      case '--ipc-socket': ipcSocket = args[++i]; break;
      case '--proxy-socket': proxySocket = args[++i]; break;
      case '--max-tokens': maxTokens = parseInt(args[++i], 10) || 0; break;
      case '--verbose': verbose = true; break;
    }
  }

  // Workspace is set via canonical env var by the sandbox provider
  // (e.g. AX_WORKSPACE=/workspace). Identity and skills come via stdin payload now.
  ipcSocket = ipcSocket || process.env.AX_IPC_SOCKET || '';
  const workspace = process.env.AX_WORKSPACE || '';
  const ipcListen = process.env.AX_IPC_LISTEN === '1';

  const isHTTPMode = !!process.env.AX_HOST_URL;

  if (!isHTTPMode && (!ipcSocket || !workspace)) {
    logger.error('missing_args', { message: 'Usage: agent-runner --agent <type> --ipc-socket <path> (AX_WORKSPACE env var required)' });
    process.exit(1);
  }
  if (isHTTPMode && !workspace) {
    logger.error('missing_args', { message: 'AX_HOST_URL requires AX_WORKSPACE env var' });
    process.exit(1);
  }

  return {
    agent, ipcSocket, ipcListen, workspace,
    model: model || undefined,
    proxySocket: proxySocket || undefined,
    maxTokens: maxTokens || undefined,
    verbose,
  };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
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
  /** Session ID from host — used to scope IPC requests (e.g. image generation). */
  sessionId?: string;
  /** HTTP request ID from host — used for event bus routing so SSE subscribers receive events. */
  requestId?: string;
  /** Session scope from channel provider — determines memory scoping (dm = user-scoped, channel = agent-scoped). */
  sessionScope?: 'dm' | 'channel' | 'thread' | 'group';
  /** Per-turn IPC capability token (for NATS subject scoping in k8s mode). */
  ipcToken?: string;
  // Enterprise fields
  agentId?: string;
  agentWorkspace?: string;
  userWorkspace?: string;
  /** Configured workspace provider name (e.g. 'none', 'local', 'gcs'). */
  workspaceProvider?: string;
  /** Pre-loaded identity files from host (loaded from DocumentStore). */
  identity?: Partial<IdentityFiles>;
  /** GCS cache key for workspace restore. */
  workspaceCacheKey?: string;
  /** GCS prefix for agent scope provisioning. */
  agentGcsPrefix?: string;
  /** GCS prefix for user scope provisioning. */
  userGcsPrefix?: string;
  /** GCS prefix for session/scratch scope provisioning. */
  sessionGcsPrefix?: string;
  /** Whether agent scope is read-only (non-admin users). */
  agentReadOnly?: boolean;
  /** Web proxy URL for outbound HTTP/HTTPS (warm pool pods get this from payload, not pod env). */
  webProxyUrl?: string;
  /** Credential placeholder env vars — warm pool pods get these from payload, not pod spec. */
  credentialEnv?: Record<string, string>;
  /** MITM CA cert PEM — written to disk so sandbox processes trust the proxy. */
  caCert?: string;
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
        sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId : undefined,
        requestId: typeof parsed.requestId === 'string' ? parsed.requestId : undefined,
        sessionScope: typeof parsed.sessionScope === 'string' ? parsed.sessionScope as StdinPayload['sessionScope'] : undefined,
        ipcToken: typeof parsed.ipcToken === 'string' ? parsed.ipcToken : undefined,
        // Enterprise fields
        agentId: typeof parsed.agentId === 'string' ? parsed.agentId : undefined,
        agentWorkspace: typeof parsed.agentWorkspace === 'string' ? parsed.agentWorkspace : undefined,
        userWorkspace: typeof parsed.userWorkspace === 'string' ? parsed.userWorkspace : undefined,
        workspaceProvider: typeof parsed.workspaceProvider === 'string' ? parsed.workspaceProvider : undefined,
        // Identity from host (loaded from DocumentStore)
        identity: parsed.identity && typeof parsed.identity === 'object' ? parsed.identity as Partial<IdentityFiles> : undefined,
        // Workspace provisioning fields (sandbox-side providers provision in-pod)
        workspaceCacheKey: typeof parsed.workspaceCacheKey === 'string' ? parsed.workspaceCacheKey : undefined,
        agentGcsPrefix: typeof parsed.agentGcsPrefix === 'string' ? parsed.agentGcsPrefix : undefined,
        userGcsPrefix: typeof parsed.userGcsPrefix === 'string' ? parsed.userGcsPrefix : undefined,
        sessionGcsPrefix: typeof parsed.sessionGcsPrefix === 'string' ? parsed.sessionGcsPrefix : undefined,
        agentReadOnly: parsed.agentReadOnly === true,
        webProxyUrl: typeof parsed.webProxyUrl === 'string' ? parsed.webProxyUrl : undefined,
        credentialEnv: parsed.credentialEnv && typeof parsed.credentialEnv === 'object' && !Array.isArray(parsed.credentialEnv)
          ? parsed.credentialEnv as Record<string, string>
          : undefined,
        caCert: typeof parsed.caCert === 'string' ? parsed.caCert : undefined,
      };
    }
  } catch {
    // Not JSON — fall through to plain text
  }
  return defaults;
}

/**
 * Provision workspace scopes inside the pod (k8s sandbox-side lifecycle).
 * Called after receiving work payload, before running the agent.
 * Writes hash snapshots to /tmp/.ax-hashes.json for the release step.
 */
async function provisionWorkspaceFromPayload(payload: StdinPayload): Promise<void> {
  const { provisionScope } = await import('./workspace.js');
  const { CANONICAL } = await import('../providers/sandbox/canonical-paths.js');
  const snapshot: Record<string, [string, string][]> = {};

  // HTTP provisioning options — in k8s the pod fetches files from the host
  // (the host has GCS credentials, the pod doesn't).
  const hostUrl = process.env.AX_HOST_URL;
  const token = payload.ipcToken ?? process.env.AX_IPC_TOKEN;

  // In k8s mode, always provision all scopes via HTTP when a host URL is available.
  // This doesn't require GCS prefix fields in the payload — the host resolves
  // the GCS paths from its own config. The agentGcsPrefix fields in the payload
  // are only needed for the legacy direct-GCS path (non-k8s).
  if (hostUrl && payload.workspaceProvider === 'gcs') {
    const agentId = payload.agentId ?? 'assistant';
    const userId = payload.userId ?? '';
    const sessionId = payload.sessionId ?? '';
    const httpOpts = (scope: string, id: string) => ({ hostUrl, token, scope, id });

    try {
      const result = await provisionScope(CANONICAL.agent, '', payload.agentReadOnly ?? true, httpOpts('agent', agentId));
      snapshot.agent = [...result.hashes.entries()];
      logger.info('provision_agent_scope', { source: result.source, fileCount: result.fileCount });
    } catch (err) {
      logger.warn('provision_agent_scope_failed', { error: (err as Error).message });
    }

    try {
      const result = await provisionScope(CANONICAL.user, '', false, httpOpts('user', userId));
      snapshot.user = [...result.hashes.entries()];
      logger.info('provision_user_scope', { source: result.source, fileCount: result.fileCount });
    } catch (err) {
      logger.warn('provision_user_scope_failed', { error: (err as Error).message });
    }

    try {
      const result = await provisionScope(CANONICAL.scratch, '', false, httpOpts('session', sessionId));
      snapshot.session = [...result.hashes.entries()];
      logger.info('provision_session_scope', { source: result.source, fileCount: result.fileCount });
    } catch (err) {
      logger.warn('provision_session_scope_failed', { error: (err as Error).message });
    }

    // Write hash snapshot for workspace release to diff against
    if (Object.keys(snapshot).length > 0) {
      try {
        writeFileSync('/tmp/.ax-hashes.json', JSON.stringify(snapshot), 'utf-8');
        logger.debug('hash_snapshot_written', { scopes: Object.keys(snapshot) });
      } catch (err) {
        logger.warn('hash_snapshot_write_failed', { error: (err as Error).message });
      }
    }
    return;
  }

  // Agent scope → /workspace/agent
  if (payload.agentGcsPrefix) {
    try {
      const result = await provisionScope(CANONICAL.agent, payload.agentGcsPrefix, payload.agentReadOnly ?? true, {
        hostUrl, token, scope: 'agent', id: payload.agentId ?? 'assistant',
      });
      snapshot.agent = [...result.hashes.entries()];
      logger.info('provision_agent_scope', { source: result.source, fileCount: result.fileCount });
    } catch (err) {
      logger.warn('provision_agent_scope_failed', { error: (err as Error).message });
    }
  }

  // User scope → /workspace/user
  if (payload.userGcsPrefix) {
    try {
      const result = await provisionScope(CANONICAL.user, payload.userGcsPrefix, false, {
        hostUrl, token, scope: 'user', id: payload.userId ?? '',
      });
      snapshot.user = [...result.hashes.entries()];
      logger.info('provision_user_scope', { source: result.source, fileCount: result.fileCount });
    } catch (err) {
      logger.warn('provision_user_scope_failed', { error: (err as Error).message });
    }
  }

  // Session scope → /workspace/scratch (GCS overlay on top of git workspace)
  if (payload.sessionGcsPrefix) {
    try {
      const result = await provisionScope(CANONICAL.scratch, payload.sessionGcsPrefix, false, {
        hostUrl, token, scope: 'session', id: payload.sessionId ?? '',
      });
      snapshot.session = [...result.hashes.entries()];
      logger.info('provision_session_scope', { source: result.source, fileCount: result.fileCount });
    } catch (err) {
      logger.warn('provision_session_scope_failed', { error: (err as Error).message });
    }
  }

  // Write hash snapshot for workspace release to diff against
  if (Object.keys(snapshot).length > 0) {
    try {
      writeFileSync('/tmp/.ax-hashes.json', JSON.stringify(snapshot), 'utf-8');
      logger.debug('hash_snapshot_written', { scopes: Object.keys(snapshot) });
    } catch (err) {
      logger.warn('hash_snapshot_write_failed', { error: (err as Error).message });
    }
  }
}

/**
 * Dispatch to the appropriate agent implementation based on config.agent.
 */
export async function run(config: AgentConfig): Promise<void> {
  const agent = config.agent ?? 'pi-coding-agent';
  process.stderr.write(`[diag] dispatch agent=${agent}\n`);
  logger.debug('dispatch', { agent, workspace: config.workspace, ipcSocket: config.ipcSocket });
  switch (agent) {
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

/**
 * Apply a parsed StdinPayload to the AgentConfig.
 * Shared between stdin and NATS work dispatch paths.
 */
function applyPayload(config: AgentConfig, payload: StdinPayload): void {
  const msgText = typeof payload.message === 'string' ? payload.message : extractText(payload.message);
  logger.debug('payload_parsed', {
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
  config.sessionId = payload.sessionId;
  config.requestId = payload.requestId;
  config.sessionScope = payload.sessionScope;
  // Update the IPC client with session context from the payload.
  if (config.ipcClient) {
    config.ipcClient.setContext({
      sessionId: payload.sessionId,
      requestId: payload.requestId,
      userId: payload.userId,
      sessionScope: payload.sessionScope,
      token: payload.ipcToken,
    });
  }
  // IPC token — warm pool pods don't have AX_IPC_TOKEN in their pod spec,
  // so the host sends it in the payload. Set it in process.env so workspace-release.ts
  // can use it for direct HTTP release (bypassing the legacy staging path).
  if (payload.ipcToken && !process.env.AX_IPC_TOKEN) {
    process.env.AX_IPC_TOKEN = payload.ipcToken;
  }

  // Web proxy URL — warm pool pods don't have AX_WEB_PROXY_URL in their pod spec,
  // so the host sends it in the payload. Set it in process.env so the runner picks it up.
  if (payload.webProxyUrl && !process.env.AX_WEB_PROXY_URL) {
    process.env.AX_WEB_PROXY_URL = payload.webProxyUrl;
    logger.info('web_proxy_url_set', { source: 'payload', url: payload.webProxyUrl });
  } else if (process.env.AX_WEB_PROXY_URL) {
    logger.info('web_proxy_url_set', { source: 'env', url: process.env.AX_WEB_PROXY_URL });
  } else if (payload.webProxyUrl) {
    logger.debug('web_proxy_url_skip', { reason: 'already_set', env: process.env.AX_WEB_PROXY_URL });
  } else {
    logger.debug('web_proxy_url_absent', { envSet: !!process.env.AX_WEB_PROXY_URL, payloadSet: !!payload.webProxyUrl });
  }
  // Credential placeholder env vars — warm pool pods don't have these in their pod spec,
  // so the host sends them in the payload. The MITM proxy replaces placeholders with real
  // values in intercepted HTTPS traffic.
  if (payload.credentialEnv) {
    for (const [key, value] of Object.entries(payload.credentialEnv)) {
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
    logger.info('credential_env_set', { count: Object.keys(payload.credentialEnv).length });
  }

  // MITM CA cert — write to disk so tools trust the proxy's TLS certs.
  // Node.js uses NODE_EXTRA_CA_CERTS (MITM CA only — appended to built-in bundle).
  // curl/wget/openssl use SSL_CERT_FILE (must be a complete bundle: system CAs + MITM CA).
  // These MUST be separate files since NODE_EXTRA_CA_CERTS is additive but SSL_CERT_FILE replaces.
  if (payload.caCert) {
    try {
      // Write MITM CA for Node.js — always use /tmp to avoid permission issues
      const mitmCaPath = '/tmp/ax-mitm-ca.pem';
      writeFileSync(mitmCaPath, payload.caCert);
      process.env.NODE_EXTRA_CA_CERTS = mitmCaPath;

      // Build combined CA bundle for curl/wget/openssl/etc.
      const combinedPath = '/tmp/ax-ca-bundle.pem';
      const systemBundle = '/etc/ssl/certs/ca-certificates.crt';
      if (existsSync(systemBundle)) {
        const combined = readFileSync(systemBundle, 'utf-8') + '\n' + payload.caCert;
        writeFileSync(combinedPath, combined);
      } else {
        writeFileSync(combinedPath, payload.caCert);
      }
      process.env.SSL_CERT_FILE = combinedPath;
      process.env.REQUESTS_CA_BUNDLE = combinedPath;
      process.env.CURL_CA_BUNDLE = combinedPath;
      logger.info('ca_cert_written', { nodeCa: mitmCaPath, sslCertFile: combinedPath });
    } catch (err) {
      logger.warn('ca_cert_write_failed', { error: (err as Error).message });
    }
  }

  // Enterprise fields — prefer canonical env vars (set by sandbox provider)
  // over payload (which carries host paths).
  config.agentId = payload.agentId;
  config.agentWorkspace = process.env.AX_AGENT_WORKSPACE || payload.agentWorkspace;
  config.userWorkspace = process.env.AX_USER_WORKSPACE || payload.userWorkspace;
  config.workspaceProvider = payload.workspaceProvider;
  // Identity from host (loaded from DocumentStore; skills are now filesystem-based)
  if (payload.identity) {
    config.identity = {
      agents: payload.identity.agents ?? '',
      soul: payload.identity.soul ?? '',
      identity: payload.identity.identity ?? '',
      user: payload.identity.user ?? '',
      bootstrap: payload.identity.bootstrap ?? '',
      userBootstrap: payload.identity.userBootstrap ?? '',
      heartbeat: payload.identity.heartbeat ?? '',
    };
  }
}

/**
 * NATS work subscription: subscribe to sandbox.work with a queue group so NATS
 * delivers work to exactly one warm pod per tier. Replaces the old per-pod
 * subject (agent.work.{podName}) — no k8s API label-patch claiming needed.
 */
export async function waitForNATSWork(): Promise<string> {
  const podName = process.env.POD_NAME ?? 'unknown';
  const tier = process.env.SANDBOX_TIER ?? 'light';

  const natsModule = await import('nats');
  const { natsConnectOptions } = await import('../utils/nats.js');
  const nc = await natsModule.connect(natsConnectOptions('runner', podName));

  // Queue group subscription: NATS delivers to exactly one subscriber per tier
  const sub = nc.subscribe('sandbox.work', { max: 1, queue: tier });
  logger.info('nats_work_waiting', { subject: 'sandbox.work', queue: tier, podName });
  process.stderr.write(`[diag] waiting for work on sandbox.work (queue: ${tier})\n`);

  for await (const msg of sub) {
    const data = new TextDecoder().decode(msg.data);
    logger.info('nats_work_received', { queue: tier, bytes: data.length });
    process.stderr.write(`[diag] work received: ${data.length} bytes\n`);

    // Reply with podName so host can track which pod is processing
    if (msg.reply) {
      msg.respond(new TextEncoder().encode(JSON.stringify({ podName })));
    }

    await nc.drain();
    return data;
  }

  await nc.drain();
  throw new Error('NATS work subscription ended without receiving a message');
}

// Run if this is the main module
const isMain = process.argv[1]?.endsWith('runner.js') ||
               process.argv[1]?.endsWith('runner.ts');
if (isMain) {
  const config = parseArgs();
  logger.debug('main_start', { agent: config.agent, workspace: config.workspace });

  // Choose IPC transport. Three modes:
  // 1. HTTP (k8s): AX_HOST_URL set → HttpIPCClient + NATS queue group for work dispatch
  // 2. Listen (Apple Container): AX_IPC_LISTEN=1 → listen for incoming connection before stdin
  // 3. Default (socket connect): runners create their own IPCClient later
  const isHTTPMode = !!process.env.AX_HOST_URL;

  if (isHTTPMode) {
    // K8s HTTP mode: use HttpIPCClient for IPC, NATS only for work dispatch.
    const { HttpIPCClient } = await import('./http-ipc-client.js');
    const client = new HttpIPCClient({
      hostUrl: process.env.AX_HOST_URL!,
    });
    await client.connect();
    config.ipcClient = client;

    // Wait for work payload via NATS queue group
    waitForNATSWork().then(async (data) => {
      const payload = parseStdinPayload(data);
      applyPayload(config, payload);

      // Sandbox-side workspace lifecycle: provision before agent runs
      await provisionWorkspaceFromPayload(payload);

      return run(config);
    }).catch((err) => {
      logger.error('main_error', { error: (err as Error).message, stack: (err as Error).stack });
      process.exitCode = 1;
      process.stderr.write(`Agent runner error: ${(err as Error).message ?? err}\n`);
    });
  } else {
    if (config.ipcListen) {
      // Apple Container: listen mode — start the IPC listener BEFORE reading
      // stdin. The host waits for "[signal] ipc_ready" in stderr before connecting
      // the bridge — the runtime only forwards connections when the container-side
      // listener exists. Starting before stdin maximizes boot time.
      const client = new IPCClient({ socketPath: config.ipcSocket, listen: true });
      client.connect().then(() => {
        logger.debug('ipc_listen_ready', { socketPath: config.ipcSocket });
      }).catch((err) => {
        logger.error('ipc_listen_failed', { error: (err as Error).message });
        process.exitCode = 1;
      });
      config.ipcClient = client;
    }

    readStdin().then((data) => {
      const payload = parseStdinPayload(data);
      applyPayload(config, payload);
      return run(config);
    }).catch((err) => {
      logger.error('main_error', { error: (err as Error).message, stack: (err as Error).stack });
      process.exitCode = 1;
      process.stderr.write(`Agent runner error: ${(err as Error).message ?? err}\n`);
    });
  }
}
