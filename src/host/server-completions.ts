/**
 * Completion processing — the core pipeline from inbound message to agent
 * response. Handles workspace setup, skills refresh, history loading,
 * agent spawning, outbound scanning, and memory persistence.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { isValidSessionId, workspaceDir, agentIdentityDir, agentWorkspaceDir, agentSkillsDir, userSkillsDir, userWorkspaceDir } from '../paths.js';
import { mergeSkillsOverlay } from '../providers/sandbox/canonical-paths.js';
import type { Config, ProviderRegistry, ContentBlock, ImageMimeType } from '../types.js';
import { safePath } from '../utils/safe-path.js';
import type { InboundMessage } from '../providers/channel/types.js';
import { deserializeContent } from '../conversation-store.js';
import type { ConversationStore } from '../conversation-store.js';
import type { MessageQueue } from '../db.js';
import type { Router } from './router.js';
import { TaintBudget, thresholdForProfile } from './taint-budget.js';
import { type Logger, truncate } from '../logger.js';
import { drainGeneratedImages } from './ipc-handlers/image.js';
import { startAnthropicProxy } from './proxy.js';
import { diagnoseError } from '../errors.js';
import { ensureOAuthTokenFreshViaProvider, ensureOAuthTokenFresh, refreshOAuthTokenFromEnv } from '../dotenv.js';
import { runnerPath as resolveRunnerPath, tsxLoader, isDevMode } from '../utils/assets.js';
import type { OpenAIChatRequest } from './server-http.js';
import type { FileStore } from '../file-store.js';
import type { EventBus } from './event-bus.js';
import { maybeSummarizeHistory, type SummarizationConfig } from './history-summarizer.js';
import { recallMemoryForMessage, type MemoryRecallConfig } from './memory-recall.js';

// ── Agent spawn retry ──
const MAX_AGENT_RETRIES = 2;
const AGENT_RETRY_DELAY_MS = 1000;

export interface CompletionDeps {
  config: Config;
  providers: ProviderRegistry;
  db: MessageQueue;
  conversationStore: ConversationStore;
  router: Router;
  taintBudget: TaintBudget;
  sessionCanaries: Map<string, string>;
  ipcSocketPath: string;
  ipcSocketDir: string;
  agentDir: string;
  logger: Logger;
  verbose?: boolean;
  fileStore?: FileStore;
  eventBus?: EventBus;
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
): Promise<CompletionResult> {
  const { config, providers, db, conversationStore, router, taintBudget, sessionCanaries, ipcSocketPath, ipcSocketDir, agentDir, logger, eventBus } = deps;
  const sessionId = preProcessed?.sessionId ?? randomUUID();
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
  const queued = result.messageId ? db.dequeueById(result.messageId) : db.dequeue();
  if (!queued) {
    reqLogger.debug('dequeue_failed', { messageId: result.messageId });
    return { responseContent: 'Internal error: message not queued', finishReason: 'stop' };
  }

  let workspace = '';
  const isPersistent = !!persistentSessionId;
  let proxyCleanup: (() => void) | undefined;
  let skillsCleanup: (() => void) | undefined;
  // Skills: merge agent-level and user-level skills via overlayfs.
  // Agent skills form the lower layer; user skills shadow agent skills of the same name.
  const agentName = config.agent_name ?? 'main';
  const currentUserId = userId ?? process.env.USER ?? 'default';
  const agentSkills = agentSkillsDir(agentName);
  const userSkills = userSkillsDir(agentName, currentUserId);
  mkdirSync(agentSkills, { recursive: true });
  mkdirSync(userSkills, { recursive: true });
  const skillsMerge = mergeSkillsOverlay(agentSkills, userSkills);
  skillsCleanup = skillsMerge.cleanup;
  try {
    if (persistentSessionId) {
      workspace = workspaceDir(persistentSessionId);
      mkdirSync(workspace, { recursive: true });
    } else {
      workspace = mkdtempSync(join(tmpdir(), 'ax-ws-'));
    }

    // Build conversation history: prefer DB-persisted history for persistent sessions,
    // fall back to client-provided history for ephemeral sessions.
    let history: { role: 'user' | 'assistant'; content: string | ContentBlock[]; sender?: string }[] = [];
    const maxTurns = config.history.max_turns;

    if (persistentSessionId && maxTurns > 0) {
      // maxTurns=0 disables history entirely (no loading, no saving).
      // Load persisted history from DB
      const storedTurns = conversationStore.load(persistentSessionId, maxTurns);

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

          const parentTurns = conversationStore.load(parentSessionId, config.history.thread_context_turns);

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
    // Uses FTS5 keyword search against the memory provider to find entries
    // relevant to the current user message, prepended before any history.
    const recallConfig: MemoryRecallConfig = {
      enabled: config.history.memory_recall,
      limit: config.history.memory_recall_limit,
      scope: config.history.memory_recall_scope,
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
        db.fail(queued.id);
        return {
          responseContent: 'No API credentials configured. Run `ax configure` to set up authentication.',
          finishReason: 'stop',
        };
      }

      proxySocketPath = join(ipcSocketDir, 'anthropic-proxy.sock');
      const proxy = startAnthropicProxy(proxySocketPath!, undefined, async () => {
        await refreshOAuthTokenFromEnv();
      });
      proxyCleanup = proxy.stop;
    }

    const maxTokens = config.max_tokens ?? 8192;

    // Workspace/skills/agentDir are NOT passed as CLI args — they're set via
    // canonical env vars by the sandbox provider (e.g. AX_WORKSPACE=/workspace).
    // This avoids conflicts between host paths (CLI args) and canonical paths (env vars).
    const spawnCommand = [process.execPath,
      // Dev mode: load tsx ESM loader so the .ts runner source is compiled on
      // the fly. Production: run compiled dist/agent/runner.js directly.
      ...(isDevMode() ? ['--import', tsxLoader()] : []),
      resolveRunnerPath(),
      '--agent', agentType,
      '--ipc-socket', ipcSocketPath,
      '--max-tokens', String(maxTokens),
      ...(proxySocketPath ? ['--proxy-socket', proxySocketPath] : []),
      ...(deps.verbose ? ['--verbose'] : []),
    ];

    reqLogger.debug('agent_spawn', {
      agentType,
      workspace,
      command: spawnCommand.join(' '),
      timeoutSec: config.sandbox.timeout_sec,
      memoryMB: config.sandbox.memory_mb,
    });

    // Enterprise: set up workspace directories
    const enterpriseAgentWs = agentWorkspaceDir(agentName);
    const enterpriseUserWs = userWorkspaceDir(agentName, currentUserId);
    mkdirSync(enterpriseAgentWs, { recursive: true });
    mkdirSync(enterpriseUserWs, { recursive: true });

    // Read USER_BOOTSTRAP.md from the config dir (not in sandbox mount) to pass via stdin
    let userBootstrapContent: string | undefined;
    try {
      const configDir = agentIdentityDir(agentName);
      const ubPath = join(configDir, 'USER_BOOTSTRAP.md');
      if (existsSync(ubPath)) {
        userBootstrapContent = readFileSync(ubPath, 'utf-8');
      }
    } catch { /* non-fatal */ }

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
      sessionId: requestId,
      // Enterprise fields
      agentId: agentName,
      agentWorkspace: enterpriseAgentWs,
      userWorkspace: enterpriseUserWs,
      // Identity content from config dir (not in sandbox mount)
      ...(userBootstrapContent ? { userBootstrapContent } : {}),
    });

    // Spawn, run, and collect agent output — with retry on transient crashes.
    // Transient: OOM kill (137), segfault (139), generic crash with retryable stderr.
    // Permanent: auth failures, bad config, content filter blocks.
    const sandboxConfig = {
      workspace,
      skills: skillsMerge.mergedDir,
      ipcSocket: ipcSocketPath,
      agentDir,
      timeoutSec: config.sandbox.timeout_sec,
      memoryMB: config.sandbox.memory_mb,
      command: spawnCommand,
      agentWorkspace: enterpriseAgentWs,
      userWorkspace: enterpriseUserWs,
    };

    let response = '';
    let stderr = '';
    let exitCode = 1;

    for (let attempt = 0; attempt <= MAX_AGENT_RETRIES; attempt++) {
      response = '';
      stderr = '';

      const proc = await providers.sandbox.spawn(sandboxConfig);
      reqLogger.debug('agent_spawn', { sandbox: 'subprocess', attempt });
      eventBus?.emit({
        type: 'completion.agent',
        requestId,
        timestamp: Date.now(),
        data: { agentType, attempt, sessionId },
      });

      // Send raw user message to agent (not the taint-tagged queued.content)
      reqLogger.debug('stdin_write', { payloadBytes: stdinPayload.length });
      proc.stdin.write(stdinPayload);
      proc.stdin.end();

      // Collect stdout and stderr in parallel to avoid pipe buffer deadlocks.
      // Sequential collection can lose data when a stream fills its buffer
      // while the other stream is being drained.
      const stdoutDone = (async () => {
        for await (const chunk of proc.stdout) {
          response += chunk.toString();
        }
      })();

      const stderrDone = (async () => {
        for await (const chunk of proc.stderr) {
          const text = chunk.toString();
          stderr += text;
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
      })();

      await Promise.all([stdoutDone, stderrDone]);
      exitCode = await proc.exitCode;

      reqLogger.debug('agent_exit', {
        exitCode,
        attempt,
        stdoutLength: response.length,
        stderrLength: stderr.length,
        stdoutPreview: truncate(response, 500),
        stderrPreview: stderr ? truncate(stderr, 1000) : undefined,
      });

      reqLogger.debug('agent_complete', { durationSec: 0, exitCode, attempt });

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
        reqLogger.error('agent_failed', { exitCode, attempt, retryable: isTransient, stderr: stderr.slice(0, 2000) });
        db.fail(queued.id);
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
      const extracted = extractImageDataBlocks(withScannedText, enterpriseUserWs, reqLogger);
      responseBlocks = extracted.blocks;
      if (extracted.extractedFiles.length > 0) {
        extractedFiles = extracted.extractedFiles;
        // Register extracted files in the file store for fileId-only lookups
        if (deps.fileStore) {
          for (const ef of extracted.extractedFiles) {
            deps.fileStore.register(ef.fileId, agentName, currentUserId, ef.mimeType);
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
          const filePath = safePath(enterpriseUserWs, ...img.fileId.split('/').filter(Boolean));
          mkdirSync(join(filePath, '..'), { recursive: true });
          writeFileSync(filePath, img.data);
          deps.fileStore?.register(img.fileId, agentName, currentUserId, img.mimeType);
          reqLogger.info('image_persisted', { fileId: img.fileId, path: filePath, bytes: img.data.length });
        } catch (err) {
          reqLogger.warn('image_persist_failed', { fileId: img.fileId, workspace: enterpriseUserWs, error: (err as Error).message });
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
        await providers.memory.memorize(fullHistory);
      } catch (err) {
        reqLogger.warn('memorize_failed', { error: (err as Error).message });
      }
    }

    db.complete(queued.id);
    sessionCanaries.delete(queued.session_id);

    // Persist conversation turns for persistent sessions
    if (persistentSessionId && maxTurns > 0) {
      try {
        conversationStore.append(persistentSessionId, 'user', content, userId);
        // Store structured blocks if present, plain text otherwise
        const assistantContent = responseBlocks ?? outbound.content;
        conversationStore.append(persistentSessionId, 'assistant', assistantContent);
        // Lazy prune: only when count exceeds limit
        if (conversationStore.count(persistentSessionId) > maxTurns) {
          conversationStore.prune(persistentSessionId, maxTurns);
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
    db.fail(queued.id);
    // Clean up canary token on error — without this, every failed completion
    // permanently leaks an entry in sessionCanaries, eventually causing OOM.
    sessionCanaries.delete(queued.session_id);
    return { responseContent: 'Internal processing error', finishReason: 'stop' };
  } finally {
    if (proxyCleanup) {
      try { proxyCleanup(); } catch {
        reqLogger.debug('proxy_cleanup_failed');
      }
    }
    if (workspace && !isPersistent) {
      try { rmSync(workspace, { recursive: true, force: true }); } catch {
        reqLogger.debug('workspace_cleanup_failed', { workspace });
      }
    }
    // Clean up overlayfs skills merge (unmount if applicable)
    if (skillsCleanup) {
      try { skillsCleanup(); } catch {
        reqLogger.debug('skills_cleanup_failed');
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
