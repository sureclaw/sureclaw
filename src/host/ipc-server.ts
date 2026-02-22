import { createServer, type Server, type Socket } from 'node:net';
import type { ProviderRegistry } from '../types.js';
import type { TaintBudget } from './taint-budget.js';
import { IPC_SCHEMAS, IPCEnvelopeSchema } from '../ipc-schemas.js';
import { getLogger, truncate } from '../logger.js';

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
import { AgentRegistry } from './agent-registry.js';

const logger = getLogger().child({ component: 'ipc' });

export interface IPCContext {
  sessionId: string;
  agentId: string;
  userId?: string;
}

export interface DelegationConfig {
  maxConcurrent?: number;      // max secondary agents at once (default 3)
  maxDepth?: number;           // max delegation chain depth (default 2)
}

export interface IPCHandlerOptions {
  taintBudget?: TaintBudget;
  delegation?: DelegationConfig;
  /** Called when an agent_delegate request is received. Returns agent response. */
  onDelegate?: (task: string, context: string | undefined, ctx: IPCContext) => Promise<string>;
  /** Path to ~/.ax/agents/{name}/ for all identity files. */
  agentDir?: string;
  /** Agent name (e.g. 'main') for resolving per-user directories. */
  agentName?: string;
  /** Security profile name (paranoid, balanced, yolo). Gates identity mutations. */
  profile?: string;
  /** Configured model ID from ax.yaml (e.g. 'anthropic/claude-sonnet-4-20250514'). */
  configModel?: string;
  /** Enterprise agent registry instance. */
  agentRegistry?: AgentRegistry;
}

export function createIPCHandler(providers: ProviderRegistry, opts?: IPCHandlerOptions) {

  const taintBudget = opts?.taintBudget;
  const agentName = opts?.agentName ?? 'main';
  const profile = opts?.profile ?? 'paranoid';

  // Compose handlers from domain modules
  const handlers: Record<string, (req: any, ctx: IPCContext) => Promise<any>> = {
    ...createLLMHandlers(providers, opts?.configModel),
    ...createMemoryHandlers(providers),
    ...createWebHandlers(providers),
    ...createBrowserHandlers(providers),
    ...createSkillsHandlers(providers),
    ...createIdentityHandlers(providers, {
      agentDir: opts?.agentDir,
      agentName,
      profile,
      taintBudget,
    }),
    ...createDelegationHandlers(providers, opts),
    ...createSchedulerHandlers(providers, agentName),
    ...createWorkspaceHandlers(providers, { agentName, profile }),
    ...createGovernanceHandlers(providers, {
      agentDir: opts?.agentDir,
      agentName,
      profile,
      registry: opts?.agentRegistry ?? new AgentRegistry(),
    }),
  };

  return async function handleIPC(raw: string, ctx: IPCContext): Promise<string> {
    const handlerStart = Date.now();
    logger.debug('request_received', { rawBytes: raw.length, sessionId: ctx.sessionId, agentId: ctx.agentId });

    // Step 1: Parse JSON
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
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
      return JSON.stringify({
        ok: false,
        error: 'Unknown or missing action',
      });
    }

    const actionName = envelope.data.action;
    logger.debug('action_parsed', { action: actionName });

    // Step 3: Validate action-specific schema (strict mode)
    const schema = IPC_SCHEMAS[actionName];
    const validated = schema.safeParse(parsed);
    if (!validated.success) {
      logger.debug('validation_failed', { action: actionName, errors: validated.error?.message });
      await providers.audit.log({
        action: 'ipc_validation_failure',
        sessionId: ctx.sessionId,
        args: { ipcAction: actionName, rawPreview: raw.slice(0, 500) },
        result: 'blocked',
      });
      return JSON.stringify({
        ok: false,
        error: `Validation failed for action "${actionName}"`,
      });
    }

    // Step 3.5: Taint budget check (SC-SEC-003)
    // identity_write has custom taint handling (queues instead of hard-blocking)
    if (taintBudget && actionName !== 'identity_write' && actionName !== 'user_write' && actionName !== 'identity_propose') {
      const taintCheck = taintBudget.checkAction(ctx.sessionId, actionName);
      if (!taintCheck.allowed) {
        logger.debug('taint_blocked', { action: actionName, taintRatio: taintCheck.taintRatio });
        await providers.audit.log({
          action: 'ipc_taint_blocked',
          sessionId: ctx.sessionId,
          args: {
            ipcAction: actionName,
            taintRatio: taintCheck.taintRatio,
            threshold: taintCheck.threshold,
          },
          result: 'blocked',
        });
        return JSON.stringify({
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
      return JSON.stringify({ ok: false, error: `No handler for action "${actionName}"` });
    }

    try {
      const startMs = Date.now();
      logger.debug('handler_start', { action: actionName });
      const result = await handler(validated.data, ctx);
      const durationMs = Date.now() - startMs;
      logger.debug('handler_done', {
        action: actionName,
        durationMs,
        totalDurationMs: Date.now() - handlerStart,
        responseKeys: Object.keys(result ?? {}),
      });
      await providers.audit.log({
        action: actionName,
        sessionId: ctx.sessionId,
        args: {},
        result: 'success',
        durationMs,
      });
      return JSON.stringify({ ok: true, ...result });
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
        sessionId: ctx.sessionId,
        args: { ipcAction: actionName, error: String(err) },
        result: 'error',
      });
      return JSON.stringify({
        ok: false,
        error: `Handler error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  };
}

// ═══════════════════════════════════════════════════════
// Unix Socket Server
// ═══════════════════════════════════════════════════════

/**
 * Creates a Unix socket IPC server with length-prefixed JSON framing.
 * Protocol: 4-byte big-endian length prefix + JSON payload.
 */
export function createIPCServer(
  socketPath: string,
  handler: (raw: string, ctx: IPCContext) => Promise<string>,
  defaultCtx: IPCContext,
): Server {
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
        const response = await handler(raw, defaultCtx);
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

  server.listen(socketPath);
  logger.debug('server_listening', { socketPath });
  return server;
}
