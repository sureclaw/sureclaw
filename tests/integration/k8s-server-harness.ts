/**
 * K8s-mode server test harness.
 *
 * Like server-harness.ts, but wires up the full k8s communication path:
 * - NATS connection for work delivery (publishWork)
 * - /internal/ipc HTTP route for agent → host IPC
 * - Per-turn token registry + agent_response interception
 * - agentResponsePromise for non-stdin response collection
 *
 * Uses processCompletion() directly (same as host-process.ts) instead of
 * going through createServer(), which doesn't support k8s-mode deps.
 *
 * Based on the patterns in tests/providers/sandbox/run-http-local.ts.
 */

import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import { initLogger, resetLogger } from '../../src/logger.js';
import { loadConfig } from '../../src/config.js';
import { loadProviders } from '../../src/host/registry.js';
import { createIPCHandler, createIPCServer, type IPCContext } from '../../src/host/ipc-server.js';
import { processCompletion, type CompletionDeps } from '../../src/host/server-completions.js';
import { sendError, readBody } from '../../src/host/server-http.js';
import { createRouter } from '../../src/host/router.js';
import { TaintBudget, thresholdForProfile } from '../../src/host/taint-budget.js';
import { FileStore } from '../../src/file-store.js';
import { natsConnectOptions } from '../../src/utils/nats.js';
import { createMockWeb, createMockGcsBucket } from './mock-providers.js';
import type { Config, ProviderRegistry } from '../../src/types.js';
import type { LLMProvider } from '../../src/providers/llm/types.js';
import type { SandboxProvider } from '../../src/providers/sandbox/types.js';
import type { GcsBucketLike } from '../../src/providers/workspace/gcs.js';

// Re-export the shared response type
export type { HttpResponse } from './server-harness.js';
import type { HttpResponse } from './server-harness.js';

// ═══════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════

export interface K8sHarnessOptions {
  /** LLM provider (required — use createScriptableLLM). */
  llm: LLMProvider;

  /** Sandbox provider (required — docker-nats or nats-subprocess). */
  sandbox: SandboxProvider;

  /** TCP port for the HTTP server (required — container needs TCP, not Unix socket). */
  port: number;

  /** Full config YAML override. */
  configYaml?: string;

  /** Additional provider overrides. */
  providerOverrides?: Partial<ProviderRegistry>;

  /** Hook called after config is loaded but before server starts. */
  preStart?: (config: Config, home: string) => void | Promise<void>;

  /** Use an existing AX_HOME directory. */
  existingHome?: string;
}

export interface K8sServerHarness {
  /** Path to the AX_HOME temp directory. */
  home: string;

  /** TCP port the server listens on. */
  port: number;

  /** Mock GCS bucket (for workspace assertions). */
  gcsBucket: GcsBucketLike & { files: Map<string, Buffer> };

  /** Send a single user message and wait for the response. */
  sendMessage(content: string, opts?: {
    sessionId?: string;
    user?: string;
    model?: string;
    stream?: boolean;
  }): Promise<HttpResponse>;

  /** Stop the server, close NATS, clean up. */
  dispose(): Promise<void>;
}

// ═══════════════════════════════════════════════════════
// Default config
// ═══════════════════════════════════════════════════════

const DEFAULT_K8S_CONFIG_YAML = `\
profile: paranoid
models:
  default:
    - mock/default
providers:
  memory: cortex
  scanner: guardian
  channels: []
  web: none
  browser: none
  credentials: env
  skills: database
  audit: database
  sandbox: subprocess
  scheduler: plainjob
  storage: database
  eventbus: inprocess
  workspace: local
  screener: static
sandbox:
  timeout_sec: 120
  memory_mb: 256
scheduler:
  active_hours:
    start: "00:00"
    end: "23:59"
    timezone: "UTC"
  max_token_budget: 4096
  heartbeat_interval_min: 30
admin:
  enabled: false
`;

// ═══════════════════════════════════════════════════════
// Token registry (same pattern as host-process.ts)
// ═══════════════════════════════════════════════════════

const activeTokens = new Map<string, {
  handleIPC: (raw: string, ctx: IPCContext) => Promise<string>;
  ctx: IPCContext;
}>();

// ═══════════════════════════════════════════════════════
// Harness factory
// ═══════════════════════════════════════════════════════

