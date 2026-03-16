// src/agent/nats-ipc-client.ts — NATS-based IPC client for k8s sandbox pods.
//
// Drop-in replacement for IPCClient when running inside a k8s pod.
// Uses NATS request/reply on ipc.request.{requestId}.{token} instead of
// Unix sockets. Selected by AX_IPC_TRANSPORT=nats env var in runner.ts.
//
// The per-turn capability token (AX_IPC_TOKEN env) scopes the NATS subject
// so rogue sandboxes cannot intercept requests from other sessions.

import { getLogger } from '../logger.js';
import { natsConnectOptions } from '../utils/nats.js';

const logger = getLogger().child({ component: 'nats-ipc-client' });

const DEFAULT_TIMEOUT_MS = 30_000;

export interface NATSIPCClientOptions {
  sessionId: string;
  natsUrl?: string;
  timeoutMs?: number;
  requestId?: string;
  userId?: string;
  sessionScope?: string;
  /** Per-turn capability token from AX_IPC_TOKEN env var. */
  token?: string;
}

export class NATSIPCClient {
  private sessionId: string;
  private timeoutMs: number;
  private requestId?: string;
  private userId?: string;
  private sessionScope?: string;
  private token?: string;
  private nc: any = null;
  private subject: string;

  constructor(opts: NATSIPCClientOptions) {
    this.sessionId = opts.sessionId;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.requestId = opts.requestId;
    this.userId = opts.userId;
    this.sessionScope = opts.sessionScope;
    this.token = opts.token ?? process.env.AX_IPC_TOKEN;
    this.subject = this.buildSubject();
  }

  private buildSubject(): string {
    // Token-scoped: ipc.request.{requestId}.{token}
    if (this.token && this.requestId) {
      return `ipc.request.${this.requestId}.${this.token}`;
    }
    // Fallback (non-k8s or missing token): ipc.request.{sessionId}
    return `ipc.request.${this.sessionId}`;
  }

  setContext(ctx: { sessionId?: string; requestId?: string; userId?: string; sessionScope?: string }): void {
    if (ctx.sessionId !== undefined) this.sessionId = ctx.sessionId;
    if (ctx.requestId !== undefined) this.requestId = ctx.requestId;
    if (ctx.userId !== undefined) this.userId = ctx.userId;
    if (ctx.sessionScope !== undefined) this.sessionScope = ctx.sessionScope;
    this.subject = this.buildSubject();
  }

  async connect(): Promise<void> {
    if (this.nc) return;
    const natsModule = await import('nats');
    this.nc = await natsModule.connect(natsConnectOptions('ipc', this.sessionId));
    logger.info('nats_connected', { sessionId: this.sessionId, subject: this.subject });
  }

  async call(request: Record<string, unknown>, callTimeoutMs?: number): Promise<Record<string, unknown>> {
    if (!this.nc) await this.connect();

    const enriched = {
      ...request,
      _sessionId: this.sessionId,
      ...(this.requestId ? { _requestId: this.requestId } : {}),
      ...(this.userId ? { _userId: this.userId } : {}),
      ...(this.sessionScope ? { _sessionScope: this.sessionScope } : {}),
    };

    const payload = new TextEncoder().encode(JSON.stringify(enriched));
    const effectiveTimeout = callTimeoutMs ?? this.timeoutMs;

    logger.debug('call_start', {
      action: request.action,
      subject: this.subject,
      timeoutMs: effectiveTimeout,
    });

    const response = await this.nc.request(this.subject, payload, {
      timeout: effectiveTimeout,
    });

    const result = JSON.parse(new TextDecoder().decode(response.data));
    logger.debug('call_done', { action: request.action });
    return result;
  }

  async disconnect(): Promise<void> {
    if (this.nc) {
      await this.nc.drain();
      this.nc = null;
    }
  }
}
