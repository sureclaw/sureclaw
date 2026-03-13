// src/host/agent-runtime-process.ts — Standalone agent runtime pod process.
//
// Claims session requests from NATS queue group, runs processCompletion,
// publishes events and results back via NATS. This is the "conversation plane"
// in the k8s (Kubernetes) architecture.
//
// Responsibilities:
//   - NATS queue group subscriber for session.request.*
//   - Runs processCompletion (agent conversation loop)
//   - NATS-based tool dispatch for bash/file IPC handlers (k8s sandbox)
//   - NATS-based LLM proxy for claude-code pods
//   - Publishes events to NATS EventBus, results to results.{requestId}

import { createServer as createHttpServer } from 'node:http';
import { mkdirSync, mkdtempSync, existsSync, copyFileSync, readFileSync, writeFileSync, unlinkSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { getLogger } from '../logger.js';
import { loadConfig } from '../config.js';
import { loadProviders } from './registry.js';
import { createRouter } from './router.js';
import { createIPCHandler, createIPCServer, type DelegateRequest, type IPCContext } from './ipc-server.js';
import { TaintBudget, thresholdForProfile } from './taint-budget.js';
import { processCompletion, type CompletionDeps } from './server-completions.js';
import { createOrchestrator } from './orchestration/orchestrator.js';
import { createAgentRegistry } from './agent-registry.js';
import { FileStore } from '../file-store.js';
import { axHome, dataDir, agentDir as agentDirPath, agentIdentityDir, agentIdentityFilesDir, agentSkillsDir } from '../paths.js';
import { templatesDir as resolveTemplatesDir, seedSkillsDir as resolveSeedSkillsDir } from '../utils/assets.js';
import { initTracing, shutdownTracing } from '../utils/tracing.js';
import {
  encode, decode,
  resultSubject,
  AGENT_RUNTIME_QUEUE_GROUP,
  type SessionRequest, type SessionResult,
} from './nats-session-protocol.js';
import type { EventBus } from './event-bus.js';
import { createNATSSandboxDispatcher, type NATSSandboxDispatcher } from './nats-sandbox-dispatch.js';
import { startNATSLLMProxy } from './nats-llm-proxy.js';

const logger = getLogger().child({ component: 'agent-runtime' });

async function main(): Promise<void> {
  await initTracing();

  const config = loadConfig();
  const providers = await loadProviders(config);
  const eventBus: EventBus = providers.eventbus;

  // ── Initialize storage, routing, IPC ──

  mkdirSync(dataDir(), { recursive: true });
  const db = providers.storage.messages;
  const conversationStore = providers.storage.conversations;
  const taintBudget = new TaintBudget({ threshold: thresholdForProfile(config.profile) });
  const router = createRouter(providers, db, { taintBudget });

  const agentName = 'main';
  const agentDirVal = agentDirPath(agentName);
  const agentConfigDir = agentIdentityDir(agentName);
  const identityFilesDir = agentIdentityFilesDir(agentName);
  mkdirSync(agentDirVal, { recursive: true });
  mkdirSync(agentConfigDir, { recursive: true });
  mkdirSync(identityFilesDir, { recursive: true });

  // Template seeding (same as server.ts)
  const templatesDir = resolveTemplatesDir();
  const bootstrapAlreadyComplete =
    existsSync(join(identityFilesDir, 'SOUL.md')) && existsSync(join(identityFilesDir, 'IDENTITY.md'));

  for (const file of ['AGENTS.md', 'HEARTBEAT.md']) {
    const dest = join(identityFilesDir, file);
    const src = join(templatesDir, file);
    if (!existsSync(dest) && existsSync(src)) copyFileSync(src, dest);
  }
  for (const file of ['capabilities.yaml']) {
    const dest = join(agentConfigDir, file);
    const src = join(templatesDir, file);
    if (!existsSync(dest) && existsSync(src)) copyFileSync(src, dest);
  }
  if (!bootstrapAlreadyComplete) {
    const src = join(templatesDir, 'BOOTSTRAP.md');
    if (existsSync(src)) {
      if (!existsSync(join(agentConfigDir, 'BOOTSTRAP.md'))) copyFileSync(src, join(agentConfigDir, 'BOOTSTRAP.md'));
      if (!existsSync(join(identityFilesDir, 'BOOTSTRAP.md'))) copyFileSync(src, join(identityFilesDir, 'BOOTSTRAP.md'));
    }
  }

  // Skills seeding
  const persistentSkillsDir = agentSkillsDir(agentName);
  mkdirSync(persistentSkillsDir, { recursive: true });
  try {
    const existingSkills = readdirSync(persistentSkillsDir).filter(f => f.endsWith('.md'));
    if (existingSkills.length === 0) {
      const seedDir = resolveSeedSkillsDir();
      if (existsSync(seedDir)) {
        for (const f of readdirSync(seedDir).filter(f => f.endsWith('.md'))) {
          copyFileSync(join(seedDir, f), join(persistentSkillsDir, f));
        }
      }
    }
  } catch { /* non-fatal */ }

  const defaultUserId = process.env.USER ?? 'default';

  // Admins file
  const adminsPath = join(agentDirVal, 'admins');
  if (!existsSync(adminsPath)) writeFileSync(adminsPath, '', 'utf-8');

  // IPC server
  const ipcSocketDir = mkdtempSync(join(tmpdir(), 'ax-'));
  const ipcSocketPath = join(ipcSocketDir, 'proxy.sock');
  const sessionCanaries = new Map<string, string>();
  const workspaceMap = new Map<string, string>();
  const fileStore = await FileStore.create(providers.database);

  // The agent loop must run as a local subprocess inside this pod, even when
  // providers.sandbox is k8s. The k8s provider creates a NEW k8s pod which
  // can't connect back via Unix socket IPC. k8s is only for tool dispatch
  // (sandbox worker pods), not for the agent conversation loop.
  let agentSandbox = providers.sandbox;
  let sandboxDispatcher: NATSSandboxDispatcher | undefined;
  const requestIdMap = new Map<string, string>();

  if (config.providers.sandbox === 'k8s') {
    const subprocessModule = await import('../providers/sandbox/subprocess.js');
    agentSandbox = await subprocessModule.create(config);

    // Create NATS sandbox dispatcher for tool dispatch to remote sandbox pods.
    // The dispatcher opens its own NATS connection for request/reply isolation.
    sandboxDispatcher = await createNATSSandboxDispatcher();
    logger.info('nats_sandbox_dispatcher_ready');
  }

  const completionDeps: CompletionDeps = {
    config,
    providers: { ...providers, sandbox: agentSandbox },
    db,
    conversationStore,
    router,
    taintBudget,
    sessionCanaries,
    ipcSocketPath,
    ipcSocketDir,
    logger,
    verbose: process.env.AX_VERBOSE === '1',
    fileStore,
    eventBus,
    workspaceMap,
  };

  // Delegation handler
  async function handleDelegate(req: DelegateRequest, ctx: IPCContext): Promise<string> {
    const childConfig = {
      ...config,
      ...(req.runner ? { agent: req.runner } : {}),
      ...(req.model ? { models: { default: [req.model] } } : {}),
      ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
      ...(req.timeoutSec ? { sandbox: { ...config.sandbox, timeout_sec: req.timeoutSec } } : {}),
    };
    const childDeps: CompletionDeps = { ...completionDeps, config: childConfig };
    const taskPrompt = req.context ? `${req.context}\n\n---\n\nTask: ${req.task}` : req.task;
    const requestId = req.requestId ?? `delegate-${randomUUID().slice(0, 8)}`;
    const result = await processCompletion(childDeps, taskPrompt, requestId, [], undefined, undefined, ctx.userId);
    return result.responseContent;
  }

  const orchestrator = createOrchestrator(eventBus, providers.audit);
  const disableAutoState = orchestrator.enableAutoState();
  const agentRegistry = await createAgentRegistry(providers.database);
  await agentRegistry.ensureDefault();

  const handleIPC = createIPCHandler(providers, {
    taintBudget,
    agentDir: identityFilesDir,
    agentName,
    profile: config.profile,
    configModel: config.models?.default?.[0],
    onDelegate: handleDelegate,
    delegation: config.delegation ? {
      maxConcurrent: config.delegation.max_concurrent,
      maxDepth: config.delegation.max_depth,
    } : undefined,
    eventBus,
    orchestrator,
    agentRegistry,
    workspaceMap,
    natsDispatcher: sandboxDispatcher,
    requestIdMap,
  });

  const defaultCtx = { sessionId: 'server', agentId: 'system', userId: defaultUserId };
  const ipcServer = createIPCServer(ipcSocketPath, handleIPC, defaultCtx);

  // ── NATS connection ──

  const natsModule = await import('nats');
  const natsUrl = process.env.NATS_URL ?? 'nats://localhost:4222';
  const nc = await natsModule.connect({
    servers: natsUrl,
    name: `ax-agent-runtime-${process.pid}`,
    reconnect: true,
    maxReconnectAttempts: -1,
    reconnectTimeWait: 1000,
  });
  logger.info('nats_connected', { url: natsUrl });

  // ── Session request consumer ──

  // Subscribe to all session request subjects via queue group.
  // Queue group ensures each request is handled by exactly one runtime pod.
  const sessionSub = nc.subscribe('session.request.*', {
    queue: AGENT_RUNTIME_QUEUE_GROUP,
  });

  logger.info('agent_runtime_ready', {
    subject: 'session.request.*',
    queueGroup: AGENT_RUNTIME_QUEUE_GROUP,
  });

  let running = true;

  // Process session requests
  (async () => {
    for await (const msg of sessionSub) {
      if (!running) break;

      let request: SessionRequest;
      try {
        request = decode<SessionRequest>(msg.data);
      } catch (err) {
        logger.error('session_request_decode_failed', { error: (err as Error).message });
        continue;
      }

      if (request.type !== 'session_request') {
        logger.warn('unexpected_message_type', { type: request.type });
        continue;
      }

      logger.info('session_claimed', {
        requestId: request.requestId,
        sessionId: request.sessionId,
        agentType: request.agentType,
      });

      // Process the completion asynchronously (don't block the message loop)
      void processSessionRequest(request, nc).catch((err) => {
        logger.error('session_processing_failed', {
          requestId: request.requestId,
          error: (err as Error).message,
        });

        // Publish error result
        const errorResult: SessionResult = {
          type: 'session_result',
          requestId: request.requestId,
          responseContent: 'Internal processing error',
          finishReason: 'stop',
          error: (err as Error).message,
        };
        nc.publish(resultSubject(request.requestId), encode(errorResult));
      });
    }
  })().catch((err) => {
    if (running) {
      logger.error('session_consumer_error', { error: (err as Error).message });
    }
  });

  async function processSessionRequest(
    request: SessionRequest,
    nc: import('nats').NatsConnection,
  ): Promise<void> {
    const { requestId, sessionId, content, messages } = request;

    // Register requestId for per-turn pod affinity so sandbox tool handlers
    // can route all tool calls in a turn to the same sandbox pod.
    requestIdMap.set(sessionId, requestId);

    // Start NATS LLM proxy for claude-code sessions in k8s mode.
    // The claude-code sandbox pod uses a NATS bridge to send LLM requests;
    // this proxy subscribes to ipc.llm.{sessionId} and forwards them to
    // the Anthropic API with real credentials.
    let llmProxy: { close: () => void } | undefined;
    if (request.agentType === 'claude-code' && config.providers.sandbox === 'k8s') {
      llmProxy = await startNATSLLMProxy({ sessionId });
      logger.info('nats_llm_proxy_started', { sessionId, requestId });
    }

    try {
      const result = await processCompletion(
        completionDeps,
        content,
        requestId,
        messages,
        request.persistentSessionId,
        request.preProcessed,
        request.userId,
        request.replyOptional,
        request.sessionScope,
      );

      // Publish result to NATS
      const sessionResult: SessionResult = {
        type: 'session_result',
        requestId,
        responseContent: result.responseContent,
        finishReason: result.finishReason,
        contentBlocks: result.contentBlocks,
      };

      nc.publish(resultSubject(requestId), encode(sessionResult));
      logger.info('session_completed', {
        requestId,
        responseLength: result.responseContent.length,
        finishReason: result.finishReason,
      });
    } finally {
      // End-of-turn: release the claimed sandbox pod back to the warm pool
      // and clean up the requestId mapping.
      requestIdMap.delete(sessionId);
      if (sandboxDispatcher?.hasPod(requestId)) {
        await sandboxDispatcher.release(requestId).catch((err) => {
          logger.warn('sandbox_pod_release_failed', {
            requestId,
            error: (err as Error).message,
          });
        });
      }
      // Shut down the per-session NATS LLM proxy for claude-code.
      if (llmProxy) {
        llmProxy.close();
        logger.info('nats_llm_proxy_closed', { sessionId, requestId });
      }
    }
  }

  // ── Health endpoint ──

  const metricsPort = parseInt(process.env.METRICS_PORT ?? '9091', 10);
  const healthServer = createHttpServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  healthServer.listen(metricsPort, () => {
    logger.info('health_server_listening', { port: metricsPort });
  });

  // ── Graceful shutdown ──

  const shutdown = async () => {
    running = false;
    logger.info('agent_runtime_shutting_down');

    sessionSub.unsubscribe();
    disableAutoState();
    orchestrator.shutdown();

    try { ipcServer.close(); } catch { /* ignore */ }
    if (sandboxDispatcher) {
      await sandboxDispatcher.close().catch(() => { /* ignore */ });
    }
    providers.eventbus.close();
    providers.storage.close();
    try { await fileStore.close(); } catch { /* ignore */ }
    healthServer.close();

    await nc.drain();
    await shutdownTracing();

    try { unlinkSync(ipcSocketPath); } catch { /* ignore */ }
    try { rmSync(ipcSocketDir, { recursive: true, force: true }); } catch { /* ignore */ }

    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

main().catch((err) => {
  console.error('[agent-runtime] fatal:', err);
  process.exit(1);
});
