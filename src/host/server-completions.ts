/**
 * Completion processing — the core pipeline from inbound message to agent
 * response. Handles workspace setup, skills refresh, history loading,
 * agent spawning, outbound scanning, and memory persistence.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { workspaceDir, agentWorkspaceDir, userWorkspaceDir, agentDir } from '../paths.js';
import { createCanonicalSymlinks } from '../providers/sandbox/canonical-paths.js';
import { isAdmin } from './server-admin-helpers.js';
import type { Config, ProviderRegistry, ContentBlock, ImageMimeType } from '../types.js';
import { safePath } from '../utils/safe-path.js';
import type { InboundMessage } from '../providers/channel/types.js';
import { deserializeContent } from '../utils/content-serialization.js';
import type { ConversationStoreProvider, DocumentStore, MessageQueueStore } from '../providers/storage/types.js';
import type { Router } from './router.js';
import { TaintBudget, thresholdForProfile } from './taint-budget.js';
import { type Logger, truncate } from '../logger.js';
import { drainGeneratedImages } from './ipc-handlers/image.js';
import { startAnthropicProxy } from './proxy.js';
import { startWebProxy, type WebProxy } from './web-proxy.js';
import { CredentialPlaceholderMap } from './credential-placeholders.js';
import { getOrCreateCA, type CAKeyPair } from './proxy-ca.js';
import { connectIPCBridge } from './ipc-server.js';
import { diagnoseError } from '../errors.js';
import { ensureOAuthTokenFreshViaProvider, ensureOAuthTokenFresh, refreshOAuthTokenFromEnv, forceRefreshOAuthViaProvider } from '../dotenv.js';
import { runnerPath as resolveRunnerPath, tsxLoader, isDevMode } from '../utils/assets.js';
import type { OpenAIChatRequest } from './server-http.js';
import type { FileStore } from '../file-store.js';
import type { EventBus } from './event-bus.js';
import { maybeSummarizeHistory, type SummarizationConfig } from './history-summarizer.js';
import { recallMemoryForMessage, type MemoryRecallConfig } from './memory-recall.js';
import { createEmbeddingClient } from '../utils/embedding-client.js';
import { credentialScope, setSessionCredentialContext } from './credential-scopes.js';
import { generateSessionTitle } from './session-title.js';

// ── Agent spawn retry ──
const MAX_AGENT_RETRIES = 2;
const AGENT_RETRY_DELAY_MS = 1000;

export interface CompletionDeps {
  config: Config;
  providers: ProviderRegistry;
  db: MessageQueueStore;
  conversationStore: ConversationStoreProvider;
  router: Router;
  taintBudget: TaintBudget;
  sessionCanaries: Map<string, string>;
  ipcSocketPath: string;
  ipcSocketDir: string;
  logger: Logger;
  verbose?: boolean;
  fileStore?: FileStore;
  eventBus?: EventBus;
  /** Maps sessionId → workspace directory path. Shared with sandbox tool IPC handlers. */
  workspaceMap?: Map<string, string>;
  /** Tracks credential_request IPC calls per session. Consumed by post-agent credential loop. */
  requestedCredentials?: Map<string, Set<string>>;
  /** IPC handler function for reverse bridge connections (Apple containers). */
  ipcHandler?: (raw: string, ctx: import('./ipc-server.js').IPCContext) => Promise<string>;
  /** Extra env vars to inject into sandbox pods (per-turn IPC token, request ID). */
  extraSandboxEnv?: Record<string, string>;
  /** Promise that resolves with the agent response content (NATS mode).
   *  When set, processCompletion waits on this instead of reading stdout. */
  agentResponsePromise?: Promise<string>;
  /** Callback to publish work payload via NATS (k8s mode).
   *  If podName is undefined, uses queue group (warm pool) — returns the claiming pod's name.
   *  If podName is set, publishes to that specific pod (cold start fallback). */
  publishWork?: (podName: string | undefined, payload: string) => Promise<string>;
  /** Shared credential registry for k8s shared proxy MITM mode.
   *  Per-session credential maps are registered/deregistered here so the
   *  shared proxy can replace placeholders from any active session. */
  sharedCredentialRegistry?: import('./credential-placeholders.js').SharedCredentialRegistry;
  /** Domain allowlist for proxy — populated from installed skill manifests. */
  domainList?: import('./proxy-domain-list.js').ProxyDomainList;
  /** Callback to start the agent_response timeout timer (NATS mode).
   *  Called after work is published so the timer doesn't include pre-processing time
   *  (scanner LLM calls, workspace provisioning, etc.). */
  startAgentResponseTimer?: () => void;
}

export interface ExtractedFile {
  fileId: string;
  mimeType: string;
  data: Buffer;
}

export interface CompletionResult {
  responseContent: string;
  /** Structured content blocks with file refs (present when response includes images). */
  contentBlocks?: ContentBlock[];
  /** Raw file buffers extracted from image_data blocks, keyed by fileId. */
  extractedFiles?: ExtractedFile[];
  /** Agent name that processed this request (for file URL construction). */
  agentName?: string;
  /** User ID that owns the workspace (for file URL construction). */
  userId?: string;
  finishReason: 'stop' | 'content_filter';
}

/** MIME type to file extension mapping. */
const MIME_TO_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

// ── Identity/Skills types for stdin payload ──

/** Identity fields loaded from DocumentStore, keyed by filename. */
export interface IdentityPayload {
  agents?: string;
  soul?: string;
  identity?: string;
  user?: string;
  bootstrap?: string;
  userBootstrap?: string;
  heartbeat?: string;
}

/** Map from identity filename (without .md) to the corresponding IdentityPayload field. */
const IDENTITY_FILE_MAP: Record<string, keyof IdentityPayload> = {
  'AGENTS.md': 'agents',
  'SOUL.md': 'soul',
  'IDENTITY.md': 'identity',
  'USER.md': 'user',
  'BOOTSTRAP.md': 'bootstrap',
  'USER_BOOTSTRAP.md': 'userBootstrap',
  'HEARTBEAT.md': 'heartbeat',
};


/**
 * Resolve the GCS object-key prefixes used for in-pod workspace provisioning.
 *
 * Rules:
 *  - Only runs when the workspace provider is 'gcs' — no-op for 'none'/'local'.
 *  - `config.workspace.prefix` is authoritative (same source as gcs.ts createRemoteTransport).
 *  - Falls back to `AX_WORKSPACE_GCS_PREFIX` env var for backward compat.
 *  - Empty-string prefix is valid (files live at bucket root) — mirrors gcs.ts default.
 *  - Trailing slash is normalised the same way as buildGcsPrefix in gcs.ts.
 */
export function resolveWorkspaceGcsPrefixes(
  config: Config,
  agentName: string,
  userId: string,
  sessionId: string,
): { agentGcsPrefix?: string; userGcsPrefix?: string; sessionGcsPrefix?: string } {
  // Only GCS workspace provider stores files in GCS that can be provisioned.
  if (config.providers.workspace !== 'gcs') return {};

  // Mirror gcs.ts: `wsConfig.prefix ?? ''` — empty string is a valid prefix
  // meaning files live directly under the bucket root.
  const rawPrefix = config.workspace?.prefix ?? process.env.AX_WORKSPACE_GCS_PREFIX ?? '';

  // Mirror buildGcsPrefix trailing-slash normalisation in gcs.ts.
  const base = rawPrefix.endsWith('/') ? rawPrefix : rawPrefix ? `${rawPrefix}/` : '';

  return {
    agentGcsPrefix:   `${base}agent/${agentName}/`,
    userGcsPrefix:    `${base}user/${userId}/`,
    sessionGcsPrefix: `${base}scratch/${sessionId}/`,
  };
}

