/**
 * Completion processing — the core pipeline from inbound message to agent
 * response. Handles workspace setup, skills refresh, history loading,
 * agent spawning, outbound scanning, and memory persistence.
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dataDir } from '../paths.js';
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
import { startAnthropicProxy } from './proxy.js';
import { startWebProxy, type WebProxy } from './web-proxy.js';
import { CredentialPlaceholderMap } from './credential-placeholders.js';
import { getOrCreateCA, type CAKeyPair } from './proxy-ca.js';
import { connectIPCBridge } from './ipc-server.js';
import { diagnoseError } from '../errors.js';
import { ensureOAuthTokenFreshViaProvider, ensureOAuthTokenFresh, refreshOAuthTokenFromEnv, forceRefreshOAuthViaProvider } from '../dotenv.js';
import { runnerPath as resolveRunnerPath, tsxLoader, isDevMode, templatesDir as resolveTemplatesDir, seedSkillsDir as resolveSeedSkillsDir } from '../utils/assets.js';
import type { OpenAIChatRequest } from './server-http.js';
import type { FileStore } from '../file-store.js';
import type { GcsFileStorage } from './gcs-file-storage.js';
import type { EventBus } from './event-bus.js';
import { maybeSummarizeHistory, type SummarizationConfig } from './history-summarizer.js';
import { recallMemoryForMessage, type MemoryRecallConfig } from './memory-recall.js';
import { createEmbeddingClient } from '../utils/embedding-client.js';
import { credentialScope, setSessionCredentialContext } from './credential-scopes.js';
import { generateSessionTitle } from './session-title.js';
import type { McpConnectionManager } from '../plugins/mcp-manager.js';
import { validateCommit, AX_DIFF_PATHSPEC } from './validate-commit.js';

// ── Session ID placeholder rewriting ──
// HTTP sessions use '_' as the workspace placeholder in the SessionAddress.
// After the provisioner resolves the agent, replace '_' with the real agent ID.
// Format: "http:dm:_:userId:threadId" → "http:dm:agentId:userId:threadId"
const SESSION_PLACEHOLDER = ':_:';
function rewriteSessionPlaceholder(sessionId: string, agentId: string): string {
  const idx = sessionId.indexOf(SESSION_PLACEHOLDER);
  if (idx === -1) return sessionId;
  return sessionId.slice(0, idx + 1) + agentId + sessionId.slice(idx + 2);
}

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
  gcsFileStorage?: GcsFileStorage;
  eventBus?: EventBus;
  /** Maps sessionId → workspace directory path. Shared with sandbox tool IPC handlers. */
  workspaceMap?: Map<string, string>;
  /** Tracks credential_request IPC calls per session. Consumed by post-agent credential loop. */
  requestedCredentials?: Map<string, Set<string>>;
  /** IPC handler function for reverse bridge connections (Apple containers). */
  ipcHandler?: (raw: string, ctx: import('./ipc-server.js').IPCContext) => Promise<string>;
  /** Extra env vars to inject into sandbox pods (per-turn IPC token, request ID). */
  extraSandboxEnv?: Record<string, string>;
  /** Promise that resolves with the agent response content (k8s HTTP mode).
   *  When set, processCompletion waits on this instead of reading stdout. */
  agentResponsePromise?: Promise<string>;
  /** Shared credential registry for k8s shared proxy MITM mode.
   *  Per-session credential maps are registered/deregistered here so the
   *  shared proxy can replace placeholders from any active session. */
  sharedCredentialRegistry?: import('./credential-placeholders.js').SharedCredentialRegistry;
  /** Domain allowlist for proxy — populated from installed skill manifests. */
  domainList?: import('./proxy-domain-list.js').ProxyDomainList;
  /** Callback to start the agent_response timeout timer (k8s HTTP mode).
   *  Called after work is published so the timer doesn't include pre-processing time
   *  (scanner LLM calls, workspace provisioning, etc.). */
  startAgentResponseTimer?: () => void;
  /** Unified session manager for cross-turn sandbox reuse (Docker and k8s). */
  sessionManager?: import('./session-manager.js').SessionManager;
  /** Per-agent plugin MCP server registry. */
  mcpManager?: McpConnectionManager;
  /** Dynamic agent provisioner for multi-agent resolution. */
  provisioner?: import('./agent-provisioner.js').AgentProvisioner;
  /** When true, sandbox exits after completing this turn (cron, heartbeat, delegation). */
  singleTurn?: boolean;
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

/** Identity fields loaded from git, keyed by filename. */
export interface IdentityPayload {
  agents?: string;
  soul?: string;
  identity?: string;
  bootstrap?: string;
  userBootstrap?: string;
  heartbeat?: string;
}

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

