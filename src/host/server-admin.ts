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
import type { SetupRequest } from './skills/types.js';
import { ApproveBodySchema, approveSkillSetup } from './server-admin-skills-helpers.js';
import { getAgentSetupQueue, getAgentSkills, loadSnapshot } from './skills/get-agent-skills.js';
import { z } from 'zod';
import { getLogger } from '../logger.js';
import { configPath as getConfigPath } from '../paths.js';
import type { ToolModuleSyncInput, ToolModuleSyncResult } from './skills/tool-module-sync.js';

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
  /** When true, auth is handled externally (by auth middleware). Skip inline token check. */
  externalAuth?: boolean;
  mcpManager?: import('../plugins/mcp-manager.js').McpConnectionManager;
  /** Tuple-keyed skill credential store. */
  skillCredStore?: import('./skills/skill-cred-store.js').SkillCredStore;
  /** Tuple-keyed skill domain approval store. */
  skillDomainStore?: import('./skills/skill-domain-store.js').SkillDomainStore;
  /** Live git-backed skill state loader. Shares one snapshot cache per host
   *  process. When absent, skill endpoints return 503. */
  agentSkillsDeps?: import('./skills/get-agent-skills.js').GetAgentSkillsDeps;
  /** Phase 5: default user ID for credentials with scope='user' when the request doesn't specify one. */
  defaultUserId?: string;
  /** Resolve the BetterAuth-authenticated user for an incoming admin request.
   * Returns `undefined` when no external auth is configured or the request has
   * no valid session. Used by /admin/api/skills/setup/approve so user-scoped
   * credentials get written under the same userId the chat turn will look
   * them up with. */
  resolveAuthenticatedUser?: (req: IncomingMessage) => Promise<{ id: string; email?: string } | undefined>;
  /** Phase 6: admin-registered OAuth providers. When absent, /admin/api/oauth/* returns 503. */
  adminOAuthProviderStore?: import('./admin-oauth-providers.js').AdminOAuthProviderStore;
  /** Phase 6: admin-initiated OAuth flow module. When absent, /admin/api/skills/oauth/* returns 503. */
  adminOAuthFlow?: import('./admin-oauth-flow.js').AdminOAuthFlow;
  /** Commits the enabled skill's MCP tool modules into the agent's repo under
   *  `.ax/tools/<skillName>/`. Invoked by the skill-approval route when the
   *  approved skill reaches `kind: 'enabled'` and declares MCP servers.
   *  Required — wire a stub in test fixtures that don't exercise this path.
   *  Making this optional would let real hosts construct AdminDeps without
   *  it and silently drop tool generation; fail-loud is the safer contract. */
  syncToolModules: (input: ToolModuleSyncInput) => Promise<ToolModuleSyncResult>;
}

// ── OAuth provider upsert body schema (Phase 6 Task 2) ──

const AdminOAuthProviderUpsertSchema = z
  .object({
    provider: z.string().min(1).max(100),
    clientId: z.string().min(1).max(500),
    clientSecret: z.string().min(1).max(500).optional(),
    redirectUri: z.string().url().max(500),
  })
  .strict();

