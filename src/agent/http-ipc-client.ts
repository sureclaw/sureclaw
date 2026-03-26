// src/agent/http-ipc-client.ts — HTTP-based IPC client for k8s sandbox pods.
//
// Used when running inside a k8s pod (AX_HOST_URL set). Uses fetch() POST to
// host HTTP server instead of Unix sockets. Selected by runner.ts when
// AX_HOST_URL is present.

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
  /** Original auth token from pod spawn — used for work-fetch authentication.
   *  Per-turn tokens rotate via setContext(), but the pod's identity token stays fixed. */
  private readonly authToken: string | undefined;

  constructor(opts: HttpIPCClientOptions) {
    this.hostUrl = opts.hostUrl;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.token = process.env.AX_IPC_TOKEN;
    this.authToken = this.token;
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
    const url = `${this.hostUrl}/internal/ipc`;
    const action = request.action as string;

    logger.debug('call_start', {
      action,
      hostUrl: this.hostUrl,
      timeoutMs: effectiveTimeout,
    });

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.token}`,
        },
        body: JSON.stringify(enriched),
        signal: AbortSignal.timeout(effectiveTimeout),
      });
    } catch (err: unknown) {
      // Node.js fetch() throws opaque "fetch failed" errors. The real cause
      // (ECONNREFUSED, ECONNRESET, ETIMEDOUT, AbortError, etc.) is in .cause.
      const cause = (err as any)?.cause;
      const causeMsg = cause?.message ?? cause?.code ?? '';
      const causeCode = cause?.code ?? '';
      const errMsg = (err as Error).message;
      const detail = causeMsg ? `${errMsg} (${causeCode ? causeCode + ': ' : ''}${causeMsg})` : errMsg;
      logger.error('call_fetch_failed', {
        action,
        url,
        timeoutMs: effectiveTimeout,
        error: errMsg,
        causeMessage: causeMsg,
        causeCode,
      });
      throw new Error(`IPC ${action} failed: ${detail} [url=${url}, timeout=${effectiveTimeout}ms]`, { cause });
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logger.error('call_http_error', {
        action,
        url,
        status: res.status,
        statusText: res.statusText,
        body: body.slice(0, 500),
      });
      throw new Error(`IPC ${action} HTTP ${res.status}: ${res.statusText} [url=${url}]${body ? ' — ' + body.slice(0, 200) : ''}`);
    }

    const result = await res.json() as Record<string, unknown>;
    logger.debug('call_done', { action });
    return result;
  }

  /**
   * Fetch work payload from host. Returns null if no work pending (404).
   * Used by session-long pods to receive each turn's payload.
   */
  async fetchWork(pollIntervalMs = 2000, maxWaitMs = 0): Promise<string | null> {
    const url = `${this.hostUrl}/internal/work`;
    const startTime = Date.now();

    while (true) {
      try {
        const res = await fetch(url, {
          method: 'GET',
          headers: { 'Authorization': `Bearer ${this.authToken}` },
          signal: AbortSignal.timeout(10_000),
        });

        if (res.ok) {
          return await res.text();
        }

        if (res.status === 404) {
          if (maxWaitMs > 0 && (Date.now() - startTime) < maxWaitMs) {
            await new Promise(r => setTimeout(r, pollIntervalMs));
            continue;
          }
          return null;
        }

        logger.warn('fetch_work_error', { status: res.status });
        return null;
      } catch (err) {
        logger.warn('fetch_work_failed', { error: (err as Error).message });
        if (maxWaitMs > 0 && (Date.now() - startTime) < maxWaitMs) {
          await new Promise(r => setTimeout(r, pollIntervalMs));
          continue;
        }
        return null;
      }
    }
  }
}
