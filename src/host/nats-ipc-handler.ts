// src/host/nats-ipc-handler.ts — NATS-based IPC handler for k8s sandbox pods.
//
// Subscribes to ipc.request.{requestId}.{token} and routes incoming IPC
// requests through the existing handleIPC pipeline. One instance per turn.
//
// Security: the handler uses the bound host context (sessionId, userId)
// passed at construction time — it does NOT trust _sessionId/_userId from
// the payload. The per-turn capability token prevents rogue sandboxes from
// guessing the subject.
//
// Flow:
//   Sandbox pod (agent)
//     -> NATS publish to ipc.request.{requestId}.{token}
//     -> nats-ipc-handler.ts receives via subscription
//     -> routes through handleIPC (same as Unix socket path)
//     -> NATS reply back to sandbox pod

import { getLogger } from '../logger.js';
import type { IPCContext } from './ipc-server.js';
import { natsConnectOptions } from '../utils/nats.js';

const logger = getLogger().child({ component: 'nats-ipc-handler' });

export interface NATSIPCHandlerOptions {
  /** Request ID for this turn — used in the NATS subject. */
  requestId: string;
  /** Per-turn capability token — unguessable, scopes the NATS subject. */
  token: string;
  /** The IPC handler function from ipc-server.ts. */
  handleIPC: (raw: string, ctx: IPCContext) => Promise<string>;
  /** Bound host context — trusted, not overridable by sandbox payload. */
  ctx: IPCContext;
}

export async function startNATSIPCHandler(options: NATSIPCHandlerOptions): Promise<{ close: () => void }> {
  const natsModule = await import('nats');

  const subject = `ipc.request.${options.requestId}.${options.token}`;

  const nc = await natsModule.connect(natsConnectOptions('ipc-handler', options.requestId));

  const sub = nc.subscribe(subject);

  logger.info('nats_ipc_handler_started', { requestId: options.requestId, subject });

  // Use the bound host context — never trust payload _sessionId/_userId
  const boundCtx: IPCContext = options.ctx;

  (async () => {
    for await (const msg of sub) {
      let raw: string;
      try {
        raw = new TextDecoder().decode(msg.data);
      } catch (err) {
        logger.error('nats_ipc_decode_error', { error: (err as Error).message });
        if (msg.reply) {
          msg.respond(new TextEncoder().encode(JSON.stringify({ error: 'Invalid request encoding' })));
        }
        continue;
      }

      try {
        // Parse to extract _agentId (still trusted — it's our own sandbox)
        const parsed = JSON.parse(raw);
        const ctx: IPCContext = {
          sessionId: boundCtx.sessionId,
          agentId: parsed._agentId ?? boundCtx.agentId,
          userId: boundCtx.userId,
        };

        const result = await options.handleIPC(raw, ctx);

        if (msg.reply) {
          msg.respond(new TextEncoder().encode(result));
        }
      } catch (err) {
        logger.error('nats_ipc_handler_error', { error: (err as Error).message });
        if (msg.reply) {
          msg.respond(new TextEncoder().encode(JSON.stringify({ error: (err as Error).message })));
        }
      }
    }
  })().catch((err) => {
    logger.error('nats_ipc_loop_error', { error: (err as Error).message });
  });

  return {
    close() {
      sub.unsubscribe();
      void nc.drain();
    },
  };
}