// ── OAuth start body schema (Phase 6 Task 3) ──
//
// The dashboard POSTs this when the user clicks "Connect with <provider>" on
// a SetupCard. The handler uses agentId + skillName + envName to find the
// pending OAuth credential in the agent's setup queue; no client-controlled
// OAuth params — everything comes from frontmatter + admin-registered
// provider config, so an attacker can't coerce a non-whitelisted authorize
// URL or scope via the request body.
const AdminOAuthStartSchema = z
  .object({
    agentId: z.string().min(1),
    skillName: z.string().min(1),
    envName: z.string().min(1),
    userId: z.string().optional(),
  })
  .strict();

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
      const skipAuth = authDisabled || deps.externalAuth || (deps.localDevMode && isLoopback(clientIp));

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
    // Exclude archived agents unless ?include_archived=true
    const reqUrl = new URL(req.url ?? '/', 'http://localhost');
    const includeArchived = reqUrl.searchParams.get('include_archived') === 'true';
    const filtered = includeArchived ? agents : agents.filter(a => a.status !== 'archived');
    sendJSON(res, filtered);
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

  // DELETE /admin/api/agents/:id — archive an agent (soft delete)
  if (agentMatch && method === 'DELETE') {
    const id = decodeURIComponent(agentMatch[1]);
    const agent = await agentRegistry.get(id);
    if (!agent) { sendError(res, 404, 'Agent not found'); return; }
    await agentRegistry.update(id, { status: 'archived' });
    logger.info('agent_archived', { agentId: id });

    sendJSON(res, { ok: true, agentId: id });
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
      const { readIdentityForAgent } = await import('./identity-reader.js');
      if (!providers.workspace) { sendError(res, 500, 'No workspace provider'); return; }
      const identity = await readIdentityForAgent(id, providers.workspace);
      const files = [];
      if (identity.soul) files.push({ key: 'SOUL.md', content: identity.soul });
      if (identity.identity) files.push({ key: 'IDENTITY.md', content: identity.identity });
      if (identity.agents) files.push({ key: 'AGENTS.md', content: identity.agents });
      if (identity.heartbeat) files.push({ key: 'HEARTBEAT.md', content: identity.heartbeat });
      sendJSON(res, files);
    } catch (err) {
      logger.error('admin_identity_failed', { agentId: id, error: (err as Error).message });
      sendError(res, 500, `Failed to read identity: ${(err as Error).message}`);
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

  // ── Global MCP Server Management ──

  // GET /admin/api/mcp-servers
  if (pathname === '/admin/api/mcp-servers' && method === 'GET') {
    if (!providers.database) { sendError(res, 500, 'Database not configured'); return; }
    const { listAllMcpServers } = await import('../providers/mcp/database.js');
    const servers = await listAllMcpServers(providers.database.db);
    sendJSON(res, servers);
    return;
  }

  // POST /admin/api/mcp-servers
  if (pathname === '/admin/api/mcp-servers' && method === 'POST') {
    if (!providers.database) { sendError(res, 500, 'Database not configured'); return; }
    try {
      const body = JSON.parse(await readBody(req));
      const { name, url, headers } = body;
      if (!name || !url) { sendError(res, 400, 'Missing required fields: name, url'); return; }
      const { addGlobalMcpServer } = await import('../providers/mcp/database.js');
      const server = await addGlobalMcpServer(providers.database.db, name, url, headers);
      // Sync to in-memory manager so tool discovery picks it up without restart
      if (deps.mcpManager) {
        deps.mcpManager.addServer('_', { name, type: 'http', url }, { source: 'database', headers });
      }
      sendJSON(res, server, 201);
    } catch (err) {
      sendError(res, 400, `Invalid request: ${(err as Error).message}`);
    }
    return;
  }

  // PUT /admin/api/mcp-servers/:name
  const globalMcpMatch = pathname.match(/^\/admin\/api\/mcp-servers\/([^/]+)$/);
  if (globalMcpMatch && method === 'PUT') {
    const name = decodeURIComponent(globalMcpMatch[1]);
    if (!providers.database) { sendError(res, 500, 'Database not configured'); return; }
    try {
      const body = JSON.parse(await readBody(req));
      const { updateGlobalMcpServer, listAllMcpServers } = await import('../providers/mcp/database.js');
      const updated = await updateGlobalMcpServer(providers.database.db, name, body);
      if (!updated) { sendError(res, 404, 'MCP server not found'); return; }
      // Sync to in-memory manager so tool discovery picks up changes without restart
      if (deps.mcpManager) {
        deps.mcpManager.removeServer('_', name);
        const rows = await listAllMcpServers(providers.database.db);
        const row = rows.find(r => r.name === name);
        if (row && row.enabled) {
          let headers: Record<string, string> | undefined;
          if (row.headers) { try { headers = JSON.parse(row.headers); } catch { /* malformed */ } }
          deps.mcpManager.addServer('_', { name, type: 'http', url: row.url }, { source: 'database', headers });
        }
      }
      sendJSON(res, { ok: true });
    } catch (err) {
      sendError(res, 400, `Invalid request: ${(err as Error).message}`);
    }
    return;
  }

  // DELETE /admin/api/mcp-servers/:name
  if (globalMcpMatch && method === 'DELETE') {
    const name = decodeURIComponent(globalMcpMatch[1]);
    if (!providers.database) { sendError(res, 500, 'Database not configured'); return; }
    const { removeGlobalMcpServer } = await import('../providers/mcp/database.js');
    const removed = await removeGlobalMcpServer(providers.database.db, name);
    if (!removed) { sendError(res, 404, 'MCP server not found'); return; }
    // Sync to in-memory manager
    if (deps.mcpManager) { deps.mcpManager.removeServer('_', name); }
    sendJSON(res, { ok: true });
    return;
  }

  // POST /admin/api/mcp-servers/:name/test
  const globalMcpTestMatch = pathname.match(/^\/admin\/api\/mcp-servers\/([^/]+)\/test$/);
  if (globalMcpTestMatch && method === 'POST') {
    const name = decodeURIComponent(globalMcpTestMatch[1]);
    if (!providers.database) { sendError(res, 500, 'Database not configured'); return; }
    if (!providers.credentials) { sendError(res, 500, 'Credentials provider not configured'); return; }
    const { testGlobalMcpServer } = await import('../providers/mcp/database.js');
    const result = await testGlobalMcpServer(providers.database.db, name, providers.credentials);
    sendJSON(res, result);
    return;
  }

  // ── Skills ──

  // GET /admin/api/skills/setup — list pending setup cards grouped by agent.
  // Skips agents with empty queues so the dashboard doesn't render noise.
  // Cards are derived live from the git snapshot + current host state (no
  // state-store read); the `hasExistingValue` hint is decorated on top.
  if (pathname === '/admin/api/skills/setup' && method === 'GET') {
    if (!deps.agentSkillsDeps) { sendError(res, 503, 'Skills not configured'); return; }
    const activeAgents = await agentRegistry.list('active');
    const out: Array<{ agentId: string; agentName: string; cards: SetupRequest[] }> = [];
    for (const a of activeAgents) {
      const cards = await getAgentSetupQueue(a.id, deps.agentSkillsDeps);
      if (cards.length === 0) continue;
      // Probe per-agent for envNames that already have at least one stored
      // value (any skill_name, any user_id). The UI renders a "reuse
      // existing" hint + relaxes its "Approve" button-disable rule when
      // this is true, so the admin doesn't have to retype a credential
      // already stored for another skill on this agent (e.g. same
      // GOOGLE_API_KEY across Calendar + Drive).
      let existingEnvNames: Set<string> = new Set();
      if (deps.skillCredStore) {
        try {
          existingEnvNames = await deps.skillCredStore.listEnvNames(a.id);
        } catch {
          // Probe failure: omit hints. Approve path still auto-fills server-
          // side when a stored value is actually found.
        }
      }
      const decorated = cards.map(c => ({
        ...c,
        missingCredentials: c.missingCredentials.map(mc => ({
          ...mc,
          hasExistingValue: existingEnvNames.has(mc.envName),
        })),
      }));
      out.push({ agentId: a.id, agentName: a.name, cards: decorated });
    }
    sendJSON(res, { agents: out });
    return;
  }

  // GET /admin/api/agents/:agentId/skills — full list of skills for one agent.
  // Returns every skill state (enabled, pending, invalid) derived live from
  // the agent's workspace repo + host approvals/credentials. Used by the
  // per-agent "Skills" sidebar in the dashboard.
  const agentSkillsMatch = pathname.match(/^\/admin\/api\/agents\/([^/]+)\/skills$/);
  if (agentSkillsMatch && method === 'GET') {
    const agentId = decodeURIComponent(agentSkillsMatch[1]);
    if (!deps.agentSkillsDeps) { sendError(res, 503, 'Skills not configured'); return; }
    const states = await getAgentSkills(agentId, deps.agentSkillsDeps);
    sendJSON(res, { skills: states });
    return;
  }

  // POST /admin/api/skills/setup/approve — atomic approve (creds + domains).
  // Validates the request body against the live pending setup card BEFORE
  // applying anything. If any validation step fails, no credentials are
  // written and no domains are approved.
  if (pathname === '/admin/api/skills/setup/approve' && method === 'POST') {
    // Narrow the catch to JSON parsing ONLY — a malformed body is a 400.
    // Real failures from approveSkillSetup (audit.log throws, snapshot walks,
    // etc.) should propagate to the outer HTTP handler as a 500, not
    // masquerade as 400.
    let body: unknown;
    try {
      body = JSON.parse(await readBody(req));
    } catch (err) {
      sendError(res, 400, `Invalid request: ${(err as Error).message}`);
      return;
    }
    const parsed = ApproveBodySchema.safeParse(body);
    if (!parsed.success) { sendError(res, 400, parsed.error.message); return; }
    const { skillCredStore, skillDomainStore, agentSkillsDeps } = deps;
    if (!skillCredStore || !skillDomainStore || !agentSkillsDeps) {
      sendError(res, 503, 'Skills not configured');
      return;
    }
    // When BetterAuth is configured, prefer the session's user.id over the
    // body's userId (or the `defaultUserId` fallback) so user-scoped
    // credentials land at `user_id = <sessionUserId>` in skill_credentials —
    // the same userId the chat turn will look them up under. Without this,
    // approvals made through the dashboard land under `defaultUserId` (e.g.
    // `default` or `admin`) while chat turns resolve to the BetterAuth UUID,
    // and the credential never gets injected into the sandbox env even though
    // the skill state says `enabled`.
    const authedUser = deps.resolveAuthenticatedUser
      ? await deps.resolveAuthenticatedUser(req)
      : undefined;
    const approveBody = authedUser && !parsed.data.userId
      ? { ...parsed.data, userId: authedUser.id }
      : parsed.data;
    const result = await approveSkillSetup(
      { ...deps, skillCredStore, skillDomainStore, agentSkillsDeps },
      approveBody,
    );
    if (result.ok) {
      sendJSON(res, { ok: true, state: result.state });
    } else if (result.details) {
      // sendError wraps as { error: { message, type, code } } — bypass to preserve `details`.
      sendJSON(res, { error: result.error, details: result.details }, result.status);
    } else {
      sendError(res, result.status, result.error);
    }
    return;
  }

  // DELETE /admin/api/skills/setup/:agentId/:skillName — dashboard-only
  // dismissal. The setup queue is derived live from git + host state, so
  // this endpoint does not mutate persistent state — it confirms the card
  // currently exists and emits an audit entry. The card reappears on the
  // next load unless the underlying facts change (cred stored, domain
  // approved, SKILL.md removed).
  const skillDismissMatch = pathname.match(/^\/admin\/api\/skills\/setup\/([^/]+)\/([^/]+)$/);
  if (skillDismissMatch && method === 'DELETE') {
    if (!deps.agentSkillsDeps) { sendError(res, 503, 'Skills not configured'); return; }
    const agentId = decodeURIComponent(skillDismissMatch[1]);
    const skillName = decodeURIComponent(skillDismissMatch[2]);
    const queue = await getAgentSetupQueue(agentId, deps.agentSkillsDeps);
    const found = queue.some(c => c.skillName === skillName);
    if (!found) {
      sendJSON(res, { ok: true, removed: false });
      return;
    }
    // Audit throws propagate (same as approve) — audit is a security invariant.
    await providers.audit.log({
      action: 'skill_dismissed',
      sessionId: agentId,
      args: { agentId, skillName },
      result: 'success',
      durationMs: 0,
    });
    sendJSON(res, { ok: true, removed: true });
    return;
  }

  // POST /admin/api/agents/:agentId/skills/:skillName/refresh-tools —
  // regenerate the committed `.ax/tools/<skillName>/` tree on demand. Used by
  // the per-agent Skills tab to pick up tool-set changes after an MCP server
  // upgrade. Unlike the approval path, sync errors surface as 500 — the admin
  // clicked the button to see the result.
  const refreshToolsMatch = pathname.match(
    /^\/admin\/api\/agents\/([^/]+)\/skills\/([^/]+)\/refresh-tools$/,
  );
  if (refreshToolsMatch && method === 'POST') {
    if (!deps.agentSkillsDeps) { sendError(res, 503, 'Skills not configured'); return; }
    const agentId = decodeURIComponent(refreshToolsMatch[1]);
    const skillName = decodeURIComponent(refreshToolsMatch[2]);

    const states = await getAgentSkills(agentId, deps.agentSkillsDeps);
    const state = states.find(s => s.name === skillName);
    if (!state || state.kind !== 'enabled') {
      sendError(res, 404, state ? 'Skill not enabled' : 'Skill not found');
      return;
    }

    const snapshot = await loadSnapshot(agentId, deps.agentSkillsDeps);
    const entry = snapshot.find(e => e.ok && e.name === skillName);
    // Defensive: getAgentSkills already emitted `enabled` for this name, so
    // the snapshot entry must exist with ok:true. The narrow here is for the
    // type system.
    if (!entry || !entry.ok) { sendError(res, 404, 'Skill not found'); return; }

    // No MCP servers means nothing to generate. Short-circuit with zero
    // counts and null commit — mirrors the "no tools discovered" shape from
    // syncToolModulesForSkill so callers have a consistent success response.
    if (entry.frontmatter.mcpServers.length === 0) {
      sendJSON(res, { ok: true, commit: null, moduleCount: 0, toolCount: 0 });
      return;
    }

    const authedUser = deps.resolveAuthenticatedUser
      ? await deps.resolveAuthenticatedUser(req)
      : undefined;
    const userId = authedUser?.id ?? deps.defaultUserId ?? 'admin';

    try {
      const result = await deps.syncToolModules({
        agentId,
        skillName,
        mcpServers: entry.frontmatter.mcpServers,
        userId,
        reason: 'refresh',
      });
      // Audit throws propagate (same as skill_dismissed) — audit is a
      // security invariant.
      await providers.audit.log({
        action: 'skill_tools_refreshed',
        sessionId: agentId,
        args: {
          agentId,
          skillName,
          commit: result.commit,
          moduleCount: result.moduleCount,
          toolCount: result.toolCount,
        },
        result: 'success',
        durationMs: 0,
      });
      sendJSON(res, {
        ok: true,
        commit: result.commit,
        moduleCount: result.moduleCount,
        toolCount: result.toolCount,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await providers.audit.log({
        action: 'skill_tools_refreshed',
        sessionId: agentId,
        args: { agentId, skillName, error: message },
        result: 'error',
        durationMs: 0,
      });
      sendError(res, 500, message);
    }
    return;
  }

  // ── Admin OAuth Start (Phase 6 Task 3) ──
  //
  // POST /admin/api/skills/oauth/start — begin a PKCE OAuth flow for a
  // pending skill credential. Validates agentId/skillName/envName against
  // the current setup queue (no arbitrary authorize URLs), applies admin
  // provider overrides when registered, and returns { authUrl, state } for
  // the dashboard to open in a new tab. The clientSecret (when
  // admin-registered) is held server-side — it never enters the response
  // body or the audit args.
  if (pathname === '/admin/api/skills/oauth/start' && method === 'POST') {
    if (!deps.agentSkillsDeps || !deps.adminOAuthFlow || !deps.agentRegistry) {
      sendError(res, 503, 'Skills not configured');
      return;
    }

    // Narrow the catch to JSON parsing only — store / audit / registry
    // throws should propagate to the outer 500 handler.
    let body: unknown;
    try {
      body = JSON.parse(await readBody(req));
    } catch (err) {
      sendError(res, 400, `Invalid request: ${(err as Error).message}`);
      return;
    }
    const parsed = AdminOAuthStartSchema.safeParse(body);
    if (!parsed.success) { sendError(res, 400, parsed.error.message); return; }

    const agent = await deps.agentRegistry.get(parsed.data.agentId);
    if (!agent) { sendError(res, 404, 'Agent not found'); return; }

    const queue = await getAgentSetupQueue(parsed.data.agentId, deps.agentSkillsDeps);
    const card = queue.find(c => c.skillName === parsed.data.skillName);
    if (!card) { sendError(res, 404, 'No pending setup for this skill'); return; }

    const cred = card.missingCredentials.find(
      c => c.envName === parsed.data.envName && c.authType === 'oauth',
    );
    if (!cred) {
      sendError(res, 404, 'No pending OAuth credential for this envName');
      return;
    }
    // Defensive: phase-5 Zod schema guarantees cred.oauth is present when
    // authType === 'oauth', but a drifted persisted queue could still hit
    // this path. 500 so it stays loud in logs.
    if (!cred.oauth) {
      sendError(res, 500, 'OAuth credential missing oauth config');
      return;
    }

    // Look up admin-registered override (confidential-client upgrade).
    let adminOverride: { clientId: string; clientSecret?: string } | undefined;
    let adminRedirectUri: string | undefined;
    let hasAdminProvider = false;
    if (deps.adminOAuthProviderStore) {
      const registered = await deps.adminOAuthProviderStore.get(cred.oauth.provider);
      if (registered) {
        hasAdminProvider = true;
        adminOverride = {
          clientId: registered.clientId,
          clientSecret: registered.clientSecret,
        };
        adminRedirectUri = registered.redirectUri;
      }
    }

    // Compute redirectUri: admin-registered value wins (so admins can pin an
    // exact URI matching their OAuth app registration). Otherwise derive
    // from the request. Behind a proxy, trust `x-forwarded-proto` for scheme
    // — but only when it's one of the two schemes we're willing to emit.
    // A caller setting `X-Forwarded-Proto: javascript` would otherwise get a
    // malformed redirect_uri baked into the authorize URL; we whitelist to
    // http/https and fall back to `req.socket.encrypted` on anything else.
    // (An upstream OAuth provider would reject the mismatched URI and the
    // admin token is required on this endpoint, so the blast radius was
    // small — but cheap belt-and-braces.)
    let redirectUri: string;
    if (adminRedirectUri) {
      redirectUri = adminRedirectUri;
    } else {
      const forwardedProto = req.headers['x-forwarded-proto'];
      const xfp = typeof forwardedProto === 'string' && forwardedProto
        ? forwardedProto.split(',')[0].trim().toLowerCase()
        : '';
      const proto = (xfp === 'http' || xfp === 'https')
        ? xfp
        : ((req.socket as { encrypted?: boolean }).encrypted ? 'https' : 'http');
      const host = req.headers.host ?? 'localhost';
      redirectUri = `${proto}://${host}/v1/oauth/callback/${cred.oauth.provider}`;
    }

    // Resolve userId for credential scope (same chain as phase-5 approve).
    const userId = parsed.data.userId ?? deps.defaultUserId ?? 'admin';

    const { state, authUrl } = deps.adminOAuthFlow.start({
      agentId: parsed.data.agentId,
      agentName: agent.name,
      skillName: parsed.data.skillName,
      envName: parsed.data.envName,
      scope: cred.scope,
      userId,
      provider: cred.oauth.provider,
      authorizationUrl: cred.oauth.authorizationUrl,
      tokenUrl: cred.oauth.tokenUrl,
      clientId: cred.oauth.clientId,
      scopes: cred.oauth.scopes,
      redirectUri,
      adminOverride,
    });

    // Audit throws propagate (security invariant). Secret value NEVER enters
    // args — we ship only the boolean hasAdminProvider flag.
    await providers.audit.log({
      action: 'oauth_start',
      sessionId: parsed.data.agentId,
      args: {
        agentId: parsed.data.agentId,
        skillName: parsed.data.skillName,
        envName: parsed.data.envName,
        provider: cred.oauth.provider,
        hasAdminProvider,
      },
      result: 'success',
      durationMs: 0,
    });

    sendJSON(res, { authUrl, state });
    return;
  }

  // ── Admin-Registered OAuth Providers (Phase 6 Task 2) ──

  // GET /admin/api/oauth/providers — list admin-registered OAuth provider configs.
  // Never includes clientSecret — the store's list() already excludes it, and the
  // response shape below preserves that exclusion all the way to the wire.
  if (pathname === '/admin/api/oauth/providers' && method === 'GET') {
    if (!deps.adminOAuthProviderStore) {
      sendError(res, 503, 'OAuth providers not configured');
      return;
    }
    const providers = await deps.adminOAuthProviderStore.list();
    sendJSON(res, { providers });
    return;
  }

  // POST /admin/api/oauth/providers — upsert an admin-registered OAuth provider.
  // clientSecret is optional (public-client admin-registered is valid). Audit is
  // emitted with `hasSecret: boolean` only — the clientSecret value itself MUST
  // NEVER enter the audit args.
  if (pathname === '/admin/api/oauth/providers' && method === 'POST') {
    if (!deps.adminOAuthProviderStore) {
      sendError(res, 503, 'OAuth providers not configured');
      return;
    }
    // Narrow the catch to JSON parsing only — matches the Phase 5 approve
    // pattern. Store writes + audit throws should propagate to the outer
    // 500 handler, not masquerade as client-side 400s.
    let body: unknown;
    try {
      body = JSON.parse(await readBody(req));
    } catch (err) {
      sendError(res, 400, `Invalid request: ${(err as Error).message}`);
      return;
    }
    const parsed = AdminOAuthProviderUpsertSchema.safeParse(body);
    if (!parsed.success) { sendError(res, 400, parsed.error.message); return; }

    await deps.adminOAuthProviderStore.upsert({
      provider: parsed.data.provider,
      clientId: parsed.data.clientId,
      clientSecret: parsed.data.clientSecret,
      redirectUri: parsed.data.redirectUri,
    });
    // Audit throws propagate (security invariant).
    await providers.audit.log({
      action: 'oauth_provider_upserted',
      sessionId: 'admin',
      args: {
        provider: parsed.data.provider,
        hasSecret: parsed.data.clientSecret !== undefined,
      },
      result: 'success',
      durationMs: 0,
    });
    sendJSON(res, { ok: true });
    return;
  }

  // DELETE /admin/api/oauth/providers/:name — idempotent removal.
  // Audit is emitted only when `removed === true` (matches the skill-dismiss pattern).
  const oauthProviderDeleteMatch = pathname.match(/^\/admin\/api\/oauth\/providers\/([^/]+)$/);
  if (oauthProviderDeleteMatch && method === 'DELETE') {
    if (!deps.adminOAuthProviderStore) {
      sendError(res, 503, 'OAuth providers not configured');
      return;
    }
    const name = decodeURIComponent(oauthProviderDeleteMatch[1]);
    const removed = await deps.adminOAuthProviderStore.delete(name);
    if (removed) {
      // Audit throws propagate (security invariant).
      await providers.audit.log({
        action: 'oauth_provider_deleted',
        sessionId: 'admin',
        args: { provider: name },
        result: 'success',
        durationMs: 0,
      });
    }
    sendJSON(res, { ok: true, removed });
    return;
  }

  // ── Per-Agent MCP Server Assignment ──

  // GET /admin/api/agents/:id/mcp-servers — list assigned server names
  const mcpListMatch = pathname.match(/^\/admin\/api\/agents\/([^/]+)\/mcp-servers$/);
  if (mcpListMatch && method === 'GET') {
    const id = decodeURIComponent(mcpListMatch[1]);
    if (!providers.database) { sendError(res, 500, 'Database not configured'); return; }
    const { listAgentServerNames } = await import('../providers/mcp/database.js');
    const names = await listAgentServerNames(providers.database.db, id);
    sendJSON(res, names);
    return;
  }

  // POST /admin/api/agents/:id/mcp-servers — assign a server to this agent
  if (mcpListMatch && method === 'POST') {
    const id = decodeURIComponent(mcpListMatch[1]);
    if (!providers.database) { sendError(res, 500, 'Database not configured'); return; }
    try {
      const body = JSON.parse(await readBody(req));
      const { serverName } = body;
      if (typeof serverName !== 'string' || !serverName) { sendError(res, 400, 'Missing required field: serverName'); return; }
      const { assignServerToAgent } = await import('../providers/mcp/database.js');
      await assignServerToAgent(providers.database.db, id, serverName);
      sendJSON(res, { ok: true });
    } catch (err) {
      sendError(res, 400, `Invalid request: ${(err as Error).message}`);
    }
    return;
  }

  // DELETE /admin/api/agents/:id/mcp-servers/:name — unassign a server from this agent
  const mcpDeleteMatch = pathname.match(/^\/admin\/api\/agents\/([^/]+)\/mcp-servers\/([^/]+)$/);
  if (mcpDeleteMatch && method === 'DELETE') {
    const id = decodeURIComponent(mcpDeleteMatch[1]);
    const name = decodeURIComponent(mcpDeleteMatch[2]);
    if (!providers.database) { sendError(res, 500, 'Database not configured'); return; }
    const { unassignServerFromAgent } = await import('../providers/mcp/database.js');
    const removed = await unassignServerFromAgent(providers.database.db, id, name);
    if (!removed) { sendError(res, 404, 'Server not assigned to this agent'); return; }
    sendJSON(res, { ok: true });
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
      auth_disabled: deps.config.admin.disable_auth === true && !deps.externalAuth,
      external_auth: !!deps.externalAuth,
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
