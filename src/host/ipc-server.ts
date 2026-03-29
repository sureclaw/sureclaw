import { connect, createServer, type Server, type Socket } from 'node:net';
import type { ProviderRegistry, AgentType } from '../types.js';
import type { TaintBudget } from './taint-budget.js';
import { IPC_SCHEMAS, IPCEnvelopeSchema } from '../ipc-schemas.js';
import { getLogger, truncate } from '../logger.js';
import type { EventBus } from './event-bus.js';

// Domain handler factories
import { createLLMHandlers } from './ipc-handlers/llm.js';
import { createMemoryHandlers } from './ipc-handlers/memory.js';
import { createWebHandlers } from './ipc-handlers/web.js';
import { createBrowserHandlers } from './ipc-handlers/browser.js';
import { createSkillsHandlers } from './ipc-handlers/skills.js';
import { createIdentityHandlers } from './ipc-handlers/identity.js';
import { createDelegationHandlers } from './ipc-handlers/delegation.js';
import { createSchedulerHandlers } from './ipc-handlers/scheduler.js';
import { createWorkspaceHandlers } from './ipc-handlers/workspace.js';
import { createGovernanceHandlers } from './ipc-handlers/governance.js';
import { createImageHandlers } from './ipc-handlers/image.js';
import { createPluginHandlers } from './ipc-handlers/plugin.js';
import { createCoworkPluginHandlers, type CoworkPluginHandlerOptions } from './ipc-handlers/cowork-plugins.js';
import { createOrchestrationHandlers } from './ipc-handlers/orchestration.js';
import { createSandboxToolHandlers } from './ipc-handlers/sandbox-tools.js';
import { createToolBatchHandlers, type ToolBatchProvider, type ToolBatchOptions } from './ipc-handlers/tool-batch.js';
import { type AgentRegistry, FileAgentRegistry } from './agent-registry.js';
import type { Orchestrator } from './orchestration/orchestrator.js';

const logger = getLogger().child({ component: 'ipc' });

// IPC handler timeout — prevents hung handlers from blocking the server indefinitely.
// LLM calls have their own timeout (10min default), so this is a safety net.
const IPC_HANDLER_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

/** Interval between heartbeat frames sent to clients during handler execution. */
export const HEARTBEAT_INTERVAL_MS = 15_000;

export interface IPCContext {
  sessionId: string;
  agentId: string;
  userId?: string;
  /** HTTP request ID — used for event bus routing so SSE subscribers receive events. */
  requestId?: string;
  /** Session scope from the channel provider. DM = user-scoped memory, channel/group = agent-scoped. */
  sessionScope?: 'dm' | 'channel' | 'thread' | 'group';
}

export interface DelegationConfig {
  maxConcurrent?: number;      // max secondary agents at once (default 3)
  maxDepth?: number;           // max delegation chain depth (default 2)
}

/** Structured delegation request passed to the onDelegate callback. */
export interface DelegateRequest {
  task: string;
  context?: string;
  runner?: AgentType;
  model?: string;
  maxTokens?: number;
  timeoutSec?: number;
  wait?: boolean;
  /** Resource tier for the child container: 'default' (1 vCPU, 256MB) or 'heavy' (4 vCPU, 2GB). */
  resourceTier?: 'default' | 'heavy';
  /** Caller-assigned requestId for the child processCompletion call.
   *  Used to align the child's event stream with the orchestrator handle
   *  so that auto-state inference and heartbeat monitoring work correctly. */
  requestId?: string;
}

