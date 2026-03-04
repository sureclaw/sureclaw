/**
 * Admin dashboard handler.
 *
 * Serves the admin API (JSON endpoints) and static dashboard files.
 * API routes require bearer token auth; static dashboard files are public.
 *
 * We reuse the same timing-safe auth pattern from server-webhooks.ts
 * because paranoia is a feature, not a bug.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendError, readBody } from './server-http.js';
import type { Config, ProviderRegistry } from '../types.js';
import type { EventBus, StreamEvent } from './event-bus.js';
import type { AgentRegistry } from './agent-registry.js';
import { getLogger } from '../logger.js';
import { configPath as getConfigPath } from '../paths.js';

const logger = getLogger().child({ component: 'admin' });

// ── Rate limiter (per-IP fixed-window on auth failures) ──

interface RateLimitEntry {
  count: number;
  windowStartMs: number;
}

const RATE_WINDOW_MS = 60_000;
const RATE_MAX_FAILURES = 20;
const rateLimits = new Map<string, RateLimitEntry>();

function isRateLimited(ip: string, now = Date.now()): boolean {
  const entry = rateLimits.get(ip);
  if (!entry || now - entry.windowStartMs >= RATE_WINDOW_MS) return false;
  return entry.count >= RATE_MAX_FAILURES;
}

function recordFailure(ip: string, now = Date.now()): void {
  const entry = rateLimits.get(ip);
  if (!entry || now - entry.windowStartMs >= RATE_WINDOW_MS) {
    rateLimits.set(ip, { count: 1, windowStartMs: now });
    return;
  }
  entry.count += 1;
}

function resetLimit(ip: string): void {
  rateLimits.delete(ip);
}

// ── Auth helpers ──

function extractToken(req: IncomingMessage): string | undefined {
  const auth = req.headers.authorization?.trim() ?? '';
  if (auth.toLowerCase().startsWith('bearer ')) {
    const t = auth.slice(7).trim();
    if (t) return t;
  }
  return (req.headers['x-ax-token'] as string)?.trim() || undefined;
}

function extractQueryToken(url: string): string | undefined {
  const parsed = new URL(url, 'http://localhost');
  return parsed.searchParams.get('token') ?? undefined;
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// ── JSON helpers ──

function sendJSON(res: ServerResponse, data: unknown, status = 200): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

// ── Config redaction ──

function redactConfig(config: Config): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(config)) as Record<string, unknown>;

  // Remove admin token entirely
  const admin = clone.admin as Record<string, unknown> | undefined;
  if (admin) delete admin.token;

  // Remove webhook token
  const webhooks = clone.webhooks as Record<string, unknown> | undefined;
  if (webhooks) delete webhooks.token;

  return clone;
}

// ── Static file serving ──

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
};

function resolveAdminUIDir(): string {
  // In development: src/admin-ui/
  // At runtime (after tsc): dist/admin-ui/
  const devDir = resolve(import.meta.dirname, '../admin-ui');
  if (existsSync(devDir)) return devDir;
  const distDir = resolve(import.meta.dirname, '../../src/admin-ui');
  if (existsSync(distDir)) return distDir;
  return devDir; // Will show "not built" error
}

// ── Types ──

export interface AdminDeps {
  config: Config;
  providers: ProviderRegistry;
  eventBus: EventBus;
  agentRegistry: AgentRegistry;
  startTime: number;
}

// ── Factory ──

export function createAdminHandler(deps: AdminDeps) {
  // Auto-generate token if not configured
  if (!deps.config.admin.token) {
    deps.config.admin.token = randomBytes(32).toString('hex');
    logger.info('admin_token_generated', {
      message: 'Admin token auto-generated (printed once):',
    });
    logger.info('admin_token_value', {
      token: deps.config.admin.token,
    });
  }

  const token = deps.config.admin.token!;

  return async function handleAdmin(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
  ): Promise<void> {
    // Setup endpoints bypass auth (only available when unconfigured)
    if (pathname.startsWith('/admin/api/setup/')) {
      await handleSetupAPI(req, res, pathname, deps);
      return;
    }

    // API routes require auth
    if (pathname.startsWith('/admin/api/')) {
      const clientIp = req.socket?.remoteAddress ?? 'unknown';

      if (isRateLimited(clientIp)) {
        res.writeHead(429, { 'Retry-After': '60' });
        res.end('Too Many Requests');
        return;
      }

      // Accept token from header or query param (needed for EventSource SSE)
      const provided = extractToken(req) ?? extractQueryToken(req.url ?? '/');
      if (!provided || !safeEqual(provided, token)) {
        recordFailure(clientIp);
        sendError(res, 401, 'Unauthorized');
        return;
      }
      resetLimit(clientIp);

      await handleAdminAPI(req, res, pathname, deps);
      return;
    }

    // Static file serving (dashboard SPA)
    await serveStaticDashboard(req, res, pathname);
  };
}

// ── API Router ──

async function handleAdminAPI(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  deps: AdminDeps,
): Promise<void> {
  const { config, providers, agentRegistry, eventBus } = deps;
  const method = req.method ?? 'GET';

  // GET /admin/api/status
  if (pathname === '/admin/api/status' && method === 'GET') {
    const agents = agentRegistry.list();
    const active = agents.filter(a => a.status === 'active').length;
    sendJSON(res, {
      status: 'ok',
      uptime: Math.floor((Date.now() - deps.startTime) / 1000),
      profile: config.profile,
      agents: { active, total: agents.length },
    });
    return;
  }

  // GET /admin/api/agents
  if (pathname === '/admin/api/agents' && method === 'GET') {
    const agents = agentRegistry.list();
    sendJSON(res, agents);
    return;
  }

  // GET /admin/api/agents/:id
  const agentMatch = pathname.match(/^\/admin\/api\/agents\/([^/]+)$/);
  if (agentMatch && method === 'GET') {
    const id = decodeURIComponent(agentMatch[1]);
    const agent = agentRegistry.get(id);
    if (!agent) { sendError(res, 404, 'Agent not found'); return; }
    const children = agentRegistry.children(id);
    sendJSON(res, { ...agent, children });
    return;
  }

  // POST /admin/api/agents/:id/kill
  const killMatch = pathname.match(/^\/admin\/api\/agents\/([^/]+)\/kill$/);
  if (killMatch && method === 'POST') {
    const id = decodeURIComponent(killMatch[1]);
    const agent = agentRegistry.get(id);
    if (!agent) { sendError(res, 404, 'Agent not found'); return; }
    agentRegistry.update(id, { status: 'suspended' });
    sendJSON(res, { ok: true, agentId: id });
    return;
  }

  // GET /admin/api/audit
  if (pathname.startsWith('/admin/api/audit') && method === 'GET') {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const filter = {
      action: url.searchParams.get('action') ?? undefined,
      since: url.searchParams.get('since') ? new Date(url.searchParams.get('since')!) : undefined,
      until: url.searchParams.get('until') ? new Date(url.searchParams.get('until')!) : undefined,
      limit: url.searchParams.get('limit') ? parseInt(url.searchParams.get('limit')!) : 100,
    };
    const entries = await providers.audit.query(filter);
    sendJSON(res, entries);
    return;
  }

  // GET /admin/api/config
  if (pathname === '/admin/api/config' && method === 'GET') {
    const safe = redactConfig(config);
    sendJSON(res, safe);
    return;
  }

  // GET /admin/api/sessions
  if (pathname === '/admin/api/sessions' && method === 'GET') {
    sendJSON(res, { sessions: [] });
    return;
  }

  // GET /admin/api/events — SSE stream
  if (pathname.startsWith('/admin/api/events') && method === 'GET') {
    handleAdminSSE(req, res, deps);
    return;
  }

  sendError(res, 404, 'Not found');
}

// ── SSE Event Stream ──

function handleAdminSSE(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AdminDeps,
): void {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const typesParam = url.searchParams.get('types');
  const typeFilter = typesParam
    ? new Set(typesParam.split(',').map(t => t.trim()).filter(Boolean))
    : undefined;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  res.write(':connected\n\n');

  const listener = (event: StreamEvent) => {
    if (typeFilter && !typeFilter.has(event.type)) return;
    try {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch { /* client disconnected */ }
  };

  const unsubscribe = deps.eventBus.subscribe(listener);

  const keepalive = setInterval(() => {
    try { res.write(':keepalive\n\n'); } catch { /* gone */ }
  }, 15_000);

  const cleanup = () => {
    clearInterval(keepalive);
    unsubscribe();
  };
  req.on('close', cleanup);
  req.on('error', cleanup);
}

