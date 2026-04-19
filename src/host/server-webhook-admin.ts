// src/host/server-webhook-admin.ts — Shared webhook + admin handler factories.
//
// Extracts the identical webhook handler and admin handler creation logic
// used by both server.ts and host-process.ts.

import { existsSync, readFileSync } from 'node:fs';
import type { Config, ProviderRegistry } from '../types.js';
import type { Logger } from '../logger.js';
import { webhookTransformPath } from '../paths.js';
import { createWebhookHandler } from './server-webhooks.js';
import { createWebhookTransform } from './webhook-transform.js';
import { createAdminHandler } from './server-admin.js';
import type { EventBus } from './event-bus.js';
import type { AgentRegistry } from './agent-registry.js';
import { TaintBudget } from './taint-budget.js';

export interface WebhookSetupOpts {
  config: Config;
  providers: ProviderRegistry;
  logger: Logger;
  taintBudget: TaintBudget;
  dispatch: (result: { message: string; agentId?: string; sessionKey?: string; model?: string; timeoutSec?: number }, runId: string) => void;
}

export function setupWebhookHandler(opts: WebhookSetupOpts) {
  const { config, providers, logger, taintBudget, dispatch } = opts;

  return config.webhooks?.enabled
    ? createWebhookHandler({
        config: {
          token: config.webhooks.token,
          maxBodyBytes: config.webhooks.max_body_bytes,
          model: config.webhooks.model,
          allowedAgentIds: config.webhooks.allowed_agent_ids,
        },
        transform: createWebhookTransform(
          providers.llm,
          config.webhooks.model ?? config.models?.fast?.[0] ?? config.models?.default?.[0] ?? 'claude-haiku-4-5-20251001',
        ),
        dispatch,
        logger,
        transformExists: (name) => existsSync(webhookTransformPath(name)),
        readTransform: (name) => readFileSync(webhookTransformPath(name), 'utf-8'),
        recordTaint: (sessionId, content, isTainted) => {
          taintBudget.recordContent(sessionId, content, isTainted);
        },
        audit: (entry) => {
          providers.audit.log({
            action: entry.action,
            sessionId: entry.runId ?? 'webhook',
            args: { webhook: entry.webhook, ip: entry.ip },
            result: 'success',
            durationMs: 0,
          }).catch(() => {});
        },
      })
    : null;
}

export interface AdminSetupOpts {
  config: Config;
  providers: ProviderRegistry;
  eventBus: EventBus;
  agentRegistry: AgentRegistry;
  startTime: number;
  /** When true, skip token auth for localhost connections (local dev mode). */
  localDevMode?: boolean;
  mcpManager?: import('../plugins/mcp-manager.js').McpConnectionManager;
  /** When true, auth is handled externally by auth middleware. */
  externalAuth?: boolean;
  /** Tuple-keyed skill credential store. */
  skillCredStore?: import('./skills/skill-cred-store.js').SkillCredStore;
  /** Tuple-keyed skill domain approval store. */
  skillDomainStore?: import('./skills/skill-domain-store.js').SkillDomainStore;
  /** Live git-backed skill state loader. Shares one snapshot cache per host
   *  process. When absent, skill endpoints return 503. */
  agentSkillsDeps?: import('./skills/get-agent-skills.js').GetAgentSkillsDeps;
  /** Phase 5: default user ID for credentials with scope='user' when the request doesn't specify one. */
  defaultUserId?: string;
  /** Resolver that maps an incoming request to its BetterAuth user (when
   * external auth is configured). Passed through to the admin handler so the
   * approve endpoint writes user-scoped credentials under the caller's real
   * BetterAuth UUID, not the container's defaultUserId. */
  resolveAuthenticatedUser?: (req: import('node:http').IncomingMessage) => Promise<{ id: string; email?: string } | undefined>;
  /** Phase 6: admin-registered OAuth providers. When absent, /admin/api/oauth/* returns 503. */
  adminOAuthProviderStore?: import('./admin-oauth-providers.js').AdminOAuthProviderStore;
  /** Phase 6: admin-initiated OAuth flow module. When absent, /admin/api/skills/oauth/* returns 503. */
  adminOAuthFlow?: import('./admin-oauth-flow.js').AdminOAuthFlow;
  /** Commits a skill's MCP tool modules into the agent's repo. Threaded from
   *  HostCore → server.ts → setupAdminHandler → createAdminHandler. */
  syncToolModules: (
    input: import('./skills/tool-module-sync.js').ToolModuleSyncInput,
  ) => Promise<import('./skills/tool-module-sync.js').ToolModuleSyncResult>;
}

export function setupAdminHandler(opts: AdminSetupOpts) {
  const { config, providers, eventBus, agentRegistry, startTime, localDevMode, mcpManager, externalAuth, skillCredStore, skillDomainStore, agentSkillsDeps, defaultUserId, resolveAuthenticatedUser, adminOAuthProviderStore, adminOAuthFlow, syncToolModules } = opts;
  return config.admin?.enabled
    ? createAdminHandler({ config, providers, eventBus, agentRegistry, startTime, localDevMode, mcpManager, externalAuth, skillCredStore, skillDomainStore, agentSkillsDeps, defaultUserId, resolveAuthenticatedUser, adminOAuthProviderStore, adminOAuthFlow, syncToolModules })
    : null;
}