export interface IPCHandlerOptions {
  taintBudget?: TaintBudget;
  delegation?: DelegationConfig;
  /** Called when an agent_delegate request is received. Returns agent response. */
  onDelegate?: (req: DelegateRequest, ctx: IPCContext) => Promise<string>;
  /** Path to identity files directory (~/.ax/agents/{name}/agent/identity/) for governance handler. */
  agentDir?: string;
  /** Agent name (e.g. 'main') for resolving per-user directories. */
  agentName?: string;
  /** Security profile name (paranoid, balanced, yolo). Gates identity mutations. */
  profile?: string;
  /** Configured model ID from ax.yaml (e.g. 'anthropic/claude-sonnet-4-20250514'). */
  configModel?: string;
  /** Enterprise agent registry instance. */
  agentRegistry?: AgentRegistry;
  /** Streaming event bus for real-time observability. */
  eventBus?: EventBus;
  /** Orchestrator instance for agent orchestration IPC actions. */
  orchestrator?: Orchestrator;
  /** Maps sessionId → workspace directory path. Populated by processCompletion(), consumed by sandbox tool handlers. */
  workspaceMap?: Map<string, string>;
  /** Tracks credential_request IPC calls per session. Consumed by processCompletion post-agent loop. */
  requestedCredentials?: Map<string, Set<string>>;
  /** Proxy domain allowlist — skill_install adds domains from skill manifests. */
  domainList?: import('../host/proxy-domain-list.js').ProxyDomainList;
  /** Returns the MCP provider for tool batch execution (null = not configured).
   *  Accepts either a simple callback or full ToolBatchOptions with plugin MCP routing. */
  toolBatchProvider?: ((ctx: IPCContext) => ToolBatchProvider | null) | ToolBatchOptions;
  /** Cowork plugin management: MCP connection manager + optional domain list. */
  coworkPlugins?: CoworkPluginHandlerOptions;
}

