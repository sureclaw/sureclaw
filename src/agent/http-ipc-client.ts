// src/agent/http-ipc-client.ts — HTTP-based IPC client for k8s sandbox pods.
//
// Drop-in replacement for NATSIPCClient when running inside a k8s pod with
// AX_IPC_TRANSPORT=http. Uses fetch() POST to host HTTP server instead of
// NATS request/reply. Selected by runner.ts based on env var.

import { getLogger } from '../logger.js';
import type { IIPCClient } from './runner.js';

const logger = getLogger().child({ component: 'http-ipc-client' });

const DEFAULT_TIMEOUT_MS = 30_000;

export interface HttpIPCClientOptions {
  hostUrl: string;
  timeoutMs?: number;
}

export class HttpIPCClient implements IIPCClient {
  private hostUrl: string;
  private timeoutMs: number;
  private sessionId = '';
  private requestId?: string;
  private userId?: string;
  private sessionScope?: string;
  private token?: string;

  constructor(opts: HttpIPCClientOptions) {
    this.hostUrl = opts.hostUrl;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.token = process.env.AX_IPC_TOKEN;
  }

  setContext(ctx: {
    sessionId?: string;
    requestId?: string;
    userId?: string;
    sessionScope?: string;
    token?: string;
  }): void {
    if (ctx.sessionId !== undefined) this.sessionId = ctx.sessionId;
    if (ctx.requestId !== undefined) this.requestId = ctx.requestId;
    if (ctx.userId !== undefined) this.userId = ctx.userId;
    if (ctx.sessionScope !== undefined) this.sessionScope = ctx.sessionScope;
    if (ctx.token !== undefined) this.token = ctx.token;
  }

  async connect(): Promise<void> {
    // No-op — HTTP is connectionless
    logger.info('http_ipc_ready', { hostUrl: this.hostUrl });
  }

  disconnect(): void {
    // No-op
  }

  async call(
    request: Record<string, unknown>,
    callTimeoutMs?: number,
  ): Promise<Record<string, unknown>> {
    const enriched = {
      ...request,
      _sessionId: this.sessionId,
      ...(this.requestId ? { _requestId: this.requestId } : {}),
      ...(this.userId ? { _userId: this.userId } : {}),
      ...(this.sessionScope ? { _sessionScope: this.sessionScope } : {}),
    };

    const effectiveTimeout = callTimeoutMs ?? this.timeoutMs;

    logger.debug('call_start', {
      action: request.action,
      hostUrl: this.hostUrl,
      timeoutMs: effectiveTimeout,
    });

    const res = await fetch(`${this.hostUrl}/internal/ipc`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.token}`,
      },
      body: JSON.stringify(enriched),
      signal: AbortSignal.timeout(effectiveTimeout),
    });

    const result = await res.json() as Record<string, unknown>;
    logger.debug('call_done', { action: request.action });
    return result;
  }
}