/**
 * Load identity files from DocumentStore for a given agent and user.
 * Returns an IdentityPayload with fields populated from matching documents.
 */
async function loadIdentityFromDB(
  documents: DocumentStore,
  agentName: string,
  userId: string,
  logger: Logger,
): Promise<IdentityPayload> {
  const identity: IdentityPayload = {};

  try {
    const allKeys = await documents.list('identity');
    const agentPrefix = `${agentName}/`;
    const userPrefix = `${agentName}/users/${userId}/`;

    // Load agent-level identity files
    for (const key of allKeys) {
      if (!key.startsWith(agentPrefix)) continue;
      // Skip user-level keys at this stage
      if (key.includes('/users/')) continue;

      const filename = key.slice(agentPrefix.length);
      const field = IDENTITY_FILE_MAP[filename];
      if (field) {
        const content = await documents.get('identity', key);
        if (content) {
          identity[field] = content;
        }
      }
    }

    // Load user-level identity files (e.g. USER.md)
    for (const key of allKeys) {
      if (!key.startsWith(userPrefix)) continue;

      const filename = key.slice(userPrefix.length);
      const field = IDENTITY_FILE_MAP[filename];
      if (field) {
        const content = await documents.get('identity', key);
        if (content) {
          identity[field] = content;
        }
      }
    }
  } catch (err) {
    logger.warn('identity_load_failed', { error: (err as Error).message });
  }

  return identity;
}

/**
 * Try to parse structured agent output.
 * If stdout starts with {"__ax_response":, treat it as structured content
 * containing text and image blocks. Otherwise, treat as plain text.
 */
function parseAgentResponse(raw: string): { text: string; blocks?: ContentBlock[] } {
  const trimmed = raw.trimStart();
  if (trimmed.startsWith('{"__ax_response":')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed.__ax_response?.content && Array.isArray(parsed.__ax_response.content)) {
        const blocks = parsed.__ax_response.content as ContentBlock[];
        const text = blocks
          .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
          .map(b => b.text)
          .join('');
        return { text, blocks };
      }
    } catch {
      // Not valid structured response — fall through to plain text
    }
  }
  return { text: raw };
}

/**
 * Extract image_data blocks from content: decode base64, save to workspace,
 * replace with image file-ref blocks. Returns converted blocks and the
 * extracted file Buffers (for direct use by channels without re-reading disk).
 *
 * image_data blocks are transient — they must never be stored in the
 * conversation store or sent to clients. This function is the single
 * conversion point from inline data to file references.
 */
export function extractImageDataBlocks(
  blocks: ContentBlock[],
  wsDir: string,
  logger: Logger,
): { blocks: ContentBlock[]; extractedFiles: ExtractedFile[] } {
  const hasImageData = blocks.some(b => b.type === 'image_data');
  if (!hasImageData) return { blocks, extractedFiles: [] };

  const filesDir = safePath(wsDir, 'files');
  mkdirSync(filesDir, { recursive: true });

  const converted: ContentBlock[] = [];
  const extractedFiles: ExtractedFile[] = [];

  for (const block of blocks) {
    if (block.type === 'image_data') {
      try {
        const buf = Buffer.from(block.data, 'base64');
        const ext = MIME_TO_EXT[block.mimeType] ?? '.bin';
        const filename = `${randomUUID()}${ext}`;
        const filePath = safePath(filesDir, filename);
        writeFileSync(filePath, buf);

        const fileId = `files/${filename}`;
        converted.push({
          type: 'image',
          fileId,
          mimeType: block.mimeType as ImageMimeType,
        });
        extractedFiles.push({ fileId, mimeType: block.mimeType, data: buf });
      } catch (err) {
        logger.warn('image_data_extract_failed', {
          mimeType: block.mimeType,
          error: (err as Error).message,
        });
      }
    } else {
      converted.push(block);
    }
  }

  return { blocks: converted, extractedFiles };
}

