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
import type { ProxyDomainList } from './proxy-domain-list.js';
import { parseAgentSkill } from '../utils/skill-format-parser.js';
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
  // Sibling of host/ when running from dist/: dist/admin-ui/
  const siblingDir = resolve(import.meta.dirname, '../admin-ui');
  if (existsSync(siblingDir)) return siblingDir;
  // Fallback: dist/admin-ui/ when running from src/host/ (dev mode with tsx)
  const distDir = resolve(import.meta.dirname, '../../dist/admin-ui');
  if (existsSync(distDir)) return distDir;
  return siblingDir; // Will show "not built" error
}

// ── Localhost detection ──

const LOOPBACK_ADDRS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function isLoopback(ip: string): boolean {
  return LOOPBACK_ADDRS.has(ip);
}

// ── Types ──

export interface AdminDeps {
  config: Config;
  providers: ProviderRegistry;
  eventBus: EventBus;
  agentRegistry: AgentRegistry;
  startTime: number;
  /** When true, skip token auth for localhost connections (local dev mode). */
  localDevMode?: boolean;
  domainList?: ProxyDomainList;
}

// ── Factory ──

export function createAdminHandler(deps: AdminDeps) {
  const authDisabled = deps.config.admin.disable_auth === true;

  if (authDisabled) {
    logger.warn('admin_auth_disabled', { message: 'Admin dashboard auth is disabled — do not use in production' });
  }

  // Auto-generate token if not configured (skip if auth disabled)
  if (!authDisabled && !deps.config.admin.token) {
    deps.config.admin.token = randomBytes(32).toString('hex');
    logger.info('admin_token_generated', { token: deps.config.admin.token });
  }

  const token = deps.config.admin.token ?? '';

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

    // API routes require auth (unless local dev mode + localhost connection)
    if (pathname.startsWith('/admin/api/')) {
      const clientIp = req.socket?.remoteAddress ?? 'unknown';
      const skipAuth = authDisabled || (deps.localDevMode && isLoopback(clientIp));

      if (!skipAuth) {
        if (isRateLimited(clientIp)) {
          res.writeHead(429, { 'Retry-After': '60' });
          res.end('Too Many Requests');
          return;
        }

        // Accept token from query param only for the SSE endpoint (EventSource can't set headers)
        const isSseEndpoint = pathname === '/admin/api/events' && req.method === 'GET';
        const provided = extractToken(req) ?? (isSseEndpoint ? extractQueryToken(req.url ?? '/') : undefined);
        if (!provided || !safeEqual(provided, token)) {
          recordFailure(clientIp);
          sendError(res, 401, 'Unauthorized');
          return;
        }
        resetLimit(clientIp);
      }

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
    const agents = await agentRegistry.list();
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
    const agents = await agentRegistry.list();
    sendJSON(res, agents);
    return;
  }

  // GET /admin/api/agents/:id
  const agentMatch = pathname.match(/^\/admin\/api\/agents\/([^/]+)$/);
  if (agentMatch && method === 'GET') {
    const id = decodeURIComponent(agentMatch[1]);
    const agent = await agentRegistry.get(id);
    if (!agent) { sendError(res, 404, 'Agent not found'); return; }
    const children = await agentRegistry.children(id);
    sendJSON(res, { ...agent, children });
    return;
  }

  // POST /admin/api/agents/:id/kill
  const killMatch = pathname.match(/^\/admin\/api\/agents\/([^/]+)\/kill$/);
  if (killMatch && method === 'POST') {
    const id = decodeURIComponent(killMatch[1]);
    const agent = await agentRegistry.get(id);
    if (!agent) { sendError(res, 404, 'Agent not found'); return; }
    await agentRegistry.update(id, { status: 'suspended' });
    sendJSON(res, { ok: true, agentId: id });
    return;
  }

  // GET /admin/api/agents/:id/identity — list identity documents
  const identityMatch = pathname.match(/^\/admin\/api\/agents\/([^/]+)\/identity$/);
  if (identityMatch && method === 'GET') {
    const id = decodeURIComponent(identityMatch[1]);
    const agent = await agentRegistry.get(id);
    if (!agent) { sendError(res, 404, 'Agent not found'); return; }
    try {
      // Documents are keyed by agent ID (e.g. "main/AGENTS.md"), not display name
      const allKeys = await providers.storage.documents.list('identity');
      const prefix = `${id}/`;
      const files = [];
      for (const key of allKeys) {
        if (!key.startsWith(prefix)) continue;
        const content = await providers.storage.documents.get('identity', key);
        files.push({ key: key.slice(prefix.length), content: content ?? '' });
      }
      sendJSON(res, files);
    } catch (err) {
      logger.error('admin_identity_failed', { agentId: id, error: (err as Error).message });
      sendError(res, 500, `Failed to list identity documents: ${(err as Error).message}`);
    }
    return;
  }

  // GET /admin/api/agents/:id/skills/:name — read a single skill's content
  const skillContentMatch = pathname.match(/^\/admin\/api\/agents\/([^/]+)\/skills\/([^/]+)$/);
  if (skillContentMatch && method === 'GET') {
    const id = decodeURIComponent(skillContentMatch[1]);
    const skillName = decodeURIComponent(skillContentMatch[2]);
    const agent = await agentRegistry.get(id);
    if (!agent) { sendError(res, 404, 'Agent not found'); return; }
    try {
      const content = await findSkillContent(providers, id, skillName);
      if (!content) { sendError(res, 404, 'Skill not found'); return; }
      sendJSON(res, content);
    } catch (err) {
      logger.error('admin_skill_content_failed', { agentId: id, skill: skillName, error: (err as Error).message });
      sendError(res, 500, `Failed to read skill: ${(err as Error).message}`);
    }
    return;
  }

  // GET /admin/api/agents/:id/skills — list skills from workspace directories
  const skillsListMatch = pathname.match(/^\/admin\/api\/agents\/([^/]+)\/skills$/);
  if (skillsListMatch && method === 'GET') {
    const id = decodeURIComponent(skillsListMatch[1]);
    const agent = await agentRegistry.get(id);
    if (!agent) { sendError(res, 404, 'Agent not found'); return; }
    try {
      const skills = await listWorkspaceSkills(providers, id);
      sendJSON(res, skills);
    } catch (err) {
      logger.error('admin_skills_list_failed', { agentId: id, error: (err as Error).message });
      sendError(res, 500, `Failed to list skills: ${(err as Error).message}`);
    }
    return;
  }

  // GET /admin/api/agents/:id/workspace — list workspace files
  const workspaceMatch = pathname.match(/^\/admin\/api\/agents\/([^/]+)\/workspace$/);
  if (workspaceMatch && method === 'GET') {
    const id = decodeURIComponent(workspaceMatch[1]);
    const agent = await agentRegistry.get(id);
    if (!agent) { sendError(res, 404, 'Agent not found'); return; }
    try {
      if (!providers.workspace.listFiles) {
        sendJSON(res, []);
        return;
      }
      const url = new URL(req.url ?? '/', 'http://localhost');
      const scope = (url.searchParams.get('scope') ?? 'agent') as 'agent' | 'user' | 'session';
      // Workspace dirs are keyed by agent ID (e.g. "main"), not display name
      const files = await providers.workspace.listFiles(scope, id);
      sendJSON(res, files);
    } catch (err) {
      logger.error('admin_workspace_failed', { agentId: id, error: (err as Error).message });
      sendError(res, 500, `Failed to list workspace files: ${(err as Error).message}`);
    }
    return;
  }

  // GET /admin/api/agents/:id/memory — list memory entries
  const memoryMatch = pathname.match(/^\/admin\/api\/agents\/([^/]+)\/memory$/);
  if (memoryMatch && method === 'GET') {
    const id = decodeURIComponent(memoryMatch[1]);
    const agent = await agentRegistry.get(id);
    if (!agent) { sendError(res, 404, 'Agent not found'); return; }
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const scope = url.searchParams.get('scope') ?? 'general';
      const limit = parseInt(url.searchParams.get('limit') ?? '50');
      const entries = await providers.memory.list(scope, limit);
      sendJSON(res, entries);
    } catch (err) {
      logger.error('admin_memory_failed', { agentId: id, error: (err as Error).message });
      sendError(res, 500, `Failed to list memory entries: ${(err as Error).message}`);
    }
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

  // GET /admin/api/proxy/domains — list allowed + pending domains
  if (pathname === '/admin/api/proxy/domains' && method === 'GET') {
    if (!deps.domainList) {
      sendJSON(res, { allowed: [], pending: [] });
      return;
    }
    sendJSON(res, {
      allowed: [...deps.domainList.getAllowedDomains()],
      pending: deps.domainList.getPending(),
    });
    return;
  }

  // POST /admin/api/proxy/domains/approve — approve a pending domain
  if (pathname === '/admin/api/proxy/domains/approve' && method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      const { domain } = body;
      if (typeof domain !== 'string' || !domain) {
        sendError(res, 400, 'Missing required field: domain');
        return;
      }
      if (!deps.domainList) {
        sendError(res, 500, 'Domain list not configured');
        return;
      }
      deps.domainList.approvePending(domain);
      sendJSON(res, { ok: true, domain });
    } catch (err) {
      sendError(res, 400, `Invalid request: ${(err as Error).message}`);
    }
    return;
  }

  // POST /admin/api/proxy/domains/deny — deny a pending domain
  if (pathname === '/admin/api/proxy/domains/deny' && method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      const { domain } = body;
      if (typeof domain !== 'string' || !domain) {
        sendError(res, 400, 'Missing required field: domain');
        return;
      }
      if (!deps.domainList) {
        sendError(res, 500, 'Domain list not configured');
        return;
      }
      deps.domainList.denyPending(domain);
      sendJSON(res, { ok: true, domain });
    } catch (err) {
      sendError(res, 400, `Invalid request: ${(err as Error).message}`);
    }
    return;
  }

  // POST /admin/api/credentials/provide — store a credential for future requests
  if (pathname === '/admin/api/credentials/provide' && method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      const { envName, value, sessionId: credSessionId } = body;
      if (typeof envName !== 'string' || !envName || typeof value !== 'string') {
        sendError(res, 400, 'Missing required fields: envName, value');
        return;
      }
      const { credentialScope, getSessionCredentialContext } = await import('./credential-scopes.js');
      const ctx = credSessionId ? getSessionCredentialContext(credSessionId) : undefined;
      if (ctx) {
        if (ctx.userId) {
          await deps.providers.credentials.set(envName, value, credentialScope(ctx.agentName, ctx.userId));
        }
        await deps.providers.credentials.set(envName, value, credentialScope(ctx.agentName));
      } else {
        await deps.providers.credentials.set(envName, value);
      }
      sendJSON(res, { ok: true });
    } catch (err) {
      sendError(res, 400, `Invalid request: ${(err as Error).message}`);
    }
    return;
  }

  // ── MCP Server Management ──

  // GET /admin/api/agents/:id/mcp-servers
  const mcpListMatch = pathname.match(/^\/admin\/api\/agents\/([^/]+)\/mcp-servers$/);
  if (mcpListMatch && method === 'GET') {
    const id = decodeURIComponent(mcpListMatch[1]);
    if (!providers.database) { sendError(res, 500, 'Database not configured'); return; }
    const { listMcpServers } = await import('../providers/mcp/database.js');
    const servers = await listMcpServers(providers.database.db, id);
    sendJSON(res, servers);
    return;
  }

  // POST /admin/api/agents/:id/mcp-servers
  if (mcpListMatch && method === 'POST') {
    const id = decodeURIComponent(mcpListMatch[1]);
    if (!providers.database) { sendError(res, 500, 'Database not configured'); return; }
    try {
      const body = JSON.parse(await readBody(req));
      const { name, url, headers } = body;
      if (!name || !url) { sendError(res, 400, 'Missing required fields: name, url'); return; }
      const { addMcpServer } = await import('../providers/mcp/database.js');
      const server = await addMcpServer(providers.database.db, id, name, url, headers);
      sendJSON(res, server, 201);
    } catch (err) {
      sendError(res, 400, `Invalid request: ${(err as Error).message}`);
    }
    return;
  }

  // DELETE /admin/api/agents/:id/mcp-servers/:name
  const mcpDeleteMatch = pathname.match(/^\/admin\/api\/agents\/([^/]+)\/mcp-servers\/([^/]+)$/);
  if (mcpDeleteMatch && method === 'DELETE') {
    const id = decodeURIComponent(mcpDeleteMatch[1]);
    const name = decodeURIComponent(mcpDeleteMatch[2]);
    if (!providers.database) { sendError(res, 500, 'Database not configured'); return; }
    const { removeMcpServer } = await import('../providers/mcp/database.js');
    const removed = await removeMcpServer(providers.database.db, id, name);
    if (!removed) { sendError(res, 404, 'MCP server not found'); return; }
    sendJSON(res, { ok: true });
    return;
  }

  // PUT /admin/api/agents/:id/mcp-servers/:name
  if (mcpDeleteMatch && method === 'PUT') {
    const id = decodeURIComponent(mcpDeleteMatch[1]);
    const name = decodeURIComponent(mcpDeleteMatch[2]);
    if (!providers.database) { sendError(res, 500, 'Database not configured'); return; }
    try {
      const body = JSON.parse(await readBody(req));
      const { updateMcpServer } = await import('../providers/mcp/database.js');
      const updated = await updateMcpServer(providers.database.db, id, name, body);
      if (!updated) { sendError(res, 404, 'MCP server not found'); return; }
      sendJSON(res, { ok: true });
    } catch (err) {
      sendError(res, 400, `Invalid request: ${(err as Error).message}`);
    }
    return;
  }

  // POST /admin/api/agents/:id/mcp-servers/:name/test
  const mcpTestMatch = pathname.match(/^\/admin\/api\/agents\/([^/]+)\/mcp-servers\/([^/]+)\/test$/);
  if (mcpTestMatch && method === 'POST') {
    const id = decodeURIComponent(mcpTestMatch[1]);
    const name = decodeURIComponent(mcpTestMatch[2]);
    if (!providers.database) { sendError(res, 500, 'Database not configured'); return; }
    if (!providers.credentials) { sendError(res, 500, 'Credentials provider not configured'); return; }
    const { testMcpServer } = await import('../providers/mcp/database.js');
    const result = await testMcpServer(providers.database.db, id, name, providers.credentials);
    sendJSON(res, result);
    return;
  }

  // GET /admin/api/events — SSE stream
  if (pathname.startsWith('/admin/api/events') && method === 'GET') {
    handleAdminSSE(req, res, deps);
    return;
  }

  sendError(res, 404, 'Not found');
}

