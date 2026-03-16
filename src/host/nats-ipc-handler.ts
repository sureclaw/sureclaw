// src/host/nats-ipc-handler.ts — NATS-based IPC handler for k8s sandbox pods.
//
// Subscribes to ipc.request.{sessionId} and routes incoming IPC requests
// through the existing handleIPC pipeline. One instance per active turn.
//
// Flow:
//   Sandbox pod (agent)
//     -> NATS publish to ipc.request.{sessionId}
//     -> nats-ipc-handler.ts receives via subscription
//     -> routes through handleIPC (same as Unix socket path)
//     -> NATS reply back to sandbox pod

import { getLogger } from '../logger.js';
import type { IPCContext } from './ipc-server.js';

const logger = getLogger().child({ component: 'nats-ipc-handler' });

export interface NATSIPCHandlerOptions {
  sessionId: string;
  natsUrl?: string;
  handleIPC: (raw: string, ctx: IPCContext) => Promise<string>;
  ctx?: IPCContext;
}

export async function startNATSIPCHandler(options: NATSIPCHandlerOptions): Promise<{ close: () => void }> {
  const natsModule = await import('nats');

  const natsUrl = options.natsUrl ?? process.env.NATS_URL ?? 'nats://localhost:4222';
  const subject = `ipc.request.${options.sessionId}`;

  const nc = await natsModule.connect({
    servers: natsUrl,
    name: `ax-ipc-handler-${options.sessionId}`,
    reconnect: true,
    maxReconnectAttempts: -1,
    reconnectTimeWait: 1000,
  });

  const sub = nc.subscribe(subject);

  logger.info('nats_ipc_handler_started', { sessionId: options.sessionId, subject });

  const defaultCtx: IPCContext = options.ctx ?? {
    sessionId: options.sessionId,
    agentId: 'system',
    userId: 'default',
  };

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
        const parsed = JSON.parse(raw);
        const ctx: IPCContext = {
          sessionId: parsed._sessionId ?? defaultCtx.sessionId,
          agentId: parsed._agentId ?? defaultCtx.agentId,
          userId: parsed._userId ?? defaultCtx.userId,
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