export async function processCompletion(
  deps: CompletionDeps,
  content: string | ContentBlock[],
  requestId: string,
  clientMessages: { role: string; content: string | ContentBlock[] }[] = [],
  persistentSessionId?: string,
  preProcessed?: { sessionId: string; messageId: string; canaryToken: string },
  userId?: string,
  replyOptional?: boolean,
  sessionScope?: 'dm' | 'channel' | 'thread' | 'group',
): Promise<CompletionResult> {
  const { config, providers, db, conversationStore, router, taintBudget, sessionCanaries, ipcSocketPath, ipcSocketDir, logger, eventBus } = deps;
  const sessionId = preProcessed?.sessionId ?? persistentSessionId ?? randomUUID();
  const reqLogger = logger.child({ reqId: requestId.slice(-8) });

  // Extract text for scanning/logging; structured content may contain image refs
  const textContent = typeof content === 'string'
    ? content
    : content.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join('\n');

  reqLogger.debug('completion_start', {
    sessionId,
    contentLength: textContent.length,
    contentPreview: truncate(textContent, 200),
    historyTurns: clientMessages.length,
  });

  // Emit completion.start event
  eventBus?.emit({
    type: 'completion.start',
    requestId,
    timestamp: Date.now(),
    data: { sessionId, contentLength: textContent.length, historyTurns: clientMessages.length },
  });

  let result: import('./router.js').RouterResult;

  if (preProcessed) {
    // Channel/scheduler path: message already scanned and enqueued by caller
    result = {
      queued: true,
      messageId: preProcessed.messageId,
      sessionId: preProcessed.sessionId,
      canaryToken: preProcessed.canaryToken,
      scanResult: { verdict: 'PASS' },
    };
    reqLogger.debug('scan_inbound', { status: 'clean' });
    reqLogger.debug('inbound_clean', { messageId: result.messageId });
  } else {
    // HTTP API path: scan and enqueue here
    const inbound: InboundMessage = {
      id: sessionId,
      session: { provider: 'http', scope: 'dm', identifiers: { peer: 'client' } },
      sender: 'client',
      content: textContent,
      attachments: [],
      timestamp: new Date(),
    };

    result = await router.processInbound(inbound);

    if (!result.queued) {
      reqLogger.debug('inbound_blocked', { reason: result.scanResult.reason });
      reqLogger.warn('scan_inbound', { status: 'blocked', reason: result.scanResult.reason ?? 'scan failed' });
      eventBus?.emit({
        type: 'scan.inbound',
        requestId,
        timestamp: Date.now(),
        data: { verdict: 'BLOCK', reason: result.scanResult.reason },
      });
      return {
        responseContent: `Request blocked: ${result.scanResult.reason ?? 'security scan failed'}`,
        finishReason: 'content_filter',
      };
    }

    reqLogger.debug('scan_inbound', { status: 'clean' });
    sessionCanaries.set(result.sessionId, result.canaryToken);
    reqLogger.debug('inbound_clean', { messageId: result.messageId });
    eventBus?.emit({
      type: 'scan.inbound',
      requestId,
      timestamp: Date.now(),
      data: { verdict: 'PASS' },
    });
  }

  // Dequeue the specific message we just enqueued (by ID, not FIFO)
  const queued = result.messageId ? await db.dequeueById(result.messageId) : await db.dequeue();
  if (!queued) {
    reqLogger.debug('dequeue_failed', { messageId: result.messageId });
    return { responseContent: 'Internal error: message not queued', finishReason: 'stop' };
  }

  let workspace = '';
  const isPersistent = !!persistentSessionId;
  let proxyCleanup: (() => void) | undefined;
  let webProxyCleanup: (() => void) | undefined;
  let toolMountRoot: { mountRoot: string; cleanup: () => void } | undefined;
  const agentName = config.agent_name ?? 'main';
  const currentUserId = userId ?? process.env.USER ?? 'default';

  // Register session context so the credential provide endpoint can resolve
  // agentName/userId from just a sessionId (client doesn't send these).
  setSessionCredentialContext(sessionId, { agentName, userId: currentUserId });

  try {
    if (persistentSessionId) {
      workspace = workspaceDir(persistentSessionId);
      mkdirSync(workspace, { recursive: true });
    } else {
      workspace = mkdtempSync(join(tmpdir(), 'ax-ws-'));
    }

    // Register workspace for sandbox tool IPC handlers.
    // The agent sends sessionId in IPC calls (_sessionId field),
    // so handlers can look up the workspace by sessionId.
    if (deps.workspaceMap) {
      deps.workspaceMap.set(sessionId, workspace);
    }

    // Build conversation history: prefer DB-persisted history for persistent sessions,
    // fall back to client-provided history for ephemeral sessions.
    let history: { role: 'user' | 'assistant'; content: string | ContentBlock[]; sender?: string }[] = [];
    const maxTurns = config.history.max_turns;

    if (persistentSessionId && maxTurns > 0) {
      // maxTurns=0 disables history entirely (no loading, no saving).
      // Load persisted history from DB
      const storedTurns = await conversationStore.load(persistentSessionId, maxTurns);

      // For thread sessions, prepend context from the parent channel session
      if (persistentSessionId.includes(':thread:') && config.history.thread_context_turns > 0) {
        // Derive parent session ID: replace :thread:...:threadTs with :channel:...
        const parts = persistentSessionId.split(':');
        const scopeIdx = parts.indexOf('thread');
        if (scopeIdx >= 0) {
          const parentParts = [...parts];
          parentParts[scopeIdx] = 'channel';
          // Remove the thread timestamp (last identifier after channel)
          parentParts.splice(scopeIdx + 2); // keep provider:channel:channelId
          const parentSessionId = parentParts.join(':');

          const parentTurns = await conversationStore.load(parentSessionId, config.history.thread_context_turns);

          // Dedup: if last parent turn matches first thread turn (same content+sender), skip it
          if (parentTurns.length > 0 && storedTurns.length > 0) {
            const lastParent = parentTurns[parentTurns.length - 1];
            const firstThread = storedTurns[0];
            if (lastParent.content === firstThread.content && lastParent.sender === firstThread.sender) {
              parentTurns.pop();
            }
          }

          // Prepend parent context before thread history
          const parentHistory = parentTurns.map(t => ({
            role: t.role as 'user' | 'assistant',
            content: deserializeContent(t.content),
            ...(t.sender ? { sender: t.sender } : {}),
          }));
          history.push(...parentHistory);
        }
      }

      // Add the session's own history (deserialize to preserve image blocks)
      history.push(...storedTurns.map(t => ({
        role: t.role as 'user' | 'assistant',
        content: deserializeContent(t.content),
        ...(t.sender ? { sender: t.sender } : {}),
      })));
    } else {
      // Ephemeral: use client-provided history (minus the current message)
      history = clientMessages.slice(0, -1).map(m => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      }));
    }

    // Inject long-term memory recall as the oldest context turns.
    // Prefers embedding-based semantic search; falls back to keyword search
    // when no OPENAI_API_KEY is available.
    const embeddingClient = createEmbeddingClient({
      model: config.history.embedding_model,
      dimensions: config.history.embedding_dimensions,
    });
    const recallConfig: MemoryRecallConfig = {
      enabled: config.history.memory_recall,
      limit: config.history.memory_recall_limit,
      scope: config.history.memory_recall_scope,
      embeddingClient,
      userId: currentUserId,
      sessionScope: sessionScope,
    };
    if (recallConfig.enabled) {
      try {
        const recallTurns = await recallMemoryForMessage(
          textContent, providers.memory, recallConfig, reqLogger,
        );
        if (recallTurns.length > 0) {
          history.unshift(...recallTurns);
        }
      } catch (err) {
        reqLogger.warn('memory_recall_error', { error: (err as Error).message });
      }
    }

    // Spawn sandbox — run agent with plain `node`, never through the tsx
    // binary wrapper (which spawns an extra child process whose signal relay
    // fails with EPERM on macOS, leaving orphaned grandchild processes).
    //
    // Dev mode:  node --import <tsx-esm-loader> src/agent/runner.ts
    //   → single process, source changes picked up without rebuilding.
    // Production: node dist/agent/runner.js
    //   → no tsx dependency, no extra process layers.
    const agentType = config.agent ?? 'pi-coding-agent';

    // Start credential-injecting proxy for claude-code agents only.
    // claude-code talks to Anthropic directly via the proxy; all other agents
    // route LLM calls through IPC to the host-side LLM router.
    let proxySocketPath: string | undefined;
    const needsAnthropicProxy = agentType === 'claude-code';
    if (needsAnthropicProxy) {
      // Refresh OAuth token if expired or expiring (pre-flight check).
      // Handles 99% of cases where token expires between conversation turns.
      // Use credential-provider-aware refresh when available.
      if (providers.credentials) {
        await ensureOAuthTokenFreshViaProvider(providers.credentials);
      } else {
        await ensureOAuthTokenFresh();
      }

      // Fail fast if no credentials are available — don't spawn an agent
      // that will just retry 401s with exponential backoff for minutes.
      const hasApiKey = !!process.env.ANTHROPIC_API_KEY;
      const hasOAuthToken = !!process.env.CLAUDE_CODE_OAUTH_TOKEN;
      if (!hasApiKey && !hasOAuthToken) {
        await db.fail(queued.id);
        return {
          responseContent: 'No API credentials configured. Run `ax configure` to set up authentication.',
          finishReason: 'stop',
        };
      }

      proxySocketPath = join(ipcSocketDir, 'anthropic-proxy.sock');
      const proxy = startAnthropicProxy(proxySocketPath!, undefined, async () => {
        if (providers.credentials) {
          await forceRefreshOAuthViaProvider(providers.credentials);
        } else {
          await refreshOAuthTokenFromEnv();
        }
      });
      proxyCleanup = proxy.stop;
    }

    // Start web forward proxy for outbound HTTP/HTTPS access (npm install,
    // pip install, curl, git clone). Opt-in: only when config.web_proxy is truthy.
    // Container sandboxes get a Unix socket; subprocess mode gets a TCP port.
    // The credential map is populated by reference later (after agentWsPath is set),
    // so the proxy will see the registered credentials when handling requests.
    let webProxySocketPath: string | undefined;
    let webProxyPort: number | undefined;
    const credentialMap = new CredentialPlaceholderMap();
    const credentialEnv: Record<string, string> = {};
    let caCertPem: string | undefined;
    // Register in the shared registry so k8s shared proxy can see this session's credentials
    if (deps.sharedCredentialRegistry) {
      deps.sharedCredentialRegistry.register(sessionId, credentialMap);
    }
    if (config.web_proxy) {
      const canaryToken = sessionCanaries.get(queued.session_id) ?? undefined;
      const isContainerSandboxForProxy = new Set(['docker', 'apple']).has(config.providers.sandbox);
      const webProxyAudit = (entry: import('./web-proxy.js').ProxyAuditEntry) => {
        providers.audit.log({
          action: entry.action,
          sessionId: entry.sessionId,
          args: { method: entry.method, url: entry.url, status: entry.status, requestBytes: entry.requestBytes, responseBytes: entry.responseBytes, blocked: entry.blocked },
          result: entry.blocked ? 'blocked' : 'success',
          durationMs: entry.durationMs,
        }).catch(() => {});
      };
      // Generate MITM CA — always create it upfront so we can pass it to the proxy.
      // Credentials are registered later (after agentWsPath is set) by reference.
      const caDir = join(agentDir(agentName), 'ca');
      const ca = await getOrCreateCA(caDir);
      caCertPem = ca.cert;
      const mitmConfig = {
        ca,
        credentials: credentialMap,
        bypassDomains: new Set(config.mitm_bypass_domains ?? []),
      };
      const allowedDomains = deps.domainList ? { has: (d: string) => deps.domainList!.isAllowed(d) } : undefined;
      const onDenied = (domain: string) => deps.domainList?.addPending(domain, sessionId);
      const urlRewrites = config.url_rewrites
        ? new Map(Object.entries(config.url_rewrites))
        : undefined;

      if (isContainerSandboxForProxy) {
        // Unix socket mode — placed in same dir as IPC socket (already mounted)
        webProxySocketPath = join(ipcSocketDir, 'web-proxy.sock');
        const webProxy = await startWebProxy({
          listen: webProxySocketPath,
          sessionId, canaryToken, onAudit: webProxyAudit,
          allowedDomains, onDenied, mitm: mitmConfig, urlRewrites,
        });
        webProxyCleanup = webProxy.stop;
      } else {
        // TCP mode — subprocess or k8s (k8s uses separate port in host-process.ts)
        const webProxy = await startWebProxy({
          listen: 0,
          sessionId, canaryToken, onAudit: webProxyAudit,
          allowedDomains, onDenied, mitm: mitmConfig, urlRewrites,
        });
        webProxyPort = webProxy.address as number;
        webProxyCleanup = webProxy.stop;
      }

      // Inject CA trust env vars so sandbox processes trust the proxy's certs
      const isContainerSandbox = new Set(['docker', 'apple', 'k8s']).has(config.providers.sandbox);
      const caCertPath = join(caDir, 'ca.crt');
      const sandboxCaCertPath = isContainerSandbox ? '/etc/ax/ca.crt' : caCertPath;
      credentialEnv.NODE_EXTRA_CA_CERTS = sandboxCaCertPath;
      credentialEnv.SSL_CERT_FILE = sandboxCaCertPath;
      credentialEnv.REQUESTS_CA_BUNDLE = sandboxCaCertPath;
    }

    const maxTokens = config.max_tokens ?? 8192;

    // Workspace is NOT passed as a CLI arg — it's set via canonical env vars
    // by the sandbox provider (e.g. AX_WORKSPACE=/workspace).
    // Identity and skills come via stdin payload from DocumentStore.
    //
    // Container-based sandboxes (docker, apple, k8s) run inside an OCI image
    // with its own Node binary and pre-built runner at /opt/ax/dist/agent/runner.js.
    // Host paths (process.execPath, tsx loader, etc.) don't exist in the container.
    const CONTAINER_SANDBOXES = new Set(['docker', 'apple', 'k8s']);
    const isContainerSandbox = CONTAINER_SANDBOXES.has(config.providers.sandbox);

    // The agent process runs inside the container for all container sandboxes
    // (docker, apple, k8s). The sandbox provider's spawn() handles network
    // isolation, resource limits, and volume mounts. Tool calls (sandbox_bash)
    // spawn separate ephemeral containers via the host.
    const agentSandbox = providers.sandbox;

    // agentInContainer: true when the agent itself runs in a container.
    // All container sandboxes now run the agent in-container.
    const agentInContainer = isContainerSandbox;

    // K8s pod `command` overrides the image ENTRYPOINT, so we must include
    // `node` explicitly. Docker/Apple pass args to the ENTRYPOINT (node),
    // so including `node` would double-invoke it (node node runner.js).
    const isK8s = config.providers.sandbox === 'k8s';
    const spawnCommand = agentInContainer
      ? [...(isK8s ? ['node'] : []), '/opt/ax/dist/agent/runner.js']
      : [process.execPath,
          // Dev mode: load tsx ESM loader so the .ts runner source is compiled on
          // the fly. Production: run compiled dist/agent/runner.js directly.
          ...(isDevMode() ? ['--import', tsxLoader()] : []),
          resolveRunnerPath(),
        ];

    spawnCommand.push(
      '--agent', agentType,
      // Container sandboxes set AX_IPC_SOCKET via env var (the sandbox provider
      // controls the path inside the container). Host-side sandboxes need the
      // CLI arg because they don't remap the socket path.
      ...(!agentInContainer ? ['--ipc-socket', ipcSocketPath] : []),
      '--max-tokens', String(maxTokens),
      ...(proxySocketPath ? ['--proxy-socket', proxySocketPath] : []),
      ...(deps.verbose ? ['--verbose'] : []),
    );

    reqLogger.debug('agent_spawn', {
      agentType,
      workspace,
      command: spawnCommand.join(' '),
      timeoutSec: config.sandbox.timeout_sec,
      memoryMB: config.sandbox.memory_mb,
    });

    // Enterprise: set up workspace directories.
    // When workspace provider is active (not 'none'), pre-mount agent+user scopes
    // and use the provider's directories (writable). Otherwise fall back to
    // the legacy read-only enterprise paths.
    const hasWorkspaceProvider = config.providers.workspace && config.providers.workspace !== 'none';
    let agentWsPath: string | undefined;
    let userWsPath: string | undefined;
    let agentWorkspaceWritable = false;
    let userWorkspaceWritable = false;

    if (hasWorkspaceProvider) {
      // Pre-mount agent, user, and session scopes so their directories exist before sandbox spawn.
      // Session scope backs scratch with GCS — in k8s mode, scratch content survives pod restarts.
      try {
        const mountOpts = { userId: currentUserId };
        const preMounted = await providers.workspace.mount(sessionId, ['agent', 'user', 'session'], mountOpts);
        agentWsPath = preMounted.paths.agent;
        userWsPath = preMounted.paths.user;
        // Use session scope path as scratch workspace — GCS-backed in k8s mode
        if (preMounted.paths.session) {
          workspace = preMounted.paths.session;
        }
        userWorkspaceWritable = true;
        agentWorkspaceWritable = isAdmin(agentDir(agentName), currentUserId);
        eventBus?.emit({
          type: 'workspace.mount',
          requestId,
          timestamp: Date.now(),
          data: { sessionId, scopes: ['agent', 'user', 'session'], agentId: agentName },
        });
      } catch (err) {
        reqLogger.warn('workspace_premount_failed', { error: (err as Error).message });
      }

      // Also re-mount any additional remembered scopes (e.g. 'session')
      const rememberedScopes = providers.workspace.activeMounts(sessionId)
        .filter(s => s !== 'agent' && s !== 'user');
      if (rememberedScopes.length > 0) {
        try {
          await providers.workspace.mount(sessionId, rememberedScopes, { userId: currentUserId });
        } catch (err) {
          reqLogger.warn('workspace_automount_failed', { error: (err as Error).message, scopes: rememberedScopes });
        }
      }

      // Note: sandbox tool writes now go through the mountRoot symlinks
      // (created below), which resolve to the workspace provider's directories.
      // No separate workspaceMap override needed here.
    }

    // Fallback: legacy enterprise paths (read-only in sandbox when workspace provider is 'none')
    if (!agentWsPath || !userWsPath) {
      const enterpriseAgentWs = agentWorkspaceDir(agentName);
      const enterpriseUserWs = userWorkspaceDir(agentName, currentUserId);
      mkdirSync(enterpriseAgentWs, { recursive: true });
      mkdirSync(enterpriseUserWs, { recursive: true });
      agentWsPath = agentWsPath ?? enterpriseAgentWs;
      userWsPath = userWsPath ?? enterpriseUserWs;
    }

    // Inject all stored credentials for this agent/user as MITM proxy placeholders.
    // The agent discovers missing credentials at runtime via skill.request_credential
    // IPC, which emits credential.required events for the frontend.
    if (config.web_proxy) {
      for (const scope of [credentialScope(agentName, currentUserId), credentialScope(agentName)]) {
        try {
          const storedNames = await providers.credentials.list(scope);
          for (const envName of storedNames) {
            if (credentialMap.toEnvMap()[envName]) continue;
            const realValue = await providers.credentials.get(envName, scope);
            if (realValue) {
              credentialMap.register(envName, realValue);
              reqLogger.info('credential_injected', { envName, scope });
            }
          }
        } catch { /* list may not be supported */ }
      }
    }

    // Create a symlink mountRoot for the sandbox tool IPC handlers.
    // This mirrors the layout the sandbox provider creates for the agent subprocess
    // (scratch/, agent/, user/ as siblings), so tools like sandbox_bash see the same
    // directory structure the agent does.
    toolMountRoot = createCanonicalSymlinks({
      workspace,
      ipcSocket: ipcSocketPath,
      command: [],
      agentWorkspace: agentWsPath,
      userWorkspace: userWsPath,
    });

    // Override the workspaceMap entry to point at the mountRoot instead of the
    // scratch directory — sandbox tool handlers now see agent/ and user/ as siblings.
    if (deps.workspaceMap) {
      deps.workspaceMap.set(sessionId, toolMountRoot.mountRoot);
    }

    // ── Load identity from DocumentStore ──
    // Identity files are keyed as <agentName>/<filename> and <agentName>/users/<userId>/<filename>
    const identityPayload = await loadIdentityFromDB(providers.storage.documents, agentName, currentUserId, reqLogger);

    // Identity is delivered to the agent via stdin payload (below).
    // Skills are now loaded directly from filesystem directories by the agent.

    // ── Workspace GCS prefixes ──
    const gcsPrefixes = resolveWorkspaceGcsPrefixes(config, agentName, currentUserId ?? '', sessionId);

    // Build stdin payload once — reused across retry attempts.
    const taintState = taintBudget.getState(sessionId);
    const stdinPayload = JSON.stringify({
      history,
      message: content,
      taintRatio: taintState ? taintState.taintedTokens / (taintState.totalTokens || 1) : 0,
      taintThreshold: thresholdForProfile(config.profile),
      profile: config.profile,
      sandboxType: config.providers.sandbox,
      userId: currentUserId,
      replyOptional: replyOptional ?? false,
      sessionId,
      requestId,
      sessionScope: sessionScope ?? 'dm',
      // Per-turn IPC token for NATS subject scoping (warm pods need this in the payload
      // since they don't have AX_IPC_TOKEN env var — it's set at pod creation time for cold pods only)
      ipcToken: deps.extraSandboxEnv?.AX_IPC_TOKEN,
      // Web proxy URL — warm pool pods don't have this in their pod spec
      webProxyUrl: deps.extraSandboxEnv?.AX_WEB_PROXY_URL,
      // Enterprise fields
      agentId: agentName,
      agentWorkspace: agentWsPath,
      userWorkspace: userWsPath,
      workspaceProvider: config.providers.workspace,
      // Identity from DocumentStore (skills are now filesystem-based)
      identity: identityPayload,
      // Workspace provisioning fields (sandbox-side providers provision in-pod)
      ...gcsPrefixes,
      agentReadOnly: !agentWorkspaceWritable,
      // Credential placeholders — warm pool pods don't have these in their pod spec,
      // so include them in the payload for the agent to set via process.env.
      credentialEnv: credentialMap.toEnvMap(),
      // MITM CA cert — sandbox pods need this to trust the proxy's TLS certs.
      caCert: caCertPem,
    });

    // Spawn, run, and collect agent output — with retry on transient crashes.
    // Transient: OOM kill (137), segfault (139), generic crash with retryable stderr.
    // Permanent: auth failures, bad config, content filter blocks.
    const sandboxConfig = {
      workspace,
      ipcSocket: ipcSocketPath,
      timeoutSec: config.sandbox.timeout_sec,
      memoryMB: config.sandbox.memory_mb,
      cpus: config.sandbox.tiers?.default?.cpus ?? 1,
      command: spawnCommand,
      agentWorkspace: agentWsPath,
      userWorkspace: userWsPath,
      agentWorkspaceWritable,
      userWorkspaceWritable,
      extraEnv: {
        ...deps.extraSandboxEnv,
        // Web proxy — agent runners detect these to start bridge / set HTTP_PROXY
        ...(webProxyPort ? { AX_PROXY_LISTEN_PORT: String(webProxyPort) } : {}),
        // Credential placeholders + CA trust env vars for MITM proxy
        ...credentialMap.toEnvMap(),
        ...credentialEnv,
      },
    };

    let response = '';
    let stderr = '';
    let exitCode = 1;

    for (let attempt = 0; attempt <= MAX_AGENT_RETRIES; attempt++) {
      response = '';
      stderr = '';
      const attemptStartTime = Date.now();

      const proc = await agentSandbox.spawn(sandboxConfig);
      reqLogger.debug('agent_spawn', { sandbox: config.providers.sandbox, attempt });
      eventBus?.emit({
        type: 'completion.agent',
        requestId,
        timestamp: Date.now(),
        data: { agentType, attempt, sessionId },
      });

      // Apple containers use an IPC bridge via --publish-socket / virtio-vsock.
      // The agent listens inside the VM and the host connects in. We must wait
      // for the agent's "[signal] ipc_ready" on stderr before connecting — the
      // runtime only forwards connections when the container-side listener exists.
      let bridge: { close: () => void } | undefined;

      // Start stderr collection immediately — we need to watch for the
      // ipc_ready signal AND collect all stderr for logging/diagnostics.
      // Use a callback-based approach so both signal detection and collection
      // share the same stream.
      let ipcReadyResolve: (() => void) | undefined;
      const ipcReadyPromise = proc.bridgeSocketPath
        ? new Promise<void>((resolve) => { ipcReadyResolve = resolve; })
        : undefined;

      const stdoutDone = (async () => {
        for await (const chunk of proc.stdout) {
          response += chunk.toString();
        }
      })();

      const stderrDone = (async () => {
        for await (const chunk of proc.stderr) {
          const text = chunk.toString();
          stderr += text;
          // Check for IPC ready signal from agent (Apple Container)
          if (ipcReadyResolve && text.includes('[signal] ipc_ready')) {
            ipcReadyResolve();
            ipcReadyResolve = undefined; // only resolve once
          }
          if (deps.verbose) {
            for (const line of text.split('\n').filter((l: string) => l.trim())) {
              const tagMatch = line.match(/^\[([\w-]+)\]\s*(.*)/);
              if (tagMatch) {
                reqLogger.debug(`agent_${tagMatch[1]}`, { message: tagMatch[2] });
              } else {
                reqLogger.info('agent_stderr', { line });
              }
            }
          }
        }
        // If agent exits before signaling, resolve to avoid hanging
        ipcReadyResolve?.();
      })();

      if (proc.bridgeSocketPath && deps.ipcHandler) {
        // Wait for agent's listener to be ready (with timeout).
        // Clear the timer when the signal wins to avoid leaking the 15s handle.
        let readyTimerId: ReturnType<typeof setTimeout> | undefined;
        let signaled = false;
        const readyTimeout = new Promise<void>(r => { readyTimerId = setTimeout(r, 15_000); });
        const signalWithCleanup = ipcReadyPromise!.then(() => { signaled = true; });
        await Promise.race([signalWithCleanup, readyTimeout]);
        if (readyTimerId !== undefined) clearTimeout(readyTimerId);
        reqLogger.debug('ipc_agent_ready', {
          bridgeSocketPath: proc.bridgeSocketPath,
          signaled, // true = agent signaled, false = 15s timeout (agent may still be booting)
        });

        try {
          const bridgeCtx = { sessionId, agentId: agentName, userId: currentUserId };
          bridge = await connectIPCBridge(proc.bridgeSocketPath, deps.ipcHandler, bridgeCtx);
          reqLogger.debug('ipc_bridge_connected', { bridgeSocketPath: proc.bridgeSocketPath });
        } catch (err) {
          // Bridge connect failed — agent may have crashed or the socket isn't
          // available. Kill the process to avoid it hanging until enforceTimeout,
          // then let the retry loop handle the failure.
          reqLogger.error('ipc_bridge_failed', {
            error: (err as Error).message,
            bridgeSocketPath: proc.bridgeSocketPath,
            signaled,
          });
          try { proc.stdin.end(); } catch { /* ignore */ }
          agentSandbox.kill(proc.pid);
        }
      }

      // Deliver work payload to agent.
      // NATS mode (k8s): publish to agent.work.{podName} — no stdin.
      // Stdin mode (subprocess/apple/cold k8s): write to proc.stdin.
      if (proc.podName && deps.publishWork) {
        reqLogger.debug('nats_work_publish', { podName: proc.podName, payloadBytes: stdinPayload.length });
        try {
          await deps.publishWork(proc.podName, stdinPayload);
          // Start the agent_response timeout AFTER work is published, not before
          // processCompletion runs. Pre-processing (scanner LLM calls, workspace
          // provisioning, CA generation) can take minutes and must not eat into
          // the agent's execution timeout budget.
          deps.startAgentResponseTimer?.();
        } catch (err) {
          reqLogger.error('nats_work_publish_failed', { podName: proc.podName, error: (err as Error).message });
          agentSandbox.kill(proc.pid);
        }
      } else {
        // Send raw user message to agent (not the taint-tagged queued.content).
        // Guard: if the bridge connect failed and we killed the process, stdin
        // is already closed — writing would throw EPIPE.
        try {
          reqLogger.debug('stdin_write', { payloadBytes: stdinPayload.length });
          proc.stdin.write(stdinPayload);
          proc.stdin.end();
        } catch {
          // Process already killed (bridge failure) — stdin write throws EPIPE
        }
      }

      // Wait for agent to complete.
      // NATS mode: response comes via agent_response IPC (agentResponsePromise).
      // Stdin mode: response comes from stdout.
      if (deps.agentResponsePromise) {
        // In NATS mode, we race the agent_response promise against pod exit.
        // The stdout/stderr are already closed (dummy streams) for k8s.
        try {
          response = await deps.agentResponsePromise;
          reqLogger.debug('nats_agent_response_received', { responseLength: response.length });
        } catch (err) {
          reqLogger.warn('nats_agent_response_error', { error: (err as Error).message });
          // Fall through to let exitCode determine retry
        }

        // In NATS/k8s mode, the cold-start pod may never have received work
        // (a warm pool pod claimed it first via the queue group). Don't block
        // on proc.exitCode — it would hang until the pod's activeDeadlineSeconds.
        // If we got the response, treat it as success; otherwise let retry logic handle it.
        if (response) {
          exitCode = 0;
          proc.kill(); // clean up the idle cold-start pod
        } else {
          exitCode = await proc.exitCode;
        }
      } else {
        await Promise.all([stdoutDone, stderrDone]);
        exitCode = await proc.exitCode;
      }
      bridge?.close();

      reqLogger.debug('agent_exit', {
        exitCode,
        attempt,
        stdoutLength: response.length,
        stderrLength: stderr.length,
        stdoutPreview: truncate(response, 500),
        stderrPreview: stderr ? truncate(stderr, 1000) : undefined,
      });

      const attemptDurationMs = Date.now() - attemptStartTime;
      reqLogger.debug('agent_complete', { durationMs: attemptDurationMs, exitCode, attempt });

      if (exitCode === 0) break; // Success — no retry needed

      // If the agent produced valid output despite a non-zero exit code (e.g.
      // tsx wrapper crashed with EPERM after the agent finished), accept it.
      // The most common cause: enforceTimeout sends SIGTERM to the tsx wrapper,
      // tsx's signal relay fails with EPERM on macOS, but the actual Node.js
      // agent process completed and wrote its output before the wrapper died.
      if (response.trim().length > 0) {
        reqLogger.warn('agent_exit_with_output', {
          exitCode,
          attempt,
          stdoutLength: response.length,
          message: 'Agent produced output despite non-zero exit — accepting response',
        });
        break;
      }

      // Determine if this failure is retryable.
      // Transient signals: killed by signal (137=OOM, 139=SEGV), ECONNRESET, EPIPE, spawn errors.
      // Permanent: auth errors, bad input, content filter, timeout (already spent the budget).
      const isTransient = isTransientAgentFailure(exitCode, stderr);

      if (!isTransient || attempt >= MAX_AGENT_RETRIES) {
        reqLogger.error('agent_failed', { exitCode, attempt, retryable: isTransient, maxRetries: MAX_AGENT_RETRIES, messageId: queued.id, stderr: stderr.slice(0, 2000) });
        await db.fail(queued.id);
        const diagnosed = diagnoseError(stderr || 'agent exited with no output');
        return { responseContent: `Agent processing failed: ${diagnosed.diagnosis}`, finishReason: 'stop' };
      }

      // Transient failure — retry after delay
      reqLogger.warn('agent_transient_failure', {
        exitCode,
        attempt,
        maxRetries: MAX_AGENT_RETRIES,
        retryDelayMs: AGENT_RETRY_DELAY_MS * (attempt + 1),
        stderr: stderr.slice(0, 500),
      });
      await new Promise(r => setTimeout(r, AGENT_RETRY_DELAY_MS * (attempt + 1)));
    }

    if (stderr) {
      const stderrLines = stderr.split('\n');
      const nonDiagLines: string[] = [];
      for (const line of stderrLines) {
        const tagMatch = line.trimStart().match(/^\[([\w-]+)\]\s*(.*)/);
        if (tagMatch) {
          reqLogger.debug(`agent_${tagMatch[1]}`, { message: tagMatch[2] });
        } else if (line.trim()) {
          nonDiagLines.push(line);
        }
      }
      if (nonDiagLines.length > 0) {
        reqLogger.warn('agent_stderr', { stderr: nonDiagLines.join('\n').slice(0, 500) });
      }
    }

    // Workspace provider: commit changes after agent turn
    if (providers.workspace.activeMounts(sessionId).length > 0) {
      try {
        const commitResult = await providers.workspace.commit(sessionId);
        for (const [scope, scopeResult] of Object.entries(commitResult.scopes)) {
          if (scopeResult && scopeResult.status === 'committed') {
            eventBus?.emit({
              type: 'workspace.commit',
              requestId,
              timestamp: Date.now(),
              data: { sessionId, scope, agentId: agentName, filesChanged: scopeResult.filesChanged, bytesChanged: scopeResult.bytesChanged },
            });
          }
          if (scopeResult && scopeResult.rejections?.length) {
            eventBus?.emit({
              type: 'workspace.commit.rejected',
              requestId,
              timestamp: Date.now(),
              data: { sessionId, scope, rejections: scopeResult.rejections },
            });
          }
        }
      } catch (err) {
        reqLogger.warn('workspace_commit_failed', { error: (err as Error).message });
      }
    }

    // Parse structured response (may contain image blocks)
    const parsed = parseAgentResponse(response);

    // Process outbound (scan the text portion)
    const canaryToken = sessionCanaries.get(queued.session_id) ?? '';
    reqLogger.debug('outbound_start', { responseLength: parsed.text.length, hasCanary: canaryToken.length > 0, hasBlocks: !!parsed.blocks });
    const outbound = await router.processOutbound(parsed.text, queued.session_id, canaryToken);

    eventBus?.emit({
      type: 'scan.outbound',
      requestId,
      timestamp: Date.now(),
      data: { verdict: outbound.scanResult.verdict, canaryLeaked: outbound.canaryLeaked },
    });

    if (outbound.canaryLeaked) {
      reqLogger.warn('canary_leaked', { sessionId: queued.session_id });
    }

    // Build structured content blocks for the response (if agent included images).
    // Extract image_data blocks: decode base64 → save to workspace → replace with file refs.
    let responseBlocks: ContentBlock[] | undefined;
    let extractedFiles: ExtractedFile[] | undefined;
    if (parsed.blocks) {
      const withScannedText = parsed.blocks.map(b => {
        if (b.type === 'text') return { ...b, text: outbound.content };
        return b;
      });
      const extracted = extractImageDataBlocks(withScannedText, userWsPath, reqLogger);
      responseBlocks = extracted.blocks;
      if (extracted.extractedFiles.length > 0) {
        extractedFiles = extracted.extractedFiles;
        // Register extracted files in the file store for fileId-only lookups
        if (deps.fileStore) {
          for (const ef of extracted.extractedFiles) {
            await deps.fileStore.register(ef.fileId, agentName, currentUserId, ef.mimeType);
          }
        }
      }
    }

    // Drain images generated via image_generate tool during this completion.
    // These are held in memory by the image handler — no disk round-trip needed.
    // The agent injects its session ID into IPC requests via _sessionId, so
    // images are stored under the real session ID (e.g. 'ch-d81c057a').
    const generatedImages = drainGeneratedImages(requestId);
    reqLogger.debug('image_drain', { sessionKey: requestId, count: generatedImages.length });
    if (generatedImages.length > 0) {
      if (!extractedFiles) extractedFiles = [];
      if (!responseBlocks) responseBlocks = [{ type: 'text', text: outbound.content }];
      for (const img of generatedImages) {
        extractedFiles.push({ fileId: img.fileId, mimeType: img.mimeType, data: img.data });
        responseBlocks.push({ type: 'image', fileId: img.fileId, mimeType: img.mimeType as ImageMimeType });
      }
      // Persist generated images to user workspace so /v1/files/ can serve them later.
      // Without this, image URLs return 404 after the in-memory drain.
      for (const img of generatedImages) {
        try {
          const filePath = safePath(userWsPath, ...img.fileId.split('/').filter(Boolean));
          mkdirSync(join(filePath, '..'), { recursive: true });
          writeFileSync(filePath, img.data);
          deps.fileStore?.register(img.fileId, agentName, currentUserId, img.mimeType);
          reqLogger.info('image_persisted', { fileId: img.fileId, path: filePath, bytes: img.data.length });
        } catch (err) {
          reqLogger.warn('image_persist_failed', { fileId: img.fileId, workspace: userWsPath, error: (err as Error).message });
        }
      }
    }

    // Memorize if provider supports it (text only for memory)
    if (providers.memory.memorize) {
      try {
        const fullHistory = [
          ...clientMessages.map(m => ({
            role: m.role as 'user' | 'assistant',
            content: typeof m.content === 'string' ? m.content : m.content.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join(''),
          })),
          { role: 'assistant' as const, content: outbound.content },
        ];
        // DM context: memories are user-scoped. Channel context: memories are agent-scoped (shared).
        const isDm = (sessionScope ?? 'dm') === 'dm';
        await providers.memory.memorize(fullHistory, isDm ? currentUserId : undefined);
      } catch (err) {
        reqLogger.warn('memorize_failed', { error: (err as Error).message });
      }
    }

    await db.complete(queued.id);
    sessionCanaries.delete(queued.session_id);

    // Persist conversation turns for persistent sessions
    if (persistentSessionId && maxTurns > 0) {
      try {
        await conversationStore.append(persistentSessionId, 'user', content, userId);
        // Store structured blocks if present, plain text otherwise
        const assistantContent = responseBlocks ?? outbound.content;
        await conversationStore.append(persistentSessionId, 'assistant', assistantContent);
        // Lazy prune: only when count exceeds limit
        if (await conversationStore.count(persistentSessionId) > maxTurns) {
          await conversationStore.prune(persistentSessionId, maxTurns);
        }

        // Summarize old turns if enabled — compresses older turns into a summary
        // so conversations can grow indefinitely without losing context.
        const summarizeConfig: SummarizationConfig = {
          enabled: config.history.summarize,
          threshold: config.history.summarize_threshold,
          keepRecent: config.history.summarize_keep_recent,
        };
        if (summarizeConfig.enabled) {
          maybeSummarizeHistory(
            persistentSessionId, conversationStore, providers.llm,
            summarizeConfig, reqLogger,
          ).catch(err => {
            reqLogger.warn('history_summarize_error', { error: (err as Error).message });
          });
        }
      } catch (err) {
        reqLogger.warn('history_save_failed', { error: (err as Error).message });
      }
    }

    // Auto-generate session title for new sessions (first turn)
    if (persistentSessionId && maxTurns > 0) {
      try {
        const chatSessions = providers.storage?.chatSessions;
        if (chatSessions) {
          // Ensure session exists in chat_sessions table
          await chatSessions.ensureExists(persistentSessionId);

          // Only generate title if session doesn't already have one
          const session = await chatSessions.getById(persistentSessionId);
          if (session && !session.title) {
            // Generate title asynchronously (don't block response)
            generateSessionTitle(textContent, {
              complete: async (prompt: string) => {
                const chunks: string[] = [];
                const stream = providers.llm.chat({
                  model: '',
                  messages: [{ role: 'user', content: prompt }],
                  maxTokens: 30,
                  taskType: 'fast',
                });
                for await (const chunk of stream) {
                  if (chunk.content) chunks.push(chunk.content);
                }
                return chunks.join('');
              },
            }).then(async (title) => {
              await chatSessions.updateTitle(persistentSessionId!, title);
              reqLogger.debug('session_title_generated', { sessionId: persistentSessionId, title });
            }).catch(err => {
              reqLogger.warn('session_title_error', { error: (err as Error).message });
            });
          }
        }
      } catch (err) {
        reqLogger.warn('session_title_setup_error', { error: (err as Error).message });
      }
    }

    const finishReason = outbound.scanResult.verdict === 'BLOCK' ? 'content_filter' as const : 'stop' as const;
    reqLogger.debug('completion_done', {
      finishReason,
      responseLength: outbound.content.length,
      scanVerdict: outbound.scanResult.verdict,
      hasContentBlocks: !!responseBlocks,
    });
    eventBus?.emit({
      type: 'completion.done',
      requestId,
      timestamp: Date.now(),
      data: { finishReason, responseLength: outbound.content.length, sessionId },
    });
    return { responseContent: outbound.content, contentBlocks: responseBlocks, extractedFiles, agentName, userId: currentUserId, finishReason };

  } catch (err) {
    reqLogger.error('completion_error', {
      error: (err as Error).message,
      stack: (err as Error).stack,
    });
    eventBus?.emit({
      type: 'completion.error',
      requestId,
      timestamp: Date.now(),
      data: { error: (err as Error).message, sessionId },
    });
    await db.fail(queued.id);
    // Clean up canary token on error — without this, every failed completion
    // permanently leaks an entry in sessionCanaries, eventually causing OOM.
    sessionCanaries.delete(queued.session_id);
    return { responseContent: 'Internal processing error', finishReason: 'stop' };
  } finally {
    // Clean up per-session credential request tracking.
    deps.requestedCredentials?.delete(sessionId);
    // Deregister workspace from the shared map so sandbox tool handlers
    // can't access it after the agent finishes.
    if (deps.workspaceMap) {
      deps.workspaceMap.delete(sessionId);
    }
    // Clean up the symlink mountRoot used by sandbox tool handlers.
    if (toolMountRoot) {
      toolMountRoot.cleanup();
    }
    if (proxyCleanup) {
      try { proxyCleanup(); } catch {
        reqLogger.debug('proxy_cleanup_failed');
      }
    }
    if (webProxyCleanup) {
      try { webProxyCleanup(); } catch {
        reqLogger.debug('web_proxy_cleanup_failed');
      }
    }
    // Clean up pending OAuth flows for this session
    {
      const { cleanupSession: cleanupOAuth } = await import('./oauth-skills.js');
      cleanupOAuth(sessionId);
    }
    // Deregister session from shared credential registry (k8s shared proxy)
    if (deps.sharedCredentialRegistry) {
      deps.sharedCredentialRegistry.deregister(sessionId);
    }
    // Workspace provider: cleanup session scope for ephemeral sessions
    if (!isPersistent) {
      try { await providers.workspace.cleanup(sessionId); } catch {
        reqLogger.debug('workspace_provider_cleanup_failed', { sessionId });
      }
    }
    if (workspace && !isPersistent) {
      try { rmSync(workspace, { recursive: true, force: true }); } catch {
        reqLogger.debug('workspace_cleanup_failed', { workspace });
      }
    }
  }
}