export async function createK8sHarness(opts: K8sHarnessOptions): Promise<K8sServerHarness> {
  // Save and override AX_HOME
  const originalAxHome = process.env.AX_HOME;
  const ownsHome = !opts.existingHome;
  const home = opts.existingHome ?? mkdtempSync(join(tmpdir(), 'ax-k8s-test-'));
  process.env.AX_HOME = home;

  // Create required directory structure
  mkdirSync(join(home, 'data'), { recursive: true });
  mkdirSync(join(home, 'agents', 'main', 'agent', 'identity'), { recursive: true });
  mkdirSync(join(home, 'agents', 'main', 'agent', 'skills'), { recursive: true });

  // Write config YAML
  writeFileSync(join(home, 'ax.yaml'), opts.configYaml ?? DEFAULT_K8S_CONFIG_YAML, 'utf-8');

  // Initialize logger in silent mode
  resetLogger();
  initLogger({ file: false, level: 'silent' });

  // Load config
  const config = loadConfig(join(home, 'ax.yaml'));

  // Build mock GCS bucket
  const gcsBucket = createMockGcsBucket();

  // Load providers with overrides
  const web = createMockWeb();
  const providerOverrides: Partial<ProviderRegistry> = {
    llm: opts.llm,
    sandbox: opts.sandbox,
    web,
    ...opts.providerOverrides,
  };
  const providers = await loadProviders(config, { providerOverrides });

  // Pre-start hook
  if (opts.preStart) {
    await opts.preStart(config, home);
  }

  // NATS connection for work publishing
  const natsModule = await import('nats');
  const nc = await natsModule.connect(natsConnectOptions('k8s-harness'));

  // IPC infrastructure
  const ipcSocketDir = mkdtempSync(join(tmpdir(), 'ax-k8s-ipc-'));
  const ipcSocketPath = join(ipcSocketDir, 'proxy.sock');
  const sessionCanaries = new Map<string, string>();
  const workspaceMap = new Map<string, string>();
  const defaultUserId = 'test-user';
  const agentName = 'main';

  const { getLogger } = await import('../../src/logger.js');
  const logger = getLogger().child({ component: 'k8s-harness' });

  const fileStore = await FileStore.create(providers.database);

  const taintBudget = new TaintBudget({ threshold: thresholdForProfile(config.profile) });

  const handleIPC = createIPCHandler(providers, {
    taintBudget,
    agentDir: join(home, 'agents', 'main', 'agent', 'identity'),
    agentName,
    profile: config.profile,
    configModel: config.models?.default?.[0],
    workspaceMap,
  });

  // IPC Unix socket server (fallback — processCompletion expects it)
  await createIPCServer(ipcSocketPath, handleIPC, {
    sessionId: 'server',
    agentId: 'system',
    userId: defaultUserId,
  });

  const router = createRouter(providers, providers.storage.messages, { taintBudget });
  const db = providers.storage.messages;
  const conversationStore = providers.storage.conversations;

  // Base completion deps (per-turn deps are built in sendMessage)
  const baseDeps: CompletionDeps = {
    config,
    providers,
    db,
    conversationStore,
    router,
    taintBudget,
    sessionCanaries,
    ipcSocketPath,
    ipcSocketDir,
    logger,
    verbose: false,
    fileStore,
    workspaceMap,
  };

  // ── HTTP Server with /internal/ipc route ──

  const httpServer = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = req.url ?? '/';

    // Health check
    if (url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    // IPC over HTTP (agent → host)
    if (url === '/internal/ipc' && req.method === 'POST') {
      const token = req.headers.authorization?.replace('Bearer ', '');
      const entry = token ? activeTokens.get(token) : undefined;
      if (!entry) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid token' }));
        return;
      }
      try {
        const body = await readBody(req, 1_048_576);
        const result = await entry.handleIPC(body, entry.ctx);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(result);
      } catch {
        if (!res.headersSent) sendError(res, 500, 'IPC request failed');
      }
      return;
    }

    // Workspace release from sandbox pods
    if (url === '/internal/workspace/release' && req.method === 'POST') {
      const token = req.headers.authorization?.replace('Bearer ', '');
      const entry = token ? activeTokens.get(token) : undefined;
      if (!entry) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid token' }));
        return;
      }
      try {
        await readBody(req, 10_485_760);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch {
        if (!res.headersSent) sendError(res, 500, 'Workspace release failed');
      }
      return;
    }

    sendError(res, 404, 'Not found');
  });

  // Start HTTP server
  await new Promise<void>((resolve) => {
    httpServer.listen(opts.port, () => resolve());
  });

  // ── Public API ──

  async function sendMessage(
    content: string,
    msgOpts?: {
      sessionId?: string;
      user?: string;
      model?: string;
      stream?: boolean;
    },
  ): Promise<HttpResponse> {
    const requestId = randomUUID().slice(0, 8);
    const sessionId = msgOpts?.sessionId ?? `test-${requestId}`;
    const userId = msgOpts?.user ?? defaultUserId;
    const turnToken = randomUUID();

    // Set up agent_response interceptor
    let agentResponseResolve: ((content: string) => void) | undefined;
    let agentResponseReject: ((err: Error) => void) | undefined;
    const agentResponsePromise = new Promise<string>((resolve, reject) => {
      agentResponseResolve = resolve;
      agentResponseReject = reject;
    });

    // Safety timeout
    const timeoutMs = ((config.sandbox.timeout_sec ?? 120) + 60) * 1000;
    const timer = setTimeout(() => {
      agentResponseReject?.(new Error('agent_response timeout'));
    }, timeoutMs);
    if (timer.unref) timer.unref();
    agentResponsePromise.catch(() => {}); // prevent unhandled rejection

    // Wrap handleIPC to intercept agent_response
    const wrappedHandleIPC = async (raw: string, ctx: IPCContext): Promise<string> => {
      try {
        const parsed = JSON.parse(raw);
        if (parsed.action === 'agent_response') {
          agentResponseResolve?.(parsed.content ?? '');
          return JSON.stringify({ ok: true });
        }
      } catch {
        // Not JSON — fall through
      }
      return handleIPC(raw, ctx);
    };

    // Register token for this turn
    activeTokens.set(turnToken, {
      handleIPC: wrappedHandleIPC,
      ctx: { sessionId, agentId: 'main', userId },
    });

    // NATS work publisher with retry.
    // Always publish to sandbox.work queue group — the agent subscribes to this
    // subject regardless of whether it was cold-started or warm. The old per-pod
    // subject (agent.work.{podName}) is no longer used.
    const publishWork = async (_podName: string | undefined, payload: string): Promise<string> => {
      const maxRetries = 30;

      for (let i = 0; i < maxRetries; i++) {
        try {
          const reply = await nc.request('sandbox.work', new TextEncoder().encode(payload), { timeout: 2000 });
          const { podName: claimed } = JSON.parse(new TextDecoder().decode(reply.data));
          return claimed;
        } catch {
          // Agent hasn't subscribed yet — retry
          await new Promise(r => setTimeout(r, 1000));
        }
      }
      throw new Error(`Failed to deliver work via NATS after ${maxRetries} retries`);
    };

    // Build per-turn deps
    const turnDeps: CompletionDeps = {
      ...baseDeps,
      extraSandboxEnv: {
        AX_IPC_TOKEN: turnToken,
        AX_IPC_REQUEST_ID: requestId,
        AX_HOST_URL: `http://localhost:${opts.port}`,
      },
      agentResponsePromise,
      publishWork,
    };

    try {
      const messages = [{ role: 'user' as const, content }];
      const result = await processCompletion(
        turnDeps, content, requestId, messages, sessionId, undefined, userId,
      );

      clearTimeout(timer);

      const response = {
        id: `chatcmpl-${requestId}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'mock/default',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: result.responseContent },
          finish_reason: result.finishReason === 'stop' ? 'stop' : 'content_filter',
        }],
      };

      return {
        status: 200,
        body: JSON.stringify(response),
        parsed: response,
      };
    } catch (err) {
      clearTimeout(timer);
      const errorBody = { error: { message: (err as Error).message } };
      return {
        status: 500,
        body: JSON.stringify(errorBody),
        parsed: errorBody,
      };
    } finally {
      activeTokens.delete(turnToken);
    }
  }

  async function dispose(): Promise<void> {
    // Close HTTP server
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });

    // Close NATS
    try {
      await nc.close();
    } catch {
      // Best-effort
    }

    // Restore AX_HOME
    if (originalAxHome !== undefined) {
      process.env.AX_HOME = originalAxHome;
    } else {
      delete process.env.AX_HOME;
    }

    // Reset logger
    resetLogger();

    // Clean up temp directories
    if (ownsHome) {
      try { rmSync(home, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
    try { rmSync(ipcSocketDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }

  return {
    home,
    port: opts.port,
    gcsBucket,
    sendMessage,
    dispose,
  };
}