export function createIPCHandler(providers: ProviderRegistry, opts?: IPCHandlerOptions) {

  const taintBudget = opts?.taintBudget;
  const agentName = opts?.agentName ?? 'main';
  const profile = opts?.profile ?? 'paranoid';

  // Compose handlers from domain modules
  const handlers: Record<string, (req: any, ctx: IPCContext) => Promise<any>> = {
    ...createLLMHandlers(providers, opts?.configModel, agentName, opts?.eventBus),
    ...createMemoryHandlers(providers),
    ...createWebHandlers(providers),
    ...createBrowserHandlers(providers),
    ...createSkillsHandlers(providers, {
      requestedCredentials: opts?.requestedCredentials,
      eventBus: opts?.eventBus,
      domainList: opts?.domainList,
    }),
    ...createIdentityHandlers(providers, {
      agentName,
      profile,
      taintBudget,
    }),
    ...createImageHandlers(providers),
    ...createDelegationHandlers(providers, opts),
    ...createSchedulerHandlers(providers, agentName),
    ...createWorkspaceHandlers(providers, { agentName, profile }),
    ...createGovernanceHandlers(providers, {
      agentDir: opts?.agentDir,
      agentName,
      profile,
      registry: opts?.agentRegistry ?? new FileAgentRegistry(),
    }),
    ...createPluginHandlers(providers),
    ...(opts?.coworkPlugins ? createCoworkPluginHandlers(providers, opts.coworkPlugins) : {}),
    ...(opts?.orchestrator ? createOrchestrationHandlers(opts.orchestrator) : {}),
    ...(opts?.workspaceMap ? createSandboxToolHandlers(providers, {
      workspaceMap: opts.workspaceMap,
    }) : {}),
    ...(opts?.toolBatchProvider ? createToolBatchHandlers(opts.toolBatchProvider) : {}),
  };

  return async function handleIPC(raw: string, ctx: IPCContext): Promise<string> {
    const handlerStart = Date.now();
    logger.debug('request_received', { rawBytes: raw.length, sessionId: ctx.sessionId, agentId: ctx.agentId });

    // _msgId is echoed in every response for client-side correlation.
    // Captured after JSON.parse succeeds; the respond() helper injects it.
    let requestMsgId: unknown;
    const respond = (obj: Record<string, unknown>): string => {
      if (requestMsgId !== undefined) obj._msgId = requestMsgId;
      return JSON.stringify(obj);
    };

    // Step 1: Parse JSON
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
      requestMsgId = (parsed as Record<string, unknown>)._msgId;
    } catch {
      logger.debug('parse_error', { rawPreview: truncate(raw, 200) });
      await providers.audit.log({
        action: 'ipc_parse_error',
        sessionId: ctx.sessionId,
        args: { rawPreview: raw.slice(0, 200) },
        result: 'error',
      });
      return JSON.stringify({ ok: false, error: 'Invalid JSON' });
    }

    // Step 2: Validate envelope
    const envelope = IPCEnvelopeSchema.safeParse(parsed);
    if (!envelope.success) {
      logger.debug('envelope_invalid', { rawPreview: truncate(raw, 200) });
      await providers.audit.log({
        action: 'ipc_unknown_action',
        sessionId: ctx.sessionId,
        args: {},
        result: 'blocked',
      });
      return respond({
        ok: false,
        error: 'Unknown or missing action',
      });
    }

    const actionName = envelope.data.action;

    // If the agent included a _sessionId, _userId, or _sessionScope, use them to scope
    // this request (e.g. per-session tracking, per-user workspace writes, memory scoping).
    // Strip metadata fields before schema validation — strictObject schemas reject unknown fields.
    const requestSessionId = (parsed as Record<string, unknown>)._sessionId;
    if (requestSessionId !== undefined) {
      delete (parsed as Record<string, unknown>)._sessionId;
    }
    const requestUserId = (parsed as Record<string, unknown>)._userId;
    if (requestUserId !== undefined) {
      delete (parsed as Record<string, unknown>)._userId;
    }
    const requestSessionScope = (parsed as Record<string, unknown>)._sessionScope;
    if (requestSessionScope !== undefined) {
      delete (parsed as Record<string, unknown>)._sessionScope;
    }
    const requestRequestId = (parsed as Record<string, unknown>)._requestId;
    if (requestRequestId !== undefined) {
      delete (parsed as Record<string, unknown>)._requestId;
    }
    // Strip _msgId before Zod validation — it's echoed back via respond()
    if ((parsed as Record<string, unknown>)._msgId !== undefined) {
      delete (parsed as Record<string, unknown>)._msgId;
    }
    const effectiveCtx: IPCContext = {
      ...ctx,
      ...(typeof requestSessionId === 'string' ? { sessionId: requestSessionId } : {}),
      ...(typeof requestUserId === 'string' ? { userId: requestUserId } : {}),
      ...(typeof requestSessionScope === 'string' ? { sessionScope: requestSessionScope as IPCContext['sessionScope'] } : {}),
      ...(typeof requestRequestId === 'string' ? { requestId: requestRequestId } : {}),
    };

    logger.debug('action_parsed', { action: actionName });

    // Step 3: Validate action-specific schema (strict mode)
    const schema = IPC_SCHEMAS[actionName];
    const validated = schema.safeParse(parsed);
    if (!validated.success) {
      logger.debug('validation_failed', { action: actionName, errors: validated.error?.message });
      await providers.audit.log({
        action: 'ipc_validation_failure',
        sessionId: effectiveCtx.sessionId,
        args: { ipcAction: actionName, rawPreview: raw.slice(0, 500) },
        result: 'blocked',
      });
      return respond({
        ok: false,
        error: `Validation failed for action "${actionName}"`,
      });
    }

    // Step 3.5: Taint budget check (SC-SEC-003)
    // identity_write has custom taint handling (queues instead of hard-blocking)
    if (taintBudget && actionName !== 'identity_read' && actionName !== 'identity_write' && actionName !== 'user_write' && actionName !== 'identity_propose') {
      const taintCheck = taintBudget.checkAction(effectiveCtx.sessionId, actionName);
      if (!taintCheck.allowed) {
        logger.debug('taint_blocked', { action: actionName, taintRatio: taintCheck.taintRatio });
        await providers.audit.log({
          action: 'ipc_taint_blocked',
          sessionId: effectiveCtx.sessionId,
          args: {
            ipcAction: actionName,
            taintRatio: taintCheck.taintRatio,
            threshold: taintCheck.threshold,
          },
          result: 'blocked',
        });
        return respond({
          ok: false,
          taintBlocked: true,
          error: taintCheck.reason,
        });
      }
    }

    // Step 4: Dispatch
    const handler = handlers[actionName];
    if (!handler) {
      logger.debug('no_handler', { action: actionName });
      return respond({ ok: false, error: `No handler for action "${actionName}"` });
    }

    // Race the handler against a timeout to prevent hung handlers from
    // blocking the IPC server indefinitely (safety net).
    // IMPORTANT: The timer must be cleared in all code paths to prevent leaks.
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      const startMs = Date.now();
      logger.debug('handler_start', { action: actionName });

      const handlerPromise = handler(validated.data, effectiveCtx);
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`IPC handler "${actionName}" timed out after ${IPC_HANDLER_TIMEOUT_MS}ms`)), IPC_HANDLER_TIMEOUT_MS);
      });
      const result = await Promise.race([handlerPromise, timeoutPromise]);

      const durationMs = Date.now() - startMs;
      logger.debug('handler_done', {
        action: actionName,
        durationMs,
        totalDurationMs: Date.now() - handlerStart,
        result,
        responseKeys: Object.keys(result ?? {}),
      });
      await providers.audit.log({
        action: actionName,
        sessionId: effectiveCtx.sessionId,
        args: {},
        result: 'success',
        durationMs,
      });
      return respond({ ok: true, ...result });
    } catch (err) {
      const durationMs = Date.now() - handlerStart;
      logger.debug('handler_error', {
        action: actionName,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
        durationMs,
      });
      await providers.audit.log({
        action: 'ipc_handler_error',
        sessionId: effectiveCtx.sessionId,
        args: { ipcAction: actionName, error: String(err) },
        result: 'error',
      });
      return respond({
        ok: false,
        error: `Handler error: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }
  };
}

// ═══════════════════════════════════════════════════════
// Unix Socket Server
// ═══════════════════════════════════════════════════════

/**
 * Creates a Unix socket IPC server with length-prefixed JSON framing.
 * Protocol: 4-byte big-endian length prefix + JSON payload.
 *
 * Returns a Promise that resolves with the Server once the socket file
 * exists and is accepting connections. Callers MUST await this before
 * spawning agents that connect to the socket.
 */
export async function createIPCServer(
  socketPath: string,
  handler: (raw: string, ctx: IPCContext) => Promise<string>,
  defaultCtx: IPCContext,
): Promise<Server> {
  const server = createServer((socket: Socket) => {
    let buffer = Buffer.alloc(0);
    logger.debug('client_connected', { socketPath });

    socket.on('data', async (data: Buffer) => {
      buffer = Buffer.concat([buffer, data]);

      // Process all complete messages in the buffer
      while (buffer.length >= 4) {
        const msgLen = buffer.readUInt32BE(0);

        if (msgLen > 10_000_000) {
          logger.debug('message_too_large', { msgLen, limit: 10_000_000 });
          socket.destroy();
          return;
        }

        if (buffer.length < 4 + msgLen) {
          break; // Wait for more data
        }

        const raw = buffer.subarray(4, 4 + msgLen).toString('utf-8');
        buffer = buffer.subarray(4 + msgLen);

        logger.debug('message_received', { msgLen });

        // Extract _msgId for heartbeats via regex — avoids full JSON.parse of
        // potentially large payloads. Response injection happens inside handleIPC.
        const msgIdMatch = raw.match(/"_msgId"\s*:\s*"([^"]+)"/);
        const msgId = msgIdMatch?.[1];

        // Send periodic heartbeat frames so the client knows we're alive
        // during long-running handlers (agent_delegate, image_generate, etc.)
        const heartbeatInterval = setInterval(() => {
          const hb = JSON.stringify({ _heartbeat: true, ts: Date.now(), ...(msgId ? { _msgId: msgId } : {}) });
          const hbBuf = Buffer.from(hb, 'utf-8');
          const hbLenBuf = Buffer.alloc(4);
          hbLenBuf.writeUInt32BE(hbBuf.length, 0);
          try { socket.write(Buffer.concat([hbLenBuf, hbBuf])); } catch { /* socket gone */ }
        }, HEARTBEAT_INTERVAL_MS);

        let response: string;
        try {
          response = await handler(raw, defaultCtx);
        } finally {
          clearInterval(heartbeatInterval);
        }

        const responseBuf = Buffer.from(response, 'utf-8');
        const lenBuf = Buffer.alloc(4);
        lenBuf.writeUInt32BE(responseBuf.length, 0);
        logger.debug('message_response', { responseBytes: responseBuf.length });
        socket.write(Buffer.concat([lenBuf, responseBuf]));
      }
    });

    socket.on('close', () => {
      logger.debug('client_disconnected');
    });

    socket.on('error', (err) => {
      logger.debug('socket_error', { error: err.message });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.on('error', (err) => {
      logger.error('ipc_server_error', { socketPath, error: (err as Error).message });
      reject(err);
    });

    server.listen(socketPath, () => {
      logger.debug('server_listening', { socketPath });
      resolve();
    });
  });

  return server;
}

// ═══════════════════════════════════════════════════════
// Reverse IPC Bridge (Apple Container)
// ═══════════════════════════════════════════════════════

const BRIDGE_CONNECT_RETRIES = 20;
const BRIDGE_CONNECT_DELAY_MS = 250;

/**
 * Connects to a socket path and handles IPC requests — the mirror image of
 * createIPCServer. Used for Apple Container sandbox where --publish-socket
 * creates a host-side socket that proxies into the VM via virtio-vsock.
 *
 * The host connects OUT to the publish-socket endpoint; the agent inside
 * the container accepts the connection and sends IPC requests over it.
 * Same length-prefixed JSON protocol, same handler, just reversed
 * connection direction.
 */
export async function connectIPCBridge(
  socketPath: string,
  handler: (raw: string, ctx: IPCContext) => Promise<string>,
  ctx: IPCContext,
): Promise<{ close: () => void }> {
  const socket = await connectWithRetry(socketPath, BRIDGE_CONNECT_RETRIES, BRIDGE_CONNECT_DELAY_MS);
  logger.debug('bridge_connected', { socketPath });

  let buffer = Buffer.alloc(0);

  socket.on('data', async (data: Buffer) => {
    buffer = Buffer.concat([buffer, data]);

    while (buffer.length >= 4) {
      const msgLen = buffer.readUInt32BE(0);

      if (msgLen > 10_000_000) {
        logger.debug('bridge_message_too_large', { msgLen, limit: 10_000_000 });
        socket.destroy();
        return;
      }

      if (buffer.length < 4 + msgLen) {
        break;
      }

      const raw = buffer.subarray(4, 4 + msgLen).toString('utf-8');
      buffer = buffer.subarray(4 + msgLen);

      logger.debug('bridge_message_received', { msgLen });

      // Extract _msgId for heartbeats via regex — avoids full JSON.parse
      const msgIdMatch = raw.match(/"_msgId"\s*:\s*"([^"]+)"/);
      const msgId = msgIdMatch?.[1];

      const heartbeatInterval = setInterval(() => {
        const hb = JSON.stringify({ _heartbeat: true, ts: Date.now(), ...(msgId ? { _msgId: msgId } : {}) });
        const hbBuf = Buffer.from(hb, 'utf-8');
        const hbLenBuf = Buffer.alloc(4);
        hbLenBuf.writeUInt32BE(hbBuf.length, 0);
        try { socket.write(Buffer.concat([hbLenBuf, hbBuf])); } catch { /* socket gone */ }
      }, HEARTBEAT_INTERVAL_MS);

      let response: string;
      try {
        response = await handler(raw, ctx);
      } finally {
        clearInterval(heartbeatInterval);
      }

      const responseBuf = Buffer.from(response, 'utf-8');
      const lenBuf = Buffer.alloc(4);
      lenBuf.writeUInt32BE(responseBuf.length, 0);
      logger.debug('bridge_message_response', { responseBytes: responseBuf.length });
      socket.write(Buffer.concat([lenBuf, responseBuf]));
    }
  });

  socket.on('error', (err) => {
    logger.debug('bridge_socket_error', { error: err.message });
  });

  return { close: () => socket.destroy() };
}

/** Connect to a Unix socket with retry — waits for the container to start. */
async function connectWithRetry(socketPath: string, maxRetries: number, delayMs: number): Promise<Socket> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await new Promise<Socket>((resolve, reject) => {
        const socket = connect(socketPath, () => resolve(socket));
        socket.once('error', reject);
      });
    } catch {
      if (attempt >= maxRetries) {
        throw new Error(`IPC bridge connect failed after ${maxRetries} attempts: ${socketPath}`);
      }
      await new Promise<void>(r => setTimeout(r, delayMs));
    }
  }
  throw new Error('unreachable');
}