/**
 * Classify whether an agent exit is a transient failure worth retrying.
 *
 * Transient: OOM kill (128+9=137), SEGV (128+11=139), connection errors,
 *   spawn failures, unknown crashes.
 * Permanent: auth errors (401/403), bad config, timeout (already spent budget),
 *   content filter blocks, missing API keys.
 */
export function isTransientAgentFailure(exitCode: number, stderr: string): boolean {
  const lower = stderr.toLowerCase();

  // Permanent: auth/credential failures — retrying won't help
  if (lower.includes('401') || lower.includes('403') || lower.includes('unauthorized') || lower.includes('forbidden')) return false;
  if (lower.includes('invalid') && lower.includes('api key')) return false;
  if (lower.includes('no api credentials')) return false;

  // Permanent: bad input / config
  if (lower.includes('400') || lower.includes('bad request')) return false;
  if (lower.includes('validation failed')) return false;

  // Permanent: timeout — the sandbox already used its full time budget
  if (lower.includes('timed out') || lower.includes('timeout') || lower.includes('sigkill')) return false;

  // Permanent: tsx wrapper signal relay failure — the agent process wrapper
  // (tsx) failed to relay a signal. This is a process management issue, not
  // an agent crash. Retrying will just repeat the same wrapper failure.
  if (lower.includes('kill eperm') || (lower.includes('eperm') && lower.includes('relaysignaltochild'))) return false;

  // Transient: signal kills (OOM=137, SEGV=139, other signals=128+N)
  if (exitCode >= 128 && exitCode <= 191) return true;

  // Transient: connection/network errors in agent stderr
  if (lower.includes('econnreset') || lower.includes('econnrefused') || lower.includes('epipe')) return true;
  if (lower.includes('socket hang up') || lower.includes('socket hangup')) return true;

  // Transient: spawn/fork failures
  if (lower.includes('spawn') && lower.includes('error')) return true;
  if (lower.includes('enomem') || lower.includes('cannot allocate')) return true;

  // Unknown non-zero exit — assume transient for first retry
  if (exitCode !== 0) return true;

  return false;
}

