// src/host/nats-sandbox-dispatch.ts — NATS-based sandbox tool dispatch
//
// Used by sandbox tool IPC handlers to dispatch tool calls to remote
// sandbox pods via NATS request/reply when the sandbox provider is k8s.
//
// Per-turn pod affinity: the first tool call in a turn claims a warm pod,
// subsequent calls in the same turn reuse the same pod via its unique subject.

import { getLogger } from '../logger.js';
import type {
  SandboxClaimRequest,
  SandboxClaimResponse,
  SandboxToolRequest,
  SandboxToolResponse,
} from '../sandbox-worker/types.js';

const logger = getLogger().child({ component: 'nats-sandbox-dispatch' });

/** Default timeout for NATS request/reply operations. */
const CLAIM_TIMEOUT_MS = 60_000;   // 60s — workspace setup can be slow
const TOOL_TIMEOUT_MS = 120_000;   // 120s — bash commands can be long

/**
 * Encode an object to NATS message payload.
 */
function encode(obj: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj));
}

/**
 * Decode a NATS message payload.
 */
function decode<T = unknown>(data: Uint8Array): T {
  return JSON.parse(new TextDecoder().decode(data)) as T;
}

/**
 * Tracks per-turn pod affinity: requestId → claimed pod subject.
 * When a tool call arrives for a requestId that already has a claimed pod,
 * the call is dispatched directly to that pod instead of going through
 * the task queue again.
 */
export interface PodAffinity {
  podSubject: string;
  podId: string;
  sessionId: string;
}

/**
 * NATSSandboxDispatcher — dispatches sandbox tool calls to remote pods via NATS.
 *
 * Usage:
 *   const dispatcher = await createNATSSandboxDispatcher({ natsUrl });
 *   // First tool call in a turn — claims a warm pod:
 *   const result = await dispatcher.dispatch(requestId, sessionId, { type: 'bash', command: 'ls' });
 *   // Second tool call — reuses same pod:
 *   const result2 = await dispatcher.dispatch(requestId, sessionId, { type: 'read_file', path: 'foo.txt' });
 *   // End of turn — release the pod:
 *   await dispatcher.release(requestId);
 */
export interface NATSSandboxDispatcher {
  /**
   * Dispatch a tool request. Claims a pod on first call per requestId,
   * reuses the same pod for subsequent calls.
   */
  dispatch(
    requestId: string,
    sessionId: string,
    tool: SandboxToolRequest,
    tier?: string,
  ): Promise<SandboxToolResponse>;

  /**
   * Release the pod claimed for a given requestId.
   * Should be called at end of turn.
   */
  release(requestId: string): Promise<void>;

  /**
   * Check if a requestId has a claimed pod.
   */
  hasPod(requestId: string): boolean;

  /**
   * Close the dispatcher and release all claimed pods.
   */
  close(): Promise<void>;
}

export async function createNATSSandboxDispatcher(options?: {
  natsUrl?: string;
}): Promise<NATSSandboxDispatcher> {
  const natsModule = await import('nats');
  const { connect, createInbox } = natsModule;

  const natsUrl = options?.natsUrl ?? process.env.NATS_URL ?? 'nats://localhost:4222';

  const nc = await connect({
    servers: natsUrl,
    name: `ax-sandbox-dispatch-${process.pid}`,
    reconnect: true,
    maxReconnectAttempts: -1,
    reconnectTimeWait: 1000,
  });

  logger.info('nats_dispatch_connected', { url: natsUrl });

  // Per-turn pod affinity map
  const affinity = new Map<string, PodAffinity>();

  async function claimPod(
    requestId: string,
    sessionId: string,
    tier: string,
  ): Promise<PodAffinity> {
    const existing = affinity.get(requestId);
    if (existing) return existing;

    const claimReq: SandboxClaimRequest = {
      type: 'claim',
      requestId,
      sessionId,
    };

    logger.debug('claiming_pod', { requestId, sessionId, tier });

    // Manual request/reply to filter out JetStream stream acks.
    // When tasks.sandbox.{tier} is covered by a JetStream stream,
    // nc.request() returns the stream ack ({"stream":"TASKS","seq":N})
    // instead of the worker's claim_ack. We subscribe to a unique inbox
    // and wait for a response with type: 'claim_ack'.
    const inbox = createInbox();
    const sub = nc.subscribe(inbox, { max: 2 }); // JetStream ack + worker reply

    const claimPromise = new Promise<SandboxClaimResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        sub.unsubscribe();
        reject(new Error(`Pod claim timed out after ${CLAIM_TIMEOUT_MS}ms`));
      }, CLAIM_TIMEOUT_MS);

      (async () => {
        for await (const msg of sub) {
          let parsed: unknown;
          try {
            parsed = decode(msg.data);
          } catch {
            continue; // skip unparseable messages
          }
          // Skip JetStream stream acks (have 'stream' field, no 'type' field)
          if (parsed && typeof parsed === 'object' && 'type' in parsed) {
            const typed = parsed as SandboxClaimResponse;
            if (typed.type === 'claim_ack') {
              clearTimeout(timer);
              sub.unsubscribe();
              resolve(typed);
              return;
            }
          }
          logger.debug('claim_skipped_jetstream_ack', { requestId, parsed });
        }
        // If subscription ends without claim_ack
        clearTimeout(timer);
        reject(new Error('Claim subscription ended without receiving claim_ack'));
      })().catch(reject);
    });

    // Publish the claim with our inbox as reply-to
    nc.publish(`tasks.sandbox.${tier}`, encode(claimReq), { reply: inbox });
    logger.info('claim_request_sent', { requestId, tier, inbox });

    const ack = await claimPromise;

    const pod: PodAffinity = {
      podSubject: ack.podSubject,
      podId: ack.podId,
      sessionId,
    };

    affinity.set(requestId, pod);
    logger.info('pod_claimed', { requestId, podId: pod.podId, podSubject: pod.podSubject });

    return pod;
  }

  async function releasePod(requestId: string): Promise<void> {
    const pod = affinity.get(requestId);
    if (!pod) return;

    try {
      await nc.request(
        pod.podSubject,
        encode({ type: 'release' } as SandboxToolRequest),
        { timeout: 10_000 },
      );
      logger.debug('pod_released', { requestId, podId: pod.podId });
    } catch (err) {
      logger.warn('pod_release_failed', {
        requestId,
        podId: pod.podId,
        error: (err as Error).message,
      });
    } finally {
      affinity.delete(requestId);
    }
  }

  return {
    async dispatch(
      requestId: string,
      sessionId: string,
      tool: SandboxToolRequest,
      tier = 'light',
    ): Promise<SandboxToolResponse> {
      // Ensure we have a claimed pod for this turn
      const pod = await claimPod(requestId, sessionId, tier);

      logger.debug('dispatching_tool', {
        requestId,
        podId: pod.podId,
        toolType: tool.type,
      });

      const response = await nc.request(
        pod.podSubject,
        encode(tool),
        { timeout: TOOL_TIMEOUT_MS },
      );

      return decode<SandboxToolResponse>(response.data);
    },

    release: releasePod,

    hasPod(requestId: string): boolean {
      return affinity.has(requestId);
    },

    async close(): Promise<void> {
      // Release all claimed pods
      const releases = [...affinity.keys()].map((reqId) => releasePod(reqId));
      await Promise.allSettled(releases);
      await nc.drain();
    },
  };
}
