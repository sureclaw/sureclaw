import { createServer, type Server, type Socket } from 'node:net';
import { IPC_SCHEMAS, IPCEnvelopeSchema } from './ipc-schemas.js';
import type { ProviderRegistry } from './providers/types.js';
import type { TaintBudget } from './taint-budget.js';

export interface IPCContext {
  sessionId: string;
  agentId: string;
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
}

export function createIPCHandler(providers: ProviderRegistry, opts?: IPCHandlerOptions) {

  const taintBudget = opts?.taintBudget;
  const maxConcurrent = opts?.delegation?.maxConcurrent ?? 3;
  const maxDepth = opts?.delegation?.maxDepth ?? 2;
  let activeDelegations = 0;

  const handlers: Record<string, (req: any, ctx: IPCContext) => Promise<any>> = {

    llm_call: async (req) => {
      const chunks = [];
      for await (const chunk of providers.llm.chat({
        model: req.model ?? 'claude-sonnet-4-20250514',
        messages: req.messages,
        tools: req.tools,
        maxTokens: req.maxTokens,
      })) {
        chunks.push(chunk);
      }
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
  };

  return async function handleIPC(raw: string, ctx: IPCContext): Promise<string> {
    // Step 1: Parse JSON
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
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

    // Step 3: Validate action-specific schema (strict mode)
    const schema = IPC_SCHEMAS[actionName];
    const validated = schema.safeParse(parsed);
    if (!validated.success) {
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
    if (taintBudget) {
      const taintCheck = taintBudget.checkAction(ctx.sessionId, actionName);
      if (!taintCheck.allowed) {
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
      return JSON.stringify({ ok: false, error: `No handler for action "${actionName}"` });
    }

    try {
      const startMs = Date.now();
      const result = await handler(validated.data, ctx);
      await providers.audit.log({
        action: actionName,
        sessionId: ctx.sessionId,
        args: {},
        result: 'success',
        durationMs: Date.now() - startMs,
      });
      return JSON.stringify({ ok: true, ...result });
    } catch (err) {
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

    socket.on('data', async (data: Buffer) => {
      buffer = Buffer.concat([buffer, data]);

      // Process all complete messages in the buffer
      while (buffer.length >= 4) {
        const msgLen = buffer.readUInt32BE(0);

        if (msgLen > 10_000_000) {
          // Reject messages over 10MB
          socket.destroy();
          return;
        }

        if (buffer.length < 4 + msgLen) {
          break; // Wait for more data
        }

        const raw = buffer.subarray(4, 4 + msgLen).toString('utf-8');
        buffer = buffer.subarray(4 + msgLen);

        const response = await handler(raw, defaultCtx);
        const responseBuf = Buffer.from(response, 'utf-8');
        const lenBuf = Buffer.alloc(4);
        lenBuf.writeUInt32BE(responseBuf.length, 0);
        socket.write(Buffer.concat([lenBuf, responseBuf]));
      }
    });
  });

  server.listen(socketPath);
  return server;
}