// ── Workspace Skills Helpers ──

/** List skills from workspace directories (agent + user scopes). */
async function listWorkspaceSkills(
  providers: ProviderRegistry,
  agentId: string,
): Promise<Array<{ name: string; description?: string; path: string }>> {
  const skills: Array<{ name: string; description?: string; path: string }> = [];

  for (const scope of ['agent', 'user'] as const) {
    if (!providers.workspace.downloadScope) continue;
    try {
      const files = await providers.workspace.downloadScope(scope, agentId);
      for (const f of files) {
        if (!/^skills\/.*\.md$/i.test(f.path)) continue;
        const content = f.content.toString('utf-8');
        const parsed = parseAgentSkill(content);
        const name = parsed.name || f.path.replace(/^skills\//, '').replace(/\.md$/i, '');
        skills.push({
          name,
          description: parsed.description,
          path: `${scope}/${f.path}`,
        });
      }
    } catch {
      // Scope not mounted or not available — skip silently
    }
  }

  return skills;
}

/** Find and return a single skill's content by name. */
async function findSkillContent(
  providers: ProviderRegistry,
  agentId: string,
  skillName: string,
): Promise<{ name: string; content: string } | undefined> {
  // Search user scope first (user shadows agent)
  for (const scope of ['user', 'agent'] as const) {
    if (!providers.workspace.downloadScope) continue;
    try {
      const files = await providers.workspace.downloadScope(scope, agentId);
      for (const f of files) {
        if (!/^skills\/.*\.md$/i.test(f.path)) continue;
        const content = f.content.toString('utf-8');
        const parsed = parseAgentSkill(content);
        const name = parsed.name || f.path.replace(/^skills\//, '').replace(/\.md$/i, '');
        if (name === skillName) {
          return { name, content };
        }
      }
    } catch {
      // Scope not mounted or not available — skip
    }
  }
  return undefined;
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
    sendError(res, 404, 'Dashboard not built. Run: npm run build:admin');
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
