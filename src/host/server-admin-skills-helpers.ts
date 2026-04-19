// src/host/server-admin-skills-helpers.ts
//
// Atomic approval of a skill's setup card. The helper validates the request
// body against the live setup card first (nothing is applied until every
// check passes), then writes credentials + approves domains. Credentials
// never enter the audit log.

import { z } from 'zod';
import type { Config } from '../types.js';
import type { AuditProvider } from '../providers/audit/types.js';
import type { SkillCredStore } from './skills/skill-cred-store.js';
import type { SkillDomainStore } from './skills/skill-domain-store.js';
import type { SkillState } from './skills/types.js';
import {
  getAgentSetupQueue,
  getAgentSkills,
  loadSnapshot,
  type GetAgentSkillsDeps,
} from './skills/get-agent-skills.js';
import type { ToolModuleSyncInput, ToolModuleSyncResult } from './skills/tool-module-sync.js';

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
  providers: { audit: AuditProvider };
  config: Config;
  defaultUserId?: string;
  skillCredStore: SkillCredStore;
  skillDomainStore: SkillDomainStore;
  /** Live git-backed skill state loader. Used to look up the pending card +
   *  resolve the returned SkillState after approval. */
  agentSkillsDeps: GetAgentSkillsDeps;
  /** Commits the enabled skill's MCP tool modules into the agent's repo under
   *  `.ax/tools/<skillName>/`. Invoked only when the approval brings the skill
   *  to `kind: 'enabled'` AND the skill declares at least one MCP server.
   *  Errors are caught in-helper — a sync failure does not fail the approval
   *  (the admin can retry via the refresh-tools endpoint). */
  syncToolModules: (input: ToolModuleSyncInput) => Promise<ToolModuleSyncResult>;
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
  if (!deps.config?.agent_name || !deps.agentSkillsDeps) {
    return { ok: false, status: 503, error: 'Skills not configured' };
  }

  // 2. Look up the pending card live from the git snapshot + host state.
  const queue = await getAgentSetupQueue(body.agentId, deps.agentSkillsDeps);
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

  // 5. OAuth guard — the API-key approve path rejects oauth creds; they go
  //    through the dedicated OAuth start/callback flow.
  for (const cred of body.credentials) {
    const entry = card.missingCredentials.find(m => m.envName === cred.envName);
    if (entry && entry.authType === 'oauth') {
      return {
        ok: false,
        status: 400,
        error: 'OAuth credentials must use the OAuth flow',
        details: cred.envName,
      };
    }
  }

  // ── Validate-all complete; begin apply-all ────────────────────────────────

  const userId = body.userId ?? deps.defaultUserId ?? 'admin';

  // 6. Resolve a value for every missing credential, either from the request
  //    body or from an existing tuple row with the same envName. The reuse
  //    path covers cross-skill sharing — same envName reused by a second
  //    skill (e.g. GOOGLE_API_KEY across Calendar and Drive). Admin doesn't
  //    have to retype the token a second time.
  interface ResolvedCred { envName: string; value: string; source: 'request' | 'reused' }
  const resolvedCreds: ResolvedCred[] = [];
  const bodyByEnv = new Map(body.credentials.map(c => [c.envName, c.value]));
  for (const entry of card.missingCredentials) {
    if (entry.authType === 'oauth') continue; // OAuth goes through its own flow
    const fromBody = bodyByEnv.get(entry.envName);
    if (fromBody !== undefined) {
      resolvedCreds.push({ envName: entry.envName, value: fromBody, source: 'request' });
      continue;
    }
    // Body omitted this envName — look for an existing value in
    // skill_credentials. Prefer the caller's userId over the agent-scope
    // sentinel; scan every skill_name on this agent so cross-skill sharing
    // works (e.g. GOOGLE_API_KEY across Calendar + Drive).
    const rows = await deps.skillCredStore.listForAgent(body.agentId);
    const candidates = rows.filter(r => r.envName === entry.envName);
    candidates.sort((a, b) => {
      const aScore = a.userId === userId ? 0 : a.userId === '' ? 1 : 2;
      const bScore = b.userId === userId ? 0 : b.userId === '' ? 1 : 2;
      return aScore - bScore;
    });
    const reused = candidates.length > 0 ? candidates[0].value : null;
    if (reused !== null) {
      resolvedCreds.push({ envName: entry.envName, value: reused, source: 'reused' });
    } else {
      return {
        ok: false,
        status: 400,
        error: 'Request does not match pending setup',
        details: `Missing credential: ${entry.envName}`,
      };
    }
  }

  // 7. Write every resolved value into the tuple-keyed skill_credentials
  //    store. User-scoped entries land at user_id = <userId>; agent-scoped
  //    ones at user_id = '' (the agent-scope sentinel).
  for (const cred of resolvedCreds) {
    const entry = card.missingCredentials.find(m => m.envName === cred.envName)!;
    await deps.skillCredStore.put({
      agentId: body.agentId,
      skillName: body.skillName,
      envName: cred.envName,
      userId: entry.scope === 'user' ? userId : '',
      value: cred.value,
    });
  }

  // 8. Apply domain approvals (idempotent).
  for (const domain of body.approveDomains) {
    await deps.skillDomainStore.approve({
      agentId: body.agentId,
      skillName: body.skillName,
      domain,
    });
  }

  // 9. Read fresh state from the live path. Live DB reads pick up the rows
  //    just written; the git snapshot cache is keyed on HEAD sha so the
  //    frontmatter side of the projection stays correct without an explicit
  //    invalidation.
  const states = await getAgentSkills(body.agentId, deps.agentSkillsDeps);
  const state = states.find(s => s.name === body.skillName);

  // 10. Generate committed tool modules if this approval transitions the
  //     skill to `enabled` AND the skill declares MCP servers. Errors are
  //     swallowed into the audit record — the approval has already succeeded
  //     (creds stored, domains approved), and the admin can retry via the
  //     refresh-tools endpoint.
  let toolSync: { moduleCount: number; toolCount: number; commit: string | null } | null = null;
  let toolSyncError: string | null = null;
  if (state?.kind === 'enabled') {
    const snapshot = await loadSnapshot(body.agentId, deps.agentSkillsDeps);
    const entry = snapshot.find(e => e.ok && e.name === body.skillName);
    if (entry?.ok && entry.frontmatter.mcpServers.length > 0) {
      try {
        const result = await deps.syncToolModules({
          agentId: body.agentId,
          skillName: body.skillName,
          mcpServers: entry.frontmatter.mcpServers,
          userId,
        });
        toolSync = {
          moduleCount: result.moduleCount,
          toolCount: result.toolCount,
          commit: result.commit,
        };
      } catch (err) {
        toolSyncError = err instanceof Error ? err.message : String(err);
      }
    }
  }

  // 11. Audit — never log credential values. Split envNames by source so the
  //     audit trail distinguishes fresh entry from reuse of an existing value.
  //     Let audit failures propagate: "Everything is audited" is a security
  //     invariant. If the audit provider blows up, credentials + domains are
  //     already written, and silent success leaves an evidence gap for a
  //     security-relevant action. The route handler's outer catch surfaces
  //     the error to the caller.
  await deps.providers.audit.log({
    action: 'skill_approved',
    sessionId: body.agentId,
    args: {
      agentId: body.agentId,
      skillName: body.skillName,
      domains: body.approveDomains,
      envNames: resolvedCreds.filter(c => c.source === 'request').map(c => c.envName),
      reusedEnvNames: resolvedCreds.filter(c => c.source === 'reused').map(c => c.envName),
      ...(toolSync ? { toolSync } : {}),
      ...(toolSyncError ? { toolSyncError } : {}),
    },
    result: 'success',
    durationMs: 0,
  });

  return { ok: true, state };
}