/** Paths to identity files in the git tree. */
// Re-export for backward compatibility (tests import from here)
export { loadIdentityFromGit, fetchIdentityFromRemote } from './identity-reader.js';
import { loadIdentityFromGit, fetchIdentityFromRemote, clearIdentityCache } from './identity-reader.js';

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
export async function extractImageDataBlocks(
  blocks: ContentBlock[],
  wsDir: string,
  logger: Logger,
  gcsFileStorage?: GcsFileStorage,
): Promise<{ blocks: ContentBlock[]; extractedFiles: ExtractedFile[] }> {
  const hasTransientData = blocks.some(b => b.type === 'image_data' || b.type === 'file_data');
  if (!hasTransientData) return { blocks, extractedFiles: [] };

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
        const fileId = `files/${filename}`;

        if (gcsFileStorage) {
          await gcsFileStorage.upload(fileId, buf, block.mimeType, filename);
        } else {
          const filePath = safePath(filesDir, filename);
          writeFileSync(filePath, buf);
        }

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
    } else if (block.type === 'file_data') {
      try {
        const buf = Buffer.from(block.data, 'base64');
        const ext = MIME_TO_EXT[block.mimeType] ?? '.bin';
        const filename = `${randomUUID()}${ext}`;
        const fileId = `files/${filename}`;

        if (gcsFileStorage) {
          await gcsFileStorage.upload(fileId, buf, block.mimeType, block.filename);
        } else {
          const filePath = safePath(filesDir, filename);
          writeFileSync(filePath, buf);
        }

        converted.push({ type: 'file', fileId, mimeType: block.mimeType, filename: block.filename });
        extractedFiles.push({ fileId, mimeType: block.mimeType, data: buf });
      } catch (err) {
        logger.warn('file_data_extract_failed', {
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

/**
 * Clone or pull a workspace repo on the host side (file:// or http://).
 * The host must manage a local clone to read identity files for the
 * agent's system prompt and to commit changes after each turn.
 *
 * Uses --separate-git-dir to keep .git metadata outside the workspace,
 * mirroring the k8s git-init approach. The agent only sees working-tree files.
 */
function hostGitSync(workspace: string, gitDir: string, repoUrl: string, logger: Logger): void {
  const gitEnv = { GIT_DIR: gitDir, GIT_WORK_TREE: workspace };
  const gitOpts = { cwd: workspace, stdio: 'pipe' as const, env: { ...process.env, ...gitEnv } };

  if (!existsSync(join(gitDir, 'HEAD'))) {
    try {
      execFileSync('git', ['clone', '--separate-git-dir', gitDir, repoUrl, '.'], { cwd: workspace, stdio: 'pipe' as const });
      // clone leaves a .git pointer file in workspace — remove it so agent can't see it
      try { unlinkSync(join(workspace, '.git')); } catch { /* already absent */ }
      // Ensure we're on 'main' regardless of system default
      try { execFileSync('git', ['branch', '-M', 'main'], gitOpts); } catch (e) { logger.debug('branch_rename_skip', { reason: (e as Error).message }); }
    } catch (cloneErr) {
      // Clone fails on empty bare repos (no commits yet) — init with separate gitdir
      logger.debug('git_clone_fallback_init', { repoUrl, error: (cloneErr as Error).message });
      mkdirSync(gitDir, { recursive: true });
      execFileSync('git', ['init'], gitOpts);
      execFileSync('git', ['remote', 'add', 'origin', repoUrl], gitOpts);
      try { execFileSync('git', ['checkout', '-b', 'main'], gitOpts); } catch (e) { logger.debug('checkout_skip', { reason: (e as Error).message }); }
    }
  } else {
    try {
      execFileSync('git', ['pull', 'origin', 'main'], gitOpts);
    } catch (e) { logger.debug('pull_skip', { reason: (e as Error).message }); }
  }

  execFileSync('git', ['config', 'user.name', 'agent'], gitOpts);
  execFileSync('git', ['config', 'user.email', 'agent@ax.local'], gitOpts);
  logger.debug('host_git_synced', { workspace, gitDir, repoUrl });
}

/**
 * Commit and push workspace changes to the bare repo from the host.
 * Uses GIT_DIR/GIT_WORK_TREE to operate on the separated git metadata.
 */
function hostGitCommit(workspace: string, gitDir: string, logger: Logger): void {
  const gitEnv = { GIT_DIR: gitDir, GIT_WORK_TREE: workspace };
  const gitOpts = { cwd: workspace, stdio: 'pipe' as const, env: { ...process.env, ...gitEnv } };
  const textOpts = { cwd: workspace, encoding: 'utf-8' as const, stdio: 'pipe' as const, env: { ...process.env, ...gitEnv } };
  try {
    execFileSync('git', ['add', '.'], gitOpts);

    // Validate .ax/ changes before committing
    const axDiff = execFileSync('git', ['diff', '--cached', '--', AX_DIFF_PATHSPEC],
      textOpts).trim();

    if (axDiff) {
      const validation = validateCommit(axDiff);
      if (!validation.ok) {
        logger.warn('ax_commit_rejected', { reason: validation.reason });
        // Revert .ax/ changes — unstage and checkout
        try { execFileSync('git', ['reset', 'HEAD', '--', '.ax/'], gitOpts); } catch { /* no .ax/ staged */ }
        try { execFileSync('git', ['checkout', '--', '.ax/'], gitOpts); } catch { /* no tracked .ax/ to restore */ }
        try { execFileSync('git', ['clean', '-fd', '--', '.ax/'], gitOpts); } catch { /* no untracked .ax/ files */ }
        // Re-stage remaining (non-.ax/) changes
        execFileSync('git', ['add', '.'], gitOpts);
      }
    }

    const status = execFileSync('git', ['status', '--porcelain'], textOpts);
    if (status.trim()) {
      // Detect current branch. On a fresh repo with no commits, HEAD doesn't exist yet —
      // fall back to the symbolic-ref (set during init) or default to 'main'.
      let branch = 'main';
      try {
        branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], textOpts).trim() || 'main';
      } catch {
        try {
          // Fresh repo — read the default branch from symbolic-ref
          const ref = execFileSync('git', ['symbolic-ref', 'HEAD'], textOpts).trim();
          branch = ref.replace('refs/heads/', '') || 'main';
        } catch { /* use default 'main' */ }
      }
      const timestamp = new Date().toISOString();
      execFileSync('git', ['commit', '-m', `agent-turn: ${timestamp}`], gitOpts);
      // Pull with rebase only if the remote branch exists (first push won't have it).
      try {
        execFileSync('git', ['pull', '--rebase', 'origin', branch], gitOpts);
      } catch {
        // Remote branch doesn't exist yet — first push, skip rebase
      }
      execFileSync('git', ['push', 'origin', branch], gitOpts);
      logger.info('host_git_committed', { workspace, branch });
    }
    // Reset workspace to committed state — prevents prompt-injected files
    // (scripts, configs, dotfiles) from persisting to the next turn.
    execFileSync('git', ['reset', '--hard'], gitOpts);
    execFileSync('git', ['clean', '-fd'], gitOpts);
  } catch (err) {
    logger.warn('host_git_commit_failed', { error: (err as Error).message });
  }
}

/**
 * Seed .ax/ directory structure, template files, and default skills into a workspace.
 * Only writes files that don't already exist (won't overwrite agent-customized versions).
 * Used by both local mode (file:// repos) and k8s mode (via seedRemoteRepo).
 */
function seedAxDirectory(workspace: string, gitDir: string, logger: Logger): void {
  const gitEnv = { GIT_DIR: gitDir, GIT_WORK_TREE: workspace };
  const gitOpts = { cwd: workspace, stdio: 'pipe' as const, env: { ...process.env, ...gitEnv } };

  // Ensure .ax/ subdirectories exist
  for (const sub of ['skills', 'policy']) {
    mkdirSync(join(workspace, '.ax', sub), { recursive: true });
  }

  // Seed template files (AGENTS.md, HEARTBEAT.md) into .ax/.
  // BOOTSTRAP.md and USER_BOOTSTRAP.md are static templates loaded directly
  // into the identity payload — they don't need to be in git.
  let tDir: string;
  try { tDir = resolveTemplatesDir(); } catch { tDir = ''; }
  if (tDir && existsSync(tDir)) {
    for (const file of ['AGENTS.md', 'HEARTBEAT.md']) {
      const srcPath = join(tDir, file);
      const destPath = join(workspace, '.ax', file);
      if (existsSync(srcPath) && !existsSync(destPath)) {
        try { writeFileSync(destPath, readFileSync(srcPath, 'utf-8')); }
        catch (err) { logger.debug('ax_seed_template_failed', { file, error: (err as Error).message }); }
      }
    }
  }

  // Seed default skills from project skills/ directory into .ax/skills/.
  // File-based skills (default.md) become .ax/skills/default/SKILL.md.
  // Directory-based skills (deploy/SKILL.md) keep their structure.
  let sDir: string;
  try { sDir = resolveSeedSkillsDir(); } catch { sDir = ''; }
  if (sDir && existsSync(sDir)) {
    try {
      const entries = readdirSync(sDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('.md')) {
          // File-based skill: default.md → .ax/skills/default/SKILL.md
          const skillName = entry.name.replace(/\.md$/, '');
          const destDir = join(workspace, '.ax', 'skills', skillName);
          const destPath = join(destDir, 'SKILL.md');
          if (!existsSync(destPath)) {
            mkdirSync(destDir, { recursive: true });
            writeFileSync(destPath, readFileSync(join(sDir, entry.name), 'utf-8'));
            logger.debug('ax_seed_skill', { skill: skillName });
          }
        } else if (entry.isDirectory()) {
          // Directory-based skill: copy entire directory (preserves companion files)
          const srcDir = join(sDir, entry.name);
          const destDir = join(workspace, '.ax', 'skills', entry.name);
          if (existsSync(join(srcDir, 'SKILL.md')) && !existsSync(destDir)) {
            cpSync(srcDir, destDir, { recursive: true });
            logger.debug('ax_seed_skill', { skill: entry.name });
          }
        }
      }
    } catch (err) {
      logger.debug('ax_seed_skills_failed', { error: (err as Error).message });
    }
  }

  // Commit seed files if anything was added
  try {
    execFileSync('git', ['add', '.ax/'], gitOpts);
    const status = execFileSync('git', ['status', '--porcelain', '--', '.ax/'],
      { ...gitOpts, encoding: 'utf-8' }).trim();
    if (status) {
      execFileSync('git', ['commit', '-m', 'init: seed .ax/ directory structure and templates'], gitOpts);
    }
  } catch (err) {
    logger.debug('ax_seed_skip', { reason: (err as Error).message });
  }
}

/**
 * Seed .ax/ templates into a remote (HTTP) repo.
 * Used for k8s mode where the host doesn't maintain a persistent working tree.
 * Creates a temporary clone, seeds templates, commits, and pushes.
 * No-op if the repo already has .ax/ content.
 */
function seedRemoteRepo(repoUrl: string, logger: Logger): void {
  const tmpWs = mkdtempSync(join(tmpdir(), 'ax-seed-ws-'));
  const tmpGit = mkdtempSync(join(tmpdir(), 'ax-seed-git-'));
  try { rmSync(tmpGit, { recursive: true }); } catch { /* git clone needs non-existent target */ }
  try {
    // Clone with separate gitdir (same pattern as hostGitSync)
    execFileSync('git', [
      'clone', '--separate-git-dir', tmpGit, repoUrl, tmpWs,
    ], { stdio: 'pipe' });
    // Ensure main branch
    const gitEnv = { GIT_DIR: tmpGit, GIT_WORK_TREE: tmpWs };
    const gitOpts = { cwd: tmpWs, stdio: 'pipe' as const, env: { ...process.env, ...gitEnv } };
    try { execFileSync('git', ['checkout', 'main'], gitOpts); } catch {
      try { execFileSync('git', ['checkout', '-b', 'main'], gitOpts); } catch { /* already on main */ }
    }
    execFileSync('git', ['config', 'user.email', 'ax-host@ax.local'], gitOpts);
    execFileSync('git', ['config', 'user.name', 'ax-host'], gitOpts);

    // Seed templates + commit (reuses seedAxDirectory logic)
    seedAxDirectory(tmpWs, tmpGit, logger);

    // Push to remote (only if there's a new commit)
    try {
      execFileSync('git', ['push', '-u', 'origin', 'main'], gitOpts);
      logger.info('seed_remote_pushed', { repoUrl });
    } catch {
      logger.debug('seed_remote_push_skip', { repoUrl, reason: 'nothing to push or push failed' });
    }
  } catch (err) {
    logger.debug('seed_remote_failed', { repoUrl, error: (err as Error).message });
  } finally {
    try { rmSync(tmpWs, { recursive: true, force: true }); } catch { /* best effort */ }
    try { rmSync(tmpGit, { recursive: true, force: true }); } catch { /* best effort */ }
  }
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
  let sessionId = preProcessed?.sessionId ?? persistentSessionId ?? randomUUID();
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

  // ── Fast path: in-process LLM loop (no pod, no IPC, no proxy) ──
  // Resolve turn layer before setting up any sandbox infrastructure.
  const { resolveTurnLayer, runFastPath } = await import('./inprocess.js');
  const { hasActiveSandbox } = await import('./sandbox-manager.js');
  const sandboxAlive = providers.storage?.documents
    ? await hasActiveSandbox(providers.storage.documents, sessionId)
    : false;
  const turnLayer = resolveTurnLayer(config, {
    sandboxPod: sandboxAlive ? { alive: true } : undefined,
  });

  if (turnLayer === 'in-process') {
    if (!providers.storage?.documents) {
      reqLogger.warn('fast_path_skip_no_documents');
      // Fall through to sandbox path below
    } else {
    const currentUserId = userId ?? 'anonymous';
    const resolvedAgent = userId && deps.provisioner
      ? await deps.provisioner.resolveAgent(userId)
      : undefined;
    const agentId = resolvedAgent?.id ?? config.agent_name;

    // Rewrite placeholder workspace '_' with the resolved agent ID (same as sandbox path)
    if (agentId) {
      sessionId = rewriteSessionPlaceholder(sessionId, agentId);
      if (persistentSessionId) {
        persistentSessionId = rewriteSessionPlaceholder(persistentSessionId, agentId);
      }
    }

    try {
      const fastResult = await runFastPath(
        {
          message: textContent,
          sessionId,
          requestId,
          agentId,
          userId: currentUserId,
          clientHistory: clientMessages,
          persistentSessionId,
        },
        {
          config,
          providers,
          conversationStore,
          documents: providers.storage.documents,
          router,
          taintBudget,
          sessionCanaries,
          logger,
          eventBus,
          workspaceBasePath: '~/.ax/workspaces',
          mcpManager: deps.mcpManager,
        },
      );

      // Complete the queued message
      await db.complete(queued.id);

      // Outbound scan
      const canaryToken = sessionCanaries.get(sessionId) ?? result.canaryToken;
      const outbound = await router.processOutbound(fastResult.responseContent, sessionId, canaryToken);

      eventBus?.emit({
        type: 'scan.outbound',
        requestId,
        timestamp: Date.now(),
        data: { verdict: outbound.scanResult.verdict, canaryLeaked: outbound.canaryLeaked },
      });

      const finishReason = outbound.scanResult.verdict === 'BLOCK' ? 'content_filter' as const : 'stop' as const;
      eventBus?.emit({
        type: 'completion.done',
        requestId,
        timestamp: Date.now(),
        data: { finishReason, responseLength: outbound.content.length, sessionId },
      });

      return {
        responseContent: outbound.content,
        agentName: agentId,
        userId: currentUserId,
        finishReason,
      };
    } catch (err) {
      await db.fail(queued.id);
      reqLogger.error('fast_path_error', { error: (err as Error).message });
      return { responseContent: `Fast path error: ${(err as Error).message}`, finishReason: 'stop' };
    }
    } // end documents guard
  }

  // ── Sandbox path (existing flow) ──
  let workspace = '';
  let proxyCleanup: (() => void) | undefined;
  let webProxyCleanup: (() => void) | undefined;
  let toolMountRoot: { mountRoot: string; cleanup: () => void } | undefined;
  let hostManagedGit = false;
  // Host-owned git: host commits+pushes agent changes (file:// repos with shared FS).
  // Host-readonly git: host clones for identity reading only; agent owns commit+push (http:// repos).
  let hostOwnsGitCommit = false;
  // Bare gitDir for identity-only fetch (http:// repos). Cleaned up in finally block.
  let identityGitDir = '';
  let gitDir = '';
  const currentUserId = userId ?? 'anonymous';
  const sandboxResolvedAgent = userId && deps.provisioner
    ? await deps.provisioner.resolveAgent(userId)
    : undefined;
  const agentId = sandboxResolvedAgent?.id ?? config.agent_name;

  // Rewrite placeholder workspace '_' with the resolved agent ID.
  // parseChatRequest uses '_' as workspace; processCompletion replaces it
  // after the provisioner resolves the actual agent.
  if (agentId) {
    sessionId = rewriteSessionPlaceholder(sessionId, agentId);
    if (persistentSessionId) {
      persistentSessionId = rewriteSessionPlaceholder(persistentSessionId, agentId);
    }
  }

  // Register session context so the credential provide endpoint can resolve
  // agentId/userId from just a sessionId (client doesn't send these).
  setSessionCredentialContext(sessionId, { agentName: agentId, userId: currentUserId });

  try {
    // Reuse workspace from a previous turn if the session manager has it.
    // The workspace directory (with cloned git repo, installed deps) persists
    // across turns — only the container process is fresh each turn.
    // hostGitCommit does git reset --hard + git clean -fd after each turn
    // to prevent prompt-injected files from persisting.
    const prevSession = deps.sessionManager?.get(sessionId);
    if (prevSession?.workspace && prevSession?.gitDir && existsSync(prevSession.workspace)) {
      workspace = prevSession.workspace;
      gitDir = prevSession.gitDir;
      reqLogger.debug('workspace_reuse', { workspace, gitDir, sessionId });
      // Pull latest from the repo (another turn may have pushed).
      // Only needed for file:// repos where the host owns the working tree.
      if (existsSync(join(gitDir, 'HEAD'))) {
        const gitEnv = { GIT_DIR: gitDir, GIT_WORK_TREE: workspace };
        const gitOpts = { cwd: workspace, stdio: 'pipe' as const, env: { ...process.env, ...gitEnv } };
        // Determine if host owns commits from the remote URL type.
        try {
          const remote = execFileSync('git', ['remote', 'get-url', 'origin'], { ...gitOpts, encoding: 'utf-8' }).trim();
          hostOwnsGitCommit = remote.startsWith('file://') || remote.startsWith('/');
        } catch { hostOwnsGitCommit = true; /* no remote = local repo */ }
        if (hostOwnsGitCommit) {
          try { execFileSync('git', ['pull', '--rebase', 'origin', 'main'], gitOpts); } catch { /* first push or no remote */ }
        } else if (providers.workspace) {
          // HTTP repo reuse — lightweight fetch for identity reading
          try {
            const { url: repoUrl } = await providers.workspace.getRepoUrl(agentId);
            const result = fetchIdentityFromRemote(repoUrl);
            identityGitDir = result.gitDir;
          } catch { /* identity fetch failed — will use empty */ }
        }
        hostManagedGit = true;
      }
    } else {
      workspace = mkdtempSync(join(tmpdir(), 'ax-ws-'));
      // Separate gitdir keeps .git metadata outside workspace (agent can't see it).
      // Use mkdtempSync to get a unique path, then remove it — git clone
      // --separate-git-dir needs the target to NOT exist (it creates it itself).
      gitDir = mkdtempSync(join(tmpdir(), 'ax-git-'));
      try { rmSync(gitDir, { recursive: true }); } catch { /* best effort */ }
    }

    // Git repo is the persistence layer — always sync for persistent sessions.
    // Two strategies based on URL scheme:
    //  - file:// (local/subprocess): Full clone+checkout. Host manages workspace,
    //    commits agent changes, seeds templates. Shared filesystem with agent.
    //  - http:// (k8s): Lightweight bare fetch (depth 1). Host only reads identity
    //    files — no working tree checkout. The sidecar in the sandbox pod owns
    //    the full workspace clone, commit, and push lifecycle.
    if (!hostManagedGit && providers.workspace) {
      const { url: repoUrl, created: repoCreated } = await providers.workspace.getRepoUrl(agentId);
      if (repoUrl.startsWith('file://')) {
        // file:// — full clone, host owns commit+push
        try {
          hostGitSync(workspace, gitDir, repoUrl, reqLogger);
          seedAxDirectory(workspace, gitDir, reqLogger);
          hostManagedGit = true;
          hostOwnsGitCommit = true;
        } catch (err) {
          reqLogger.warn('host_git_sync_failed', { error: (err as Error).message });
        }
      } else {
        // http:// — fetch identity, seed if repo is empty
        try {
          if (repoCreated) {
            seedRemoteRepo(repoUrl, reqLogger);
            clearIdentityCache();
          }
          const result = fetchIdentityFromRemote(repoUrl);
          // Fallback: seed if identity is empty (handles retry race where
          // created=false but repo has no content yet)
          if (!repoCreated && Object.keys(result.identity).length === 0) {
            try { rmSync(result.gitDir, { recursive: true, force: true }); } catch { /* best effort */ }
            seedRemoteRepo(repoUrl, reqLogger);
            clearIdentityCache();
            const seeded = fetchIdentityFromRemote(repoUrl);
            identityGitDir = seeded.gitDir;
          } else {
            identityGitDir = result.gitDir;
          }
          hostManagedGit = true;
          hostOwnsGitCommit = false;
        } catch (err) {
          reqLogger.warn('host_identity_fetch_failed', { error: (err as Error).message });
        }
      }
    } else if (!hostManagedGit && persistentSessionId) {
      // No workspace provider — init a bare repo at ~/.ax/data/repos/{agentId}
      const repoPath = join(dataDir(), 'repos', agentId);
      const repoUrl = `file://${repoPath}`;
      if (!existsSync(repoPath)) {
        mkdirSync(repoPath, { recursive: true });
        execFileSync('git', ['init', '--bare', '--initial-branch=main'], { cwd: repoPath, stdio: 'pipe' });
      }
      try {
        hostGitSync(workspace, gitDir, repoUrl, reqLogger);
        seedAxDirectory(workspace, gitDir, reqLogger);
        hostManagedGit = true;
        hostOwnsGitCommit = true;
      } catch (err) {
        reqLogger.warn('host_git_sync_failed', { error: (err as Error).message });
      }
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
    // Container sandboxes get a Unix socket; local mode gets a TCP port.
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
      const caDir = join(dataDir(), 'ca');
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
        // TCP mode — docker or k8s (k8s uses separate port in host-process.ts)
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

    // No separate agent/user workspace — single /workspace model.

    // Resolve uploaded file/image references: download from GCS (or local), provision
    // to sandbox workspace, and convert file blocks to inline data so the LLM can
    // see the content regardless of which pod processes the request.
    if (Array.isArray(content)) {
      const resolvedContent: ContentBlock[] = [];
      for (const block of content) {
        if (block.type !== 'file' && block.type !== 'image') {
          resolvedContent.push(block);
          continue;
        }
        const fid = 'fileId' in block ? (block as { fileId: string }).fileId : undefined;
        if (!fid) { resolvedContent.push(block); continue; }
        try {
          let data: Buffer | undefined;
          if (deps.gcsFileStorage) {
            // Verify file exists in our store before downloading from GCS
            if (deps.fileStore) {
              const entry = await deps.fileStore.lookup(fid);
              if (!entry) {
                resolvedContent.push(block);
                reqLogger.warn('file_resolve_unauthorized', { fileId: fid });
                continue;
              }
            }
            data = await deps.gcsFileStorage.download(fid);
          } else if (deps.fileStore) {
            const entry = await deps.fileStore.lookup(fid);
            if (entry) {
              const segments = fid.split('/').filter(Boolean);
              const srcPath = safePath(workspace, ...segments);
              if (existsSync(srcPath)) data = readFileSync(srcPath);
            }
          }
          if (data) {
            // Write to local workspace for agent tool access (local mode)
            if (workspace) {
              const segments = fid.split('/').filter(Boolean);
              const destPath = safePath(workspace, ...segments);
              mkdirSync(dirname(destPath), { recursive: true });
              writeFileSync(destPath, data);
            }
            // Convert to inline content so the LLM sees the file.
            // Text-based files become text blocks (pi-session runner only reads text blocks).
            // Binary files (images, PDFs) become base64 data blocks for toAnthropicContent.
            if (block.type === 'file') {
              const fb = block as { fileId: string; mimeType: string; filename: string };
              const TEXT_MIMES = ['text/plain', 'text/csv', 'text/markdown', 'text/html', 'application/json'];
              if (TEXT_MIMES.includes(fb.mimeType)) {
                resolvedContent.push({
                  type: 'text',
                  text: `--- ${fb.filename} ---\n${data.toString('utf-8')}\n--- end ${fb.filename} ---`,
                });
              } else {
                resolvedContent.push({
                  type: 'file_data',
                  data: data.toString('base64'),
                  mimeType: fb.mimeType,
                  filename: fb.filename,
                });
              }
            } else {
              // image block → image_data
              const ib = block as { fileId: string; mimeType: string };
              resolvedContent.push({
                type: 'image_data',
                data: data.toString('base64'),
                mimeType: ib.mimeType as import('../types.js').ImageMimeType,
              });
            }
            reqLogger.info('file_resolved_inline', { fileId: fid, type: block.type, bytes: data.length });
          } else {
            resolvedContent.push(block);
            reqLogger.warn('file_resolve_no_data', { fileId: fid });
          }
        } catch (err) {
          resolvedContent.push(block);
          reqLogger.warn('file_resolve_failed', { fileId: fid, error: (err as Error).message });
        }
      }
      content = resolvedContent;
    }

    // Pre-load all stored credentials for this agent/user into the sandbox env.
    // When web_proxy is enabled: register as MITM proxy placeholders (the proxy
    // replaces them with real values in intercepted HTTPS traffic).
    // When web_proxy is disabled (local mode): inject real values directly
    // since there's no proxy to do placeholder replacement.
    // Also check global (unscoped) credentials — catches credentials stored
    // without session context or via process.env fallback in the plaintext provider.
    for (const scope of [credentialScope(agentId, currentUserId), credentialScope(agentId), undefined]) {
      try {
        const storedNames = await providers.credentials.list(scope);
        for (const envName of storedNames) {
          // Skip if already registered (user scope takes precedence over agent, agent over global)
          if (credentialMap.toEnvMap()[envName] || credentialEnv[envName]) continue;
          const realValue = await providers.credentials.get(envName, scope);
          if (realValue) {
            if (config.web_proxy) {
              // Container sandboxes: web_proxy is always true — use placeholder
              credentialMap.register(envName, realValue);
            } else {
              // Subprocess sandbox: no proxy — inject real values directly
              credentialEnv[envName] = realValue;
            }
            reqLogger.info('credential_injected', { envName, scope: scope ?? 'global' });
          }
        }
      } catch { /* list may not be supported */ }
    }

    // Create canonical workspace mount info for sandbox tool IPC handlers.
    toolMountRoot = createCanonicalSymlinks({
      workspace,
      ipcSocket: ipcSocketPath,
      command: [],
    });

    // ── Load identity from committed git state ──
    // For http:// repos, identity was already fetched into identityGitDir (bare repo).
    // For file:// repos, read from the full clone's gitDir.
    let identityPayload: IdentityPayload;
    if (identityGitDir) {
      // Bare fetch — read directly, no workspace needed
      identityPayload = loadIdentityFromGit(identityGitDir);
    } else if (workspace && gitDir) {
      identityPayload = loadIdentityFromGit(gitDir);
    } else {
      identityPayload = {} as IdentityPayload;
    }

    // Load static templates from disk.
    // BOOTSTRAP.md and USER_BOOTSTRAP.md always come from templates/ (not git).
    // AGENTS.md and HEARTBEAT.md fall back to templates/ if not in git.
    {
      let tDir: string;
      try { tDir = resolveTemplatesDir(); } catch { tDir = ''; }
      if (tDir && existsSync(tDir)) {
        // Always from templates — static bootstrap instructions
        const bootstrapSrc = join(tDir, 'BOOTSTRAP.md');
        if (existsSync(bootstrapSrc)) identityPayload.bootstrap = readFileSync(bootstrapSrc, 'utf-8');
        const ubSrc = join(tDir, 'USER_BOOTSTRAP.md');
        if (existsSync(ubSrc)) identityPayload.userBootstrap = readFileSync(ubSrc, 'utf-8');
        // Fallback from templates — only if not already in git
        if (!identityPayload.agents) {
          const src = join(tDir, 'AGENTS.md');
          if (existsSync(src)) identityPayload.agents = readFileSync(src, 'utf-8');
        }
        if (!identityPayload.heartbeat) {
          const src = join(tDir, 'HEARTBEAT.md');
          if (existsSync(src)) identityPayload.heartbeat = readFileSync(src, 'utf-8');
        }
      }
    }

    // Skills live in the git workspace at .ax/skills/ — no DB loading needed.
    // The agent reads them directly from the workspace filesystem.

    // ── Generate MCP CLI tools ──
    let mcpCLIsPayload: Array<{ path: string; content: string }> | undefined;
    if (deps.mcpManager) {
      try {
        const resolveHeaders = providers.credentials
          ? async (h: Record<string, string>) => {
              const { resolveHeaders: rh } = await import('../providers/mcp/database.js');
              return rh(JSON.stringify(h), providers.credentials);
            }
          : undefined;
        // For servers without explicit headers, try to find a matching credential
        // by convention: SERVER_NAME_API_KEY, SERVER_NAME_ACCESS_TOKEN, etc.
        const authForServer = providers.credentials
          ? async (server: { name: string; url: string }) => {
              const prefix = server.name.toUpperCase().replace(/-/g, '_');
              const candidates = [
                `${prefix}_API_KEY`,
                `${prefix}_ACCESS_TOKEN`,
                `${prefix}_OAUTH_TOKEN`,
                `${prefix}_TOKEN`,
              ];
              for (const envName of candidates) {
                const value = await providers.credentials.get(envName);
                if (value) return { Authorization: `Bearer ${value}` };
              }
              return undefined;
            }
          : undefined;
        // Only discover tools from servers assigned to this agent (agent_mcp_servers).
        // If no assignments exist, discover from all servers (backward compat).
        let serverFilter: Set<string> | undefined;
        if (providers.database) {
          try {
            const { listAgentServerNames } = await import('../providers/mcp/database.js');
            const assigned = await listAgentServerNames(providers.database.db, agentId);
            serverFilter = new Set(assigned);
          } catch { /* table may not exist yet — leave filter undefined (all servers) */ }
        }
        const mcpTools = await deps.mcpManager.discoverAllTools(agentId, { resolveHeaders, authForServer, serverFilter });
        if (mcpTools.length > 0) {
          const { prepareMcpCLIs } = await import('./capnweb/generate-and-cache.js');
          const clis = await prepareMcpCLIs({ agentName: agentId, tools: mcpTools });
          if (clis && clis.length > 0) mcpCLIsPayload = clis;
        }
      } catch (err) {
        reqLogger.warn('mcp_cli_generation_failed', { error: (err as Error).message });
      }
    } else if (providers.mcp && providers.mcp.listTools) {
      // @deprecated Legacy fallback: no manager, use providers.mcp directly.
      try {
        const { prepareMcpCLIs } = await import('./capnweb/generate-and-cache.js');
        const mcpTools = await providers.mcp.listTools();
        const clis = await prepareMcpCLIs({ agentName: agentId, tools: mcpTools });
        if (clis && clis.length > 0) mcpCLIsPayload = clis;
      } catch (err) {
        reqLogger.warn('mcp_cli_generation_failed', { error: (err as Error).message });
      }
    }

    // Identity and skills are delivered to the agent via stdin payload (below).

    // ── Workspace GCS prefixes ──
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
      // Per-turn IPC token for HTTP IPC authentication
      ipcToken: deps.extraSandboxEnv?.AX_IPC_TOKEN,
      // Web proxy URL — k8s pods don't have this in their pod spec
      webProxyUrl: deps.extraSandboxEnv?.AX_WEB_PROXY_URL,
      // Enterprise fields
      agentId,
      // Identity from git, skills from .ax/skills/ in workspace
      identity: identityPayload,
      mcpCLIs: mcpCLIsPayload,
      // Credential placeholders — k8s pods don't have these in their pod spec,
      // so include them in the payload for the agent to set via process.env.
      credentialEnv: {
        ...credentialMap.toEnvMap(),
        // Subprocess sandbox (no proxy): deliver real values via payload
        ...(!config.web_proxy ? credentialEnv : {}),
      },
      // MITM CA cert — sandbox pods need this to trust the proxy's TLS certs.
      caCert: caCertPem,
      // Single-turn mode: sandbox exits after this turn (cron, heartbeat, delegation).
      ...(deps.singleTurn ? { singleTurn: true } : {}),
    });

    // Spawn, run, and collect agent output — with retry on transient crashes.
    // Transient: OOM kill (137), segfault (139), generic crash with retryable stderr.
    // Permanent: auth failures, bad config, content filter blocks.

    // Calculate workspace repository URL for the agent's sandbox.
    // For file:// URLs (git-local with subprocess sandbox), the host manages git on a
    // shared filesystem — don't pass URL to agent.
    // For http:// URLs (k8s), the host clones for identity reading but the agent ALSO
    // needs its own clone in the sandbox pod for file persistence (commit+push at turn end).
    let workspaceRepoUrl: string | undefined;
    if (providers.workspace) {
      const { url: repoUrl } = await providers.workspace.getRepoUrl(agentId);
      if (!repoUrl.startsWith('file://')) {
        workspaceRepoUrl = repoUrl;
      }
    }

    const sandboxConfig = {
      workspace,
      ipcSocket: ipcSocketPath,
      // Session-long sandboxes: session manager owns idle lifecycle.
      // watchPodExit's safety timer is a distant backstop (24h) so it never races
      // with the session manager's idle timer or premature watch disconnects.
      timeoutSec: deps.sessionManager
        ? 86400
        : config.sandbox.timeout_sec,
      memoryMB: config.sandbox.memory_mb,
      cpus: 1,
      command: spawnCommand,
      extraEnv: {
        ...deps.extraSandboxEnv,
        // Web proxy — agent runners detect these to start bridge / set HTTP_PROXY
        ...(webProxyPort ? { AX_PROXY_LISTEN_PORT: String(webProxyPort) } : {}),
        // Credential placeholders + CA trust env vars for MITM proxy
        ...credentialMap.toEnvMap(),
        ...credentialEnv,
        // Workspace repository URL for git clone (non-file:// URLs only; host manages file://)
        ...(workspaceRepoUrl ? { WORKSPACE_REPO_URL: workspaceRepoUrl } : {}),
      },
    };

    let response = '';
    let stderr = '';
    let exitCode = 1;

    for (let attempt = 0; attempt <= MAX_AGENT_RETRIES; attempt++) {
      response = '';
      stderr = '';
      const attemptStartTime = Date.now();

      // Session-long sandboxes: reuse existing sandbox if available (k8s only).
      // Apple Container / Docker: fresh container each turn, workspace reuse via git.
      const existingSession = deps.sessionManager?.get(sessionId);
      let proc: Awaited<ReturnType<typeof agentSandbox.spawn>>;

      if (existingSession && deps.agentResponsePromise) {
        // K8s: reuse existing pod — skip spawn, just queue work
        reqLogger.debug('session_reuse', { podName: existingSession.podName, sessionId });
        const { PassThrough } = await import('node:stream');
        const dummyStream = new PassThrough();
        dummyStream.end();
        proc = {
          pid: existingSession.pid,
          podName: existingSession.podName,
          exitCode: new Promise<number>(() => {}), // never resolves — session sandbox stays alive
          stdout: dummyStream,
          stderr: new PassThrough().end() as any,
          stdin: new PassThrough().end() as any,
          kill: existingSession.kill,
        };
      } else {
        // Only show "Starting sandbox…" on k8s (where pod creation is slow).
        // Local containers (docker, apple) boot fast and spawn every turn —
        // showing the status each time is noisy.
        if (isK8s) {
          eventBus?.emit({
            type: 'status',
            requestId,
            timestamp: Date.now(),
            data: {
              operation: 'pod',
              phase: attempt === 0 ? 'creating' : 'retrying',
              message: attempt === 0 ? 'Starting sandbox\u2026' : `Retrying sandbox (attempt ${attempt + 1})\u2026`,
            },
          });
        }
        proc = await agentSandbox.spawn(sandboxConfig);

        // Register newly spawned sandbox for session reuse
        if (deps.sessionManager) {
          deps.sessionManager.register(sessionId, {
            podName: proc.podName,
            pid: proc.pid,
            kill: proc.kill,
            workspace,
            gitDir,
            authToken: deps.extraSandboxEnv?.AX_IPC_TOKEN,
          });

          // Safety net: clean up session if sandbox exits unexpectedly
          // (OOM kill, node crash, watch disconnect) so the next turn
          // spawns a fresh sandbox.
          const podName = proc.podName;
          const podKill = proc.kill;
          proc.exitCode.then(() => {
            reqLogger.info('session_exit_detected', { sessionId, podName });
            podKill();
            deps.sessionManager?.remove(sessionId);
          }).catch(() => {
            podKill();
            deps.sessionManager?.remove(sessionId);
          });
        }
      }
      reqLogger.debug('agent_spawn', { sandbox: config.providers.sandbox, attempt });
      eventBus?.emit({
        type: 'completion.agent',
        requestId,
        timestamp: Date.now(),
        data: { agentType, attempt, sessionId },
      });

      // Apple containers use an IPC bridge via --publish-socket / virtio-vsock.
      // Bridge is per-turn: created, used for IPC during the turn, then
      // cleaned up when the container exits (no explicit close needed).
      // The workspace directory persists across turns (stored in session entry).

      // Set up per-turn promise for agent_response (bridge or k8s mode).
      let bridgeResponseResolve: ((content: string) => void) | undefined;
      const bridgeResponsePromise = proc.bridgeSocketPath
        ? new Promise<string>((resolve) => { bridgeResponseResolve = resolve; })
        : undefined;

      // Collect stdout and stderr for diagnostics.
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
          if (ipcReadyResolve && text.includes('[signal] ipc_ready')) {
            ipcReadyResolve();
            ipcReadyResolve = undefined;
          }
          if (deps.verbose) {
            for (const line of text.split('\n').filter((l: string) => l.trim())) {
              const tagMatch = line.match(/^\[([\w-]+)\]\s*(.*)/);
              if (tagMatch) {
                reqLogger.debug(`agent_${tagMatch[1]}`, { message: tagMatch[2] });
              } else if (!line.trimStart().startsWith('{')) {
                reqLogger.debug('agent_stderr', { line });
              }
            }
          }
        }
        ipcReadyResolve?.();
      })();

      if (proc.bridgeSocketPath && deps.ipcHandler) {
        // Wait for agent's listener to be ready (with timeout).
        let readyTimerId: ReturnType<typeof setTimeout> | undefined;
        let signaled = false;
        const readyTimeout = new Promise<void>(r => { readyTimerId = setTimeout(r, 15_000); });
        const signalWithCleanup = ipcReadyPromise!.then(() => { signaled = true; });
        await Promise.race([signalWithCleanup, readyTimeout]);
        if (readyTimerId !== undefined) clearTimeout(readyTimerId);
        reqLogger.debug('ipc_agent_ready', {
          bridgeSocketPath: proc.bridgeSocketPath,
          signaled,
        });

        try {
          const bridgeCtx = { sessionId, agentId, userId: currentUserId };
          const bridgeHandler = async (raw: string, ctx: import('./ipc-server.js').IPCContext): Promise<string> => {
            try {
              const parsed = JSON.parse(raw);
              if (parsed.action === 'agent_response') {
                bridgeResponseResolve?.(parsed.content ?? '');
                return JSON.stringify({ ok: true });
              }
            } catch { /* fall through to real handler */ }
            return deps.ipcHandler!(raw, ctx);
          };
          await connectIPCBridge(proc.bridgeSocketPath, bridgeHandler, bridgeCtx);
          reqLogger.debug('ipc_bridge_connected', { bridgeSocketPath: proc.bridgeSocketPath });
        } catch (err) {
          reqLogger.error('ipc_bridge_failed', {
            error: (err as Error).message,
            bridgeSocketPath: proc.bridgeSocketPath,
            signaled,
          });
          try { proc.stdin.end(); } catch { /* ignore */ }
          agentSandbox.kill(proc.pid);
        }
      }

      // Deliver work payload to the agent.
      if (deps.agentResponsePromise) {
        // K8s HTTP mode: queue work for agent to fetch via GET /internal/work
        if (deps.sessionManager) {
          deps.sessionManager.queueWork(sessionId, stdinPayload);
          reqLogger.debug('work_queued', { sessionId });
        }
        deps.startAgentResponseTimer?.();
      } else {
        // Stdin mode (docker, apple, subprocess): deliver via stdin
        try {
          reqLogger.debug('stdin_write', { payloadBytes: stdinPayload.length });
          proc.stdin.write(stdinPayload);
          proc.stdin.end();
        } catch {
          // Process already killed (bridge failure) — stdin write throws EPIPE
        }
      }

      // Wait for agent to complete.
      // K8s HTTP mode: response comes via agent_response IPC (agentResponsePromise).
      // Apple Container bridge mode: response comes via agent_response IPC (bridgeResponsePromise).
      // Stdin mode: response comes from stdout.
      const effectiveResponsePromise = deps.agentResponsePromise ?? bridgeResponsePromise;
      let agentResponseReceived = false;
      if (effectiveResponsePromise) {
        // Response comes via IPC (k8s or Apple Container bridge).
        try {
          response = await effectiveResponsePromise;
          agentResponseReceived = true;
          reqLogger.debug('agent_response_received', { responseLength: response.length });
        } catch (err) {
          reqLogger.warn('agent_response_error', { error: (err as Error).message });
          // Fall through to let exitCode determine retry
        }

        if (agentResponseReceived) {
          exitCode = 0;
          // Session-long sandboxes stay alive for reuse — idle timeout handles cleanup.
          // Only kill if session manager is not tracking this session.
          if (!deps.sessionManager?.has(sessionId)) {
            proc.kill();
          }
        } else {
          // Don't block indefinitely on session sandboxes — they stay alive for reuse,
          // so proc.exitCode may never resolve. Race against a short timeout.
          if (deps.sessionManager?.has(sessionId)) {
            exitCode = 1; // Trigger retry logic
          } else {
            exitCode = await proc.exitCode;
          }
        }
      } else {
        await Promise.all([stdoutDone, stderrDone]);
        exitCode = await proc.exitCode;
      }
      // Don't close bridge explicitly — the container exits after each turn
      // and the socket cleans up naturally. Closing early races with the
      // {ok: true} response flush, causing the agent's agent_response IPC
      // call to time out (harmless but noisy).

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
        } else if (line.trim() && !line.trimStart().startsWith('{')) {
          // Skip structured JSON logs (agent pino output) — only collect unstructured stderr
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
      const extracted = await extractImageDataBlocks(withScannedText, workspace, reqLogger, deps.gcsFileStorage);
      responseBlocks = extracted.blocks;
      if (extracted.extractedFiles.length > 0) {
        extractedFiles = extracted.extractedFiles;
        // Register extracted files in the file store for fileId-only lookups
        if (deps.fileStore) {
          for (const ef of extracted.extractedFiles) {
            await deps.fileStore.register(ef.fileId, agentId, currentUserId, ef.mimeType);
          }
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
    return { responseContent: outbound.content, contentBlocks: responseBlocks, extractedFiles, agentName: agentId, userId: currentUserId, finishReason };

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
    // Post-turn git handling depends on who owns the commit lifecycle.
    if (hostOwnsGitCommit && hostManagedGit && workspace && gitDir) {
      // file:// repos: host commits+pushes, then resets working tree.
      hostGitCommit(workspace, gitDir, reqLogger);
      clearIdentityCache();
    }

    // Clean up workspace/gitDir temp directories.
    // Skip if session manager is tracking (persists for next turn).
    if (!deps.sessionManager?.has(sessionId)) {
      if (workspace) {
        try { rmSync(workspace, { recursive: true, force: true }); } catch {
          reqLogger.debug('workspace_cleanup_failed', { workspace });
        }
      }
      if (gitDir) {
        try { rmSync(gitDir, { recursive: true, force: true }); } catch {
          reqLogger.debug('gitdir_cleanup_failed', { gitDir });
        }
      }
    }
    // Always clean up identity-only bare fetch dir (not tracked by session manager).
    if (identityGitDir) {
      try { rmSync(identityGitDir, { recursive: true, force: true }); } catch { /* best effort */ }
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

