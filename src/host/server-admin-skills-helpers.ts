// src/host/server-admin-skills-helpers.ts
//
// Phase 5: atomic approval of a skill's setup card. The helper validates the
// request body against the pending card first (nothing is applied until every
// check passes), then writes credentials + approves domains + re-runs
// reconcile. Credentials never enter the audit log.

import { z } from 'zod';
import { getLogger } from '../logger.js';
import { credentialScope } from './credential-scopes.js';
import type { Config, ProviderRegistry } from '../types.js';
import type { ProxyDomainList } from './proxy-domain-list.js';
import type { SkillStateStore } from './skills/state-store.js';
import type { SkillState } from './skills/types.js';

const logger = getLogger().child({ component: 'admin-skills' });

// ── Body schema ──────────────────────────────────────────────────────────────

export const ApproveBodySchema = z
  .object({
    agentId: z.string().min(1),
    skillName: z.string().min(1),
    credentials: z
      .array(
        z.object({
          envName: z.string().min(1),
          value: z.string().min(1),
        }),
      )
      .default([]),
    approveDomains: z.array(z.string().min(1)).default([]),
    userId: z.string().optional(),
  })
  .strict();

export type ApproveBody = z.infer<typeof ApproveBodySchema>;

// ── Helper deps ─────────────────────────────────────────────────────────────
//
// Narrower than AdminDeps so importing this helper from server-admin.ts
// (and vice versa) stays acyclic — the route handler just passes its
// AdminDeps in and it's structurally compatible.

export interface ApproveDeps {
  skillStateStore?: SkillStateStore;
  reconcileAgent?: (agentId: string, ref: string) => Promise<{ skills: number; events: number }>;
  domainList?: ProxyDomainList;
  providers: ProviderRegistry;
  config: Config;
  defaultUserId?: string;
}

export type ApproveResult =
  | { ok: true; state: SkillState | undefined }
  | { ok: false; status: number; error: string; details?: string };

// ── Main helper ──────────────────────────────────────────────────────────────

export async function approveSkillSetup(
  deps: ApproveDeps,
  body: ApproveBody,
): Promise<ApproveResult> {
  // 1. Required deps wiring
  if (
    !deps.skillStateStore ||
    !deps.reconcileAgent ||
    !deps.domainList ||
    !deps.providers?.credentials ||
    !deps.config?.agent_name
  ) {
    return { ok: false, status: 503, error: 'Skills not configured' };
  }

  // 2. Look up the pending card
  const queue = await deps.skillStateStore.getSetupQueue(body.agentId);
  const card = queue.find(c => c.skillName === body.skillName);
  if (!card) {
    return { ok: false, status: 404, error: 'No pending setup for this skill' };
  }

  // 3. Cross-check credentials against the card. No arbitrary envNames.
  const expectedEnvs = new Set(card.missingCredentials.map(c => c.envName));
  for (const cred of body.credentials) {
    if (!expectedEnvs.has(cred.envName)) {
      return {
        ok: false,
        status: 400,
        error: 'Request does not match pending setup',
        details: `Unexpected credential: ${cred.envName}`,
      };
    }
  }

  // 4. Cross-check domains. No arbitrary domains.
  const expectedDomains = new Set(card.unapprovedDomains);
  for (const domain of body.approveDomains) {
    if (!expectedDomains.has(domain)) {
      return {
        ok: false,
        status: 400,
        error: 'Request does not match pending setup',
        details: `Unexpected domain: ${domain}`,
      };
    }
  }

  // 5. OAuth guard — phase 5 is API-key only.
  for (const cred of body.credentials) {
    const entry = card.missingCredentials.find(m => m.envName === cred.envName);
    if (entry && entry.authType === 'oauth') {
      return {
        ok: false,
        status: 400,
        error: 'OAuth credentials must use the OAuth flow (phase 6)',
        details: cred.envName,
      };
    }
  }

  // ── Validate-all complete; begin apply-all ────────────────────────────────

  const agentName = deps.config.agent_name;
  const userId = body.userId ?? deps.defaultUserId ?? 'admin';

  // 6. Apply credentials using each entry's declared scope.
  for (const cred of body.credentials) {
    const entry = card.missingCredentials.find(m => m.envName === cred.envName)!;
    const scopeKey =
      entry.scope === 'user'
        ? credentialScope(agentName, userId)
        : credentialScope(agentName);
    await deps.providers.credentials.set(cred.envName, cred.value, scopeKey);
  }

  // 7. Apply domain approvals (idempotent).
  for (const domain of body.approveDomains) {
    deps.domainList.approvePending(domain);
  }

  // 8. Re-reconcile. Swallow any throw — the DB is already consistent, and
  //    startup-rehydrate will catch up if live state drifts.
  try {
    await deps.reconcileAgent(body.agentId, 'refs/heads/main');
  } catch (err) {
    logger.warn('skill_approve_reconcile_failed', {
      agentId: body.agentId,
      skillName: body.skillName,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // 9. Read fresh state post-reconcile.
  const states = await deps.skillStateStore.getStates(body.agentId);
  const state = states.find(s => s.name === body.skillName);

  // 10. Audit — never log credential values. Let audit failures propagate:
  //     "Everything is audited" is a security invariant. If the audit provider
  //     blows up, credentials + domains are already written, and silent
  //     success leaves an evidence gap for a security-relevant action. The
  //     route handler's outer catch surfaces the error to the caller.
  await deps.providers.audit.log({
    action: 'skill_approved',
    args: {
      agentId: body.agentId,
      skillName: body.skillName,
      domains: body.approveDomains,
      envNames: body.credentials.map(c => c.envName),
    },
    result: 'success',
    timestamp: new Date(),
    durationMs: 0,
  });

  return { ok: true, state };
}
