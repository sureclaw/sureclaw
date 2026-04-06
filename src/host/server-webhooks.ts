/**
 * Inbound webhook handler.
 *
 * Auth: Bearer token via Authorization header or X-AX-Token header.
 * Rate limiting: per-IP fixed-window on auth failures.
 * Body: JSON, size-limited.
 * Transform: LLM-powered via ~/.ax/webhooks/<name>.md files.
 * Dispatch: async agent run via processCompletion.
 */

import { randomUUID } from 'node:crypto';
import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readBody, sendError } from './server-http.js';
import type { Logger } from '../logger.js';

// ── Rate limiter (per-IP fixed-window) ──

interface RateLimitEntry {
  count: number;
  windowStartMs: number;
}

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_FAILURES = 20;
const rateLimitMap = new Map<string, RateLimitEntry>();

function isRateLimited(ip: string, nowMs = Date.now()): boolean {
  const entry = rateLimitMap.get(ip);
  if (!entry || nowMs - entry.windowStartMs >= RATE_LIMIT_WINDOW_MS) {
    return false;
  }
  return entry.count >= RATE_LIMIT_MAX_FAILURES;
}

function recordAuthFailure(ip: string, nowMs = Date.now()): void {
  const entry = rateLimitMap.get(ip);
  if (!entry || nowMs - entry.windowStartMs >= RATE_LIMIT_WINDOW_MS) {
    rateLimitMap.set(ip, { count: 1, windowStartMs: nowMs });
    return;
  }
  entry.count += 1;
}

function resetRateLimit(ip: string): void {
  rateLimitMap.delete(ip);
}

// ── Auth ──

function extractToken(req: IncomingMessage): string | undefined {
  const auth = req.headers.authorization?.trim() ?? '';
  if (auth.toLowerCase().startsWith('bearer ')) {
    const token = auth.slice(7).trim();
    if (token) return token;
  }
  const headerToken = (req.headers['x-ax-token'] as string)?.trim();
  if (headerToken) return headerToken;
  return undefined;
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// ── Types ──

export interface WebhookConfig {
  token: string;
  maxBodyBytes?: number;
  model?: string;
  allowedAgentIds?: string[];
}

export interface WebhookTransformResult {
  message: string;
  agentId?: string;
  sessionKey?: string;
  model?: string;
  timeoutSec?: number;
}

/** Callback that runs the LLM transform. Injected by caller. */
export type TransformFn = (
  transformContent: string,
  headers: Record<string, string>,
  payload: unknown,
  model?: string,
) => Promise<WebhookTransformResult | null>;

/** Callback that dispatches the agent run. Injected by caller. */
export type DispatchFn = (
  result: WebhookTransformResult,
  runId: string,
) => void;

export interface WebhookDeps {
  config: WebhookConfig;
  transform: TransformFn;
  dispatch: DispatchFn;
  logger: Logger;
  /** Check whether a transform file exists for a given webhook name. */
  transformExists: (webhookName: string) => boolean;
  /** Read the transform file content for a given webhook name. */
  readTransform: (webhookName: string) => string;
  /** Record taint for external content. */
  recordTaint?: (sessionId: string, content: string, isTainted: boolean) => void;
  /** Audit logging callback. */
  audit?: (entry: { action: string; webhook: string; runId?: string; ip?: string }) => void;
}

// ── Handler ──

export function createWebhookHandler(deps: WebhookDeps) {
  return async function handleWebhook(
    req: IncomingMessage,
    res: ServerResponse,
    webhookName: string,
  ): Promise<void> {
    const { config, transform, dispatch, logger } = deps;
    const clientIp = req.socket?.remoteAddress ?? 'unknown';

    // Method check
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' });
      res.end('Method Not Allowed');
      return;
    }

    // Reject query-string tokens
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.searchParams.has('token')) {
      sendError(res, 400, 'Token must be provided via header, not query string');
      return;
    }

    // Rate limit check
    if (isRateLimited(clientIp)) {
      res.writeHead(429, { 'Retry-After': '60' });
      res.end('Too Many Requests');
      return;
    }

    // Auth
    const token = extractToken(req);
    if (!token || !safeEqual(token, config.token)) {
      recordAuthFailure(clientIp);
      deps.audit?.({ action: 'webhook.auth_failed', webhook: webhookName, ip: clientIp });
      sendError(res, 401, 'Unauthorized');
      return;
    }
    resetRateLimit(clientIp);

    // Body parsing (respect per-webhook max_body_bytes, default 256KB)
    const maxBody = config.maxBodyBytes ?? 256 * 1024;
    let body: string;
    try {
      body = await readBody(req, maxBody);
    } catch {
      sendError(res, 413, 'Payload too large');
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      sendError(res, 400, 'Invalid JSON');
      return;
    }

    // Log receipt
    deps.audit?.({ action: 'webhook.received', webhook: webhookName, ip: clientIp });

    // Check transform file exists
    if (!deps.transformExists(webhookName)) {
      sendError(res, 404, `No webhook transform found for "${webhookName}"`);
      return;
    }
    const transformContent = deps.readTransform(webhookName);

    // Normalize headers
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') headers[key.toLowerCase()] = value;
    }

    // LLM transform
    let result: WebhookTransformResult | null;
    try {
      result = await transform(transformContent, headers, payload, config.model);
    } catch (err) {
      logger.error('webhook_transform_failed', {
        webhook: webhookName,
        error: (err as Error).message,
      });
      sendError(res, 500, 'Transform failed');
      return;
    }

    // null means "skip this event"
    if (result === null) {
      res.writeHead(204);
      res.end();
      return;
    }

    // URL-based agentId: /webhooks/{agentId}/{name} sets x-ax-agent-id header.
    // This takes precedence over the transform's agentId since it's a structural
    // routing decision (the webhook was sent to a specific agent's endpoint).
    const urlAgentId = req.headers['x-ax-agent-id'] as string | undefined;
    if (urlAgentId && !result.agentId) {
      result.agentId = urlAgentId;
    }

    // Agent ID allowlist check — when an allowlist is configured, the
    // transform MUST return an agentId that appears in the list. If omitted,
    // dispatch would fall back to the server default agent which may not be
    // in the allowlist, so we block that path too.
    if (config.allowedAgentIds) {
      if (!result.agentId || !config.allowedAgentIds.includes(result.agentId)) {
        const id = result.agentId ?? '(none)';
        sendError(res, 400, `agentId "${id}" is not in allowed list`);
        return;
      }
    }

    // Dispatch (fire-and-forget)
    const runId = `webhook-${randomUUID().slice(0, 8)}`;

    // Taint-tag the webhook payload (external content)
    const sessionId = result.sessionKey ?? `webhook:${runId}`;
    if (deps.recordTaint) {
      deps.recordTaint(sessionId, JSON.stringify(payload), true);
    }

    dispatch(result, runId);
    deps.audit?.({ action: 'webhook.dispatched', webhook: webhookName, runId, ip: clientIp });

    // Respond immediately
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, runId }));
  };
}