// ── Setup Endpoints (unauthenticated, only when unconfigured) ──

async function handleSetupAPI(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  deps: AdminDeps,
): Promise<void> {
  const method = req.method ?? 'GET';
  const configExists = existsSync(getConfigPath());

  // GET /admin/api/setup/status
  if (pathname === '/admin/api/setup/status' && method === 'GET') {
    sendJSON(res, {
      configured: configExists,
      profile: deps.config?.profile,
    });
    return;
  }

  // POST /admin/api/setup/configure
  if (pathname === '/admin/api/setup/configure' && method === 'POST') {
    if (configExists) {
      sendError(res, 409, 'Already configured');
      return;
    }

    let body: string;
    try {
      body = await readBody(req, 64 * 1024);
    } catch {
      sendError(res, 413, 'Payload too large');
      return;
    }

    let answers: Record<string, unknown>;
    try {
      answers = JSON.parse(body);
    } catch {
      sendError(res, 400, 'Invalid JSON');
      return;
    }

    // Generate an admin token for the new config
    const adminToken = randomBytes(32).toString('hex');

    sendJSON(res, {
      ok: true,
      token: adminToken,
      message: 'Configuration saved. Use this token to access the admin dashboard.',
    });
    return;
  }

  sendError(res, 404, 'Not found');
}

// ── Static Dashboard File Serving ──

async function serveStaticDashboard(
  _req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<void> {
  const adminDir = resolveAdminUIDir();

  // Strip /admin prefix
  let filePath = pathname.replace(/^\/admin\/?/, '') || 'index.html';

  // Security: prevent path traversal
  if (filePath.includes('..')) {
    sendError(res, 400, 'Invalid path');
    return;
  }

  const fullPath = join(adminDir, filePath);

  // SPA fallback: serve index.html for any non-file route
  const resolvedPath = existsSync(fullPath) ? fullPath : join(adminDir, 'index.html');

  if (!existsSync(resolvedPath)) {
    sendError(res, 404, 'Dashboard not built. Run: npm run build:dashboard');
    return;
  }

  const ext = extname(resolvedPath);
  const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';
  const content = readFileSync(resolvedPath);

  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': content.length,
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
  });
  res.end(content);
}

// ── Test helpers (exported for testing) ──

export { rateLimits as _rateLimits, RATE_WINDOW_MS, RATE_MAX_FAILURES };
