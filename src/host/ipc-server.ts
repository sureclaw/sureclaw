import { createServer, type Server, type Socket } from 'node:net';
import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { IPC_SCHEMAS, IPCEnvelopeSchema } from '../ipc-schemas.js';
import type { ProviderRegistry } from '../types.js';
import type { TaintBudget } from './taint-budget.js';
import { getLogger, truncate } from '../logger.js';

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
  /** Path to agents/{name}/ directory (repo) for reading immutable files. */
  agentDir?: string;
  /** Path to ~/.ax/agents/{name}/ for writing mutable identity state. */
  agentStateDir?: string;
  /** Security profile name (paranoid, balanced, yolo). Gates identity mutations. */
  profile?: string;
}

export function createIPCHandler(providers: ProviderRegistry, opts?: IPCHandlerOptions) {

  const taintBudget = opts?.taintBudget;
  const maxConcurrent = opts?.delegation?.maxConcurrent ?? 3;
  const maxDepth = opts?.delegation?.maxDepth ?? 2;
  let activeDelegations = 0;
  const agentDir = opts?.agentDir ?? resolve('agents/assistant');
  const stateDir = opts?.agentStateDir ?? agentDir; // backward compat
  const profile = opts?.profile ?? 'paranoid';

  const handlers: Record<string, (req: any, ctx: IPCContext) => Promise<any>> = {

    llm_call: async (req) => {
      logger.debug('llm_call_params', {
        model: req.model,
        maxTokens: req.maxTokens,
        toolCount: req.tools?.length ?? 0,
        toolNames: req.tools?.map((t: { name: string }) => t.name),
        messageCount: req.messages?.length ?? 0,
      });
      const chunks: unknown[] = [];
      for await (const chunk of providers.llm.chat({
        model: req.model ?? 'claude-sonnet-4-20250514',
        messages: req.messages,
        tools: req.tools,
        maxTokens: req.maxTokens,
      })) {
        chunks.push(chunk);
      }
      const chunkTypes = chunks.map((c: any) => c.type);
      const toolUseChunks = chunks.filter((c: any) => c.type === 'tool_use');
      logger.debug('llm_call_result', {
        chunkCount: chunks.length,
        chunkTypes,
        toolUseCount: toolUseChunks.length,
        toolNames: toolUseChunks.map((c: any) => c.toolCall?.name),
      });
      return { chunks };
    },

    memory_write: async (req) => {
      await providers.audit.log({ action: 'memory_write', args: { scope: req.scope } });
      return { id: await providers.memory.write(req) };
    },

    memory_query: async (req) => {
      return { results: await providers.memory.query(req) };
    },

    memory_read: async (req) => {
      return { entry: await providers.memory.read(req.id) };
    },

    memory_delete: async (req, ctx) => {
      await providers.audit.log({ action: 'memory_delete', sessionId: ctx.sessionId, args: { id: req.id } });
      await providers.memory.delete(req.id);
      return { ok: true };
    },

    memory_list: async (req) => {
      return { entries: await providers.memory.list(req.scope, req.limit) };
    },

    web_fetch: async (req, ctx) => {
      await providers.audit.log({ action: 'web_fetch', sessionId: ctx.sessionId, args: { url: req.url } });
      return await providers.web.fetch(req);
    },

    web_search: async (req, ctx) => {
      await providers.audit.log({ action: 'web_search', sessionId: ctx.sessionId, args: { query: req.query } });
      return await providers.web.search(req.query, req.maxResults);
    },

    browser_launch: async (req) => {
      return await providers.browser.launch(req.config ?? {});
    },

    browser_navigate: async (req, ctx) => {
      await providers.audit.log({ action: 'browser_navigate', sessionId: ctx.sessionId, args: { url: req.url } });
      await providers.browser.navigate(req.session, req.url);
      return { ok: true };
    },

    browser_snapshot: async (req) => {
      return await providers.browser.snapshot(req.session);
    },

    browser_click: async (req) => {
      await providers.browser.click(req.session, req.ref);
      return { ok: true };
    },

    browser_type: async (req) => {
      await providers.browser.type(req.session, req.ref, req.text);
      return { ok: true };
    },

    browser_screenshot: async (req) => {
      const buf = await providers.browser.screenshot(req.session);
      return { data: buf.toString('base64') };
    },

    browser_close: async (req) => {
      await providers.browser.close(req.session);
      return { ok: true };
    },

    skill_read: async (req) => {
      return { content: await providers.skills.read(req.name) };
    },

    skill_list: async () => {
      return { skills: await providers.skills.list() };
    },

    skill_propose: async (req, ctx) => {
      await providers.audit.log({ action: 'skill_propose', sessionId: ctx.sessionId, args: { skill: req.skill } });
      return await providers.skills.propose(req);
    },

    audit_query: async (req) => {
      return { entries: await providers.audit.query(req.filter ?? {}) };
    },

    agent_delegate: async (req, ctx) => {
      // Enforce concurrency limit
      if (activeDelegations >= maxConcurrent) {
        return {
          ok: false,
          error: `Max concurrent delegations reached (${maxConcurrent})`,
        };
      }

      // Extract and check delegation depth from context
      const currentDepth = parseInt(ctx.agentId.split(':depth=')[1] ?? '0', 10);
      if (currentDepth >= maxDepth) {
        return {
          ok: false,
          error: `Max delegation depth reached (${maxDepth})`,
        };
      }

      if (!opts?.onDelegate) {
        return {
          ok: false,
          error: 'Delegation not configured on this host',
        };
      }

      // Increment BEFORE any await to prevent race with concurrent calls
      activeDelegations++;
      try {
        await providers.audit.log({
          action: 'agent_delegate',
          sessionId: ctx.sessionId,
          args: { task: req.task.slice(0, 500), depth: currentDepth + 1 },
        });

        const childCtx: IPCContext = {
          sessionId: ctx.sessionId,
          agentId: `delegate-${ctx.agentId}:depth=${currentDepth + 1}`,
        };
        const response = await opts.onDelegate(req.task, req.context, childCtx);
        return { response };
      } finally {
        activeDelegations--;
      }
    },

    identity_write: async (req, ctx) => {
      // 0. Scan proposed content — blocks injection in identity files
      const scanResult = await providers.scanner.scanInput({
        content: req.content,
        source: 'identity_mutation',
        sessionId: ctx.sessionId,
      });
      if (scanResult.verdict === 'BLOCK') {
        await providers.audit.log({
          action: 'identity_write',
          sessionId: ctx.sessionId,
          args: { file: req.file, reason: req.reason, origin: req.origin, decision: 'scanner_blocked', verdict: scanResult.verdict },
        });
        return { ok: false, error: `Identity content blocked by scanner: ${scanResult.reason ?? 'policy violation'}` };
      }

      // 1. Check taint — if tainted, queue for approval (except yolo)
      if (profile !== 'yolo' && taintBudget) {
        const check = taintBudget.checkAction(ctx.sessionId, 'identity_write');
        if (!check.allowed) {
          await providers.audit.log({
            action: 'identity_write',
            sessionId: ctx.sessionId,
            args: { file: req.file, reason: req.reason, origin: req.origin, decision: 'queued_tainted', taintRatio: check.taintRatio },
          });
          return { queued: true, file: req.file, reason: `Taint ${((check.taintRatio ?? 0) * 100).toFixed(0)}% exceeds threshold` };
        }
      }

      // 2. Check profile — paranoid always queues
      if (profile === 'paranoid') {
        await providers.audit.log({
          action: 'identity_write',
          sessionId: ctx.sessionId,
          args: { file: req.file, reason: req.reason, origin: req.origin, decision: 'queued_paranoid' },
        });
        return { queued: true, file: req.file, reason: req.reason };
      }

      // 3. Auto-apply (balanced + clean, or yolo)
      // Write to state dir (not repo dir)
      mkdirSync(stateDir, { recursive: true });
      const filePath = join(stateDir, req.file);
      writeFileSync(filePath, req.content, 'utf-8');

      // Bootstrap completion: delete BOOTSTRAP.md from REPO dir when SOUL.md is written
      if (req.file === 'SOUL.md') {
        const bootstrapPath = join(agentDir, 'BOOTSTRAP.md');
        try { unlinkSync(bootstrapPath); } catch { /* may not exist */ }
      }

      await providers.audit.log({
        action: 'identity_write',
        sessionId: ctx.sessionId,
        args: { file: req.file, reason: req.reason, origin: req.origin, decision: 'applied' },
      });
      return { applied: true, file: req.file };
    },

    user_write: async (req, ctx) => {
      if (!ctx.userId) {
        return { ok: false, error: 'user_write requires userId in context' };
      }

      // 0. Scan proposed content — blocks injection in user files
      const scanResult = await providers.scanner.scanInput({
        content: req.content,
        source: 'user_mutation',
        sessionId: ctx.sessionId,
      });
      if (scanResult.verdict === 'BLOCK') {
        await providers.audit.log({
          action: 'user_write',
          sessionId: ctx.sessionId,
          args: { userId: ctx.userId, reason: req.reason, origin: req.origin, decision: 'scanner_blocked' },
        });
        return { ok: false, error: `User content blocked by scanner: ${scanResult.reason ?? 'policy violation'}` };
      }

      // 1. Taint check
      if (profile !== 'yolo' && taintBudget) {
        const check = taintBudget.checkAction(ctx.sessionId, 'user_write');
        if (!check.allowed) {
          await providers.audit.log({
            action: 'user_write',
            sessionId: ctx.sessionId,
            args: { userId: ctx.userId, reason: req.reason, origin: req.origin, decision: 'queued_tainted' },
          });
          return { queued: true, reason: `Taint ${((check.taintRatio ?? 0) * 100).toFixed(0)}% exceeds threshold` };
        }
      }

      // 2. Paranoid gate
      if (profile === 'paranoid') {
        await providers.audit.log({
          action: 'user_write',
          sessionId: ctx.sessionId,
          args: { userId: ctx.userId, reason: req.reason, origin: req.origin, decision: 'queued_paranoid' },
        });
        return { queued: true, reason: req.reason };
      }

      // 3. Write to per-user dir
      const { agentUserDir } = await import('../paths.js');
      const userDir = agentUserDir('assistant', ctx.userId);
      mkdirSync(userDir, { recursive: true });
      writeFileSync(join(userDir, 'USER.md'), req.content, 'utf-8');

      await providers.audit.log({
        action: 'user_write',
        sessionId: ctx.sessionId,
        args: { userId: ctx.userId, reason: req.reason, origin: req.origin, decision: 'applied' },
      });
      return { applied: true, userId: ctx.userId };
    },
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
    if (taintBudget && actionName !== 'identity_write' && actionName !== 'user_write') {
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
