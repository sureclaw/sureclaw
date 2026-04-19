# Skills as Git-Native Only: a Single-Source-of-Truth Redesign

**Status:** Design. Not yet ratified.
**Date:** 2026-04-18
**Motivation:** Recover lost weekend.

## Why this doc exists

Every bug we've hit in the skills subsystem over the past week has the same shape: **the git repo says one thing and the reconciler's state store says another, and the chain of processes that's supposed to keep them in sync fails silently**. The current design has ~6 interlocking pieces (git sidecar → post-receive hook → HMAC handshake → reconcile orchestrator → state store → in-memory appliers) and every single one has been a bug source at least once:

| Bug | Root cause |
|---|---|
| Agent pushes skill, nothing appears in dashboard | Chart didn't wire `AX_HOOK_SECRET` → hook short-circuited silently |
| Reconciler crashes on `ls-tree` | Assumed `axHome/repos/<agentId>` existed; git-http keeps bare repos on a different pod |
| Skill shows `ENABLED` but chat injection says "missing credential" | Approve stored at `user:ax:default`, chat looked up at `user:ax:<BetterAuthUUID>`; reconciler's prefix-match hid the mismatch |
| Delete + re-add skill → no new approval card | Reconciler prefix-matches stored creds → marks re-added skill `ENABLED` immediately → no card generated |
| `admin-approved domains` disappear on host restart | Kept only in `ProxyDomainList.adminApproved` in-memory set; no persistence path |
| `config.skills = []` masks on-disk skills | `??` kept empty array; filesystem fallback never ran |
| `/workspace/tools/linear.js` hallucination | Prompt text was stale about skill locations |
| `request_credential` + dashboard approvals competed | Two separate credential flows, neither authoritative |

Each bug has its own fix, and every fix adds more plumbing. The plumbing IS the problem.

## The unifying diagnosis

**We have two sources of truth** and we spend a lot of effort keeping them in sync:

1. **Git**: `.ax/skills/<name>/SKILL.md` files in the agent's workspace repo. Created/edited by the agent in the sandbox; committed and pushed by the sidecar. This is what the *agent* sees.
2. **State store**: `skill_states` and `skill_setup_queue` tables. Populated by the reconciler from git snapshots. Read by the admin dashboard, by the prompt module, by the MCP applier, by the proxy applier. This is what the *host* sees.

The reconcile orchestrator is the synchronization layer, and it runs at three trigger points (post-receive hook, startup rehydrate, post-approve reconcile). Every trigger can fail independently. The state store ages. In-memory appliers (MCP registry, proxy allowlist) are a *third* source-of-truthish layer that can drift from the DB.

Plus: credentials are stored in a *fourth* place (`credential_store`) with their own scoping scheme (`user:<agent>:<userId>` / `agent:<agent>` / global), looked up with prefix match in some places and exact match in others — a recipe we've already proven can diverge.

## The proposal

**Git is the one source of truth for skills. Everything else is derived.**

Practically:

### 1. Delete the state store

No `skill_states` table. No `skill_setup_queue` table. No reconciler. No rehydrate. No post-receive hook (or — see §7 — keep it as a 5-line cache buster).

### 2. Compute on demand

Any question about "what skills does agent X have, and are they enabled?" is answered by a pure function:

```
getAgentSkills(agentId):
  snapshot = gitSnapshot(agentId)                 # ls-tree + show for each SKILL.md
  for each skill in snapshot:
    missing = declaredCredentials - storedCredentials(agentId, skillName)
    unapproved = declaredDomains - approvedDomains(agentId, skillName)
    state = missing.empty && unapproved.empty ? 'enabled' : 'pending'
    yield { name, state, missing, unapproved, mcpServers, description }
```

No caching required for correctness. Cache in memory keyed by `(agentId, HEAD_sha)` for performance; see §7.

### 3. Credential scoping becomes unambiguous

Replace `credential_store(scope, env_name, value)` with:

```sql
CREATE TABLE skill_credentials (
  agent_id   TEXT NOT NULL,
  skill_name TEXT NOT NULL,
  env_name   TEXT NOT NULL,
  user_id    TEXT NULL,          -- null for agent-scope; the userId for user-scope
  value      TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (agent_id, skill_name, env_name, user_id)
);
```

Lookup at turn time: `SELECT value FROM skill_credentials WHERE agent_id = $1 AND skill_name = $2 AND env_name = $3 AND (user_id = $4 OR user_id IS NULL)`.

- No scope strings. No `user:ax:...` prefix dance.
- No prefix-match-vs-exact-match asymmetry.
- Deleting a skill cascade-deletes its credentials. No orphans.
- Rotating a credential is `UPDATE … WHERE (agent_id, skill_name, env_name, user_id) = (…)`. No approval re-trigger required.
- Sharing across skills is explicit: if two skills declare `GOOGLE_API_KEY`, they get two rows (or the UI offers a one-click "copy from other skill" on approval — see §5).

### 4. Approved domains are per-skill

Replace `ProxyDomainList.adminApproved` (in-memory, non-persistent) with:

```sql
CREATE TABLE skill_domain_approvals (
  agent_id    TEXT NOT NULL,
  skill_name  TEXT NOT NULL,
  domain      TEXT NOT NULL,
  approved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (agent_id, skill_name, domain)
);
```

A domain is on the proxy allowlist for an agent's traffic iff some enabled skill for that agent declares it AND there's a row in this table. No global "admin-approved domains" bucket that can drift.

### 5. Admin UX

**Approvals page** (top-level tab, already renamed):
- On load, iterate active agents → `getAgentSkills(agentId)` → filter to pending.
- Render one card per pending skill. Each card lists `missingCredentials` + `unapprovedDomains`.
- Approve button: `POST /admin/api/agents/:agentId/skills/:name/approve` with `{credentials: [{envName, value?}], approveDomains: [...]}`. Missing `value` → reuse from `skill_credentials` if another skill on this agent has the same envName (one-click cross-skill share), else reject. Writes all values + domain approvals atomically.

**Per-agent Skills tab** (already scaffolded):
- On load, `getAgentSkills(agentId)` → render every skill with its state.
- Each skill card has:
  - **Edit credentials** — inline form, posts to `PUT /admin/api/agents/:agentId/skills/:name/credentials`. Writes rows to `skill_credentials` at the caller's session userId. Skill stays enabled; takes effect on next turn.
  - **Delete** — `DELETE /admin/api/agents/:agentId/skills/:name`. Host invokes the workspace provider to commit `git rm -r .ax/skills/<name>/` on behalf of the agent and push. Cascade-deletes `skill_credentials` + `skill_domain_approvals` via FK.

No separate "revoke" action; deleting the skill deletes its creds, editing rotates them in place. No state transitions between enabled/pending except as a consequence of the underlying facts.

### 6. Prompt module reads directly

`buildSystemPrompt` calls `getAgentSkills(agentId)` instead of reading `ctx.skills` from the IPC-fetched state. The filesystem fallback goes away (no more "empty array masks on-disk skills"). The skills_index IPC action can stay as a thin wrapper around `getAgentSkills` for backward compat, or go away.

### 7. Performance at scale

`getAgentSkills` does, per call: `git ls-remote` (~20ms against the in-cluster git server), and — only if HEAD moved — `git ls-tree` + one `git show` per skill (~10ms each). For a hot agent making 10 turns in a row at the same HEAD, it's one round trip.

Two caches:
- **Per-agent snapshot cache**, keyed on `(agentId, HEAD_sha)`. In-memory, per-host-process. Bounded size (LRU ~1k entries). Populated lazily. No DB, no cross-host sync needed.
- **Optional push-hook cache buster**. Reuse the existing post-receive hook (`AX_HOOK_SECRET`, `AX_HOST_URL`) — but collapse its body to one line: `snapshotCache.delete(agentId)`. Hook failure degrades to "cache entry lives ≤ TTL"; no stuck state. This is ~5 lines, not 500.

Admin Approvals-page refresh = one `getAgentSkills` call per active agent. With the snapshot cache, most calls hit cache. Without the cache, fleet-wide is O(N × fetch_latency) with N parallelizable; fine up to thousands of agents on a single host.

### 8. Migration

**In-place and incremental.** The single-source-of-truth design can land alongside the current code and cut over per-subsystem:

1. **Add `getAgentSkills` function** + snapshot cache + HEAD-sha probe. Use it from the per-agent Skills tab first (already new — no existing users). Validate correctness against what the state store returns.
2. **Add `skill_credentials` + `skill_domain_approvals` tables** via Kysely migration. Dual-write from the current approve handler (writes to both old `credential_store` and new `skill_credentials`). Read paths stay on old tables.
3. **Rewire the Approvals page** to call `getAgentSkills` instead of reading `skill_setup_queue`. Keep the approve endpoint — just swap its backing store.
4. **Rewire prompt building** to call `getAgentSkills` directly. Remove the `skills_index` IPC action.
5. **Rewire credential injection** at turn start to read `skill_credentials` by `(agentId, skillName, envName, userId)`. Delete the `credentialScope` helpers and `listScopePrefix`.
6. **Delete the reconciler pipeline**: `reconcile-orchestrator.ts`, `state-store.ts`, `snapshot.ts`'s caller chain, `mcp-applier.ts`, `proxy-applier.ts`, `startup-rehydrate.ts`. Collapse the post-receive hook to cache-buster duty.
7. **Collapse proxy domain list** to a per-request query: "is `<domain>` approved for any enabled skill of `<agentId>`?"
8. **Drop tables** `skill_states`, `skill_setup_queue`, and (after verifying nothing reads it) `credential_store`.

Each step lands as its own PR. After step 4 we have two sources of truth again, transiently — but only until step 6. If anything goes wrong, revert the most recent step without touching the earlier ones.

### 9. What gets deleted

Ballpark:
- `src/host/skills/state-store.ts` (~200 lines)
- `src/host/skills/reconcile-orchestrator.ts` (~120)
- `src/host/skills/reconciler.ts` (~200)
- `src/host/skills/snapshot.ts` (stays, gets inlined into `getAgentSkills`)
- `src/host/skills/mcp-applier.ts` (~150)
- `src/host/skills/proxy-applier.ts` (~100)
- `src/host/skills/startup-rehydrate.ts` (~50)
- `src/host/skills/current-state.ts` (~80)
- `src/host/credential-scopes.ts` (~60)
- `src/host/proxy-domain-list.ts` (~140, replaced by per-request query)
- Large chunks of `src/host/server-admin-skills-helpers.ts` and `src/host/server-admin.ts` admin routes
- Migrations `storage_005_chat_sessions` onward that touched the skill tables
- ~15 test files

Back-of-envelope: ~1500–2000 lines of code + their tests. Replaced by ~400 lines of `getAgentSkills` + its cache + simpler admin routes + a smaller migration.

### 10. What stays

- The git-native authoring model (agent writes files, sidecar commits, host reads). This is the part that's actually working.
- The skill-creator seed skill + `.ax/skills/` layout.
- SKILL.md frontmatter schema (`name`, `description`, `credentials`, `mcpServers`, `domains`, `source`). Same parser.
- MCP connection manager — but it gets rebuilt-from-scratch on snapshot invalidation rather than incrementally applied. Simpler.
- The sidecar itself (separate container owning `.git`, agent can't see it).
- Post-receive hook infrastructure — repurposed to cache bust.
- BetterAuth session-userId threading through approvals (the recent fix).
- Admin dashboard Approvals tab + per-agent Skills tab UX.

## Invariants the new design guarantees

1. **Git is authoritative.** If the file isn't in the agent's `refs/heads/main:.ax/skills/<name>/SKILL.md`, the skill doesn't exist. Full stop.
2. **No stuck state is possible.** Every piece of derived data is either live-computed or cached with an invalidation signal; there's no table that can fall out of sync and survive a restart.
3. **Credential scope is a tuple, not a string.** `(agent_id, skill_name, env_name, user_id)`. No prefix match, no ambiguity, no FK orphans.
4. **Deletion is cascading.** Removing the SKILL.md file removes the skill's creds, removes its domain approvals, de-registers its MCP servers — atomically on the next turn for that agent, with no admin action required.
5. **Recovery is restart.** If everything is wrong, `kubectl rollout restart deploy/ax-host` clears caches; next request rebuilds state from git + DB. No special tooling, no SQL hand-editing, no documented "how to unstuck."

## Open questions

- **Admin-approved domains not tied to a skill.** The old design let admins whitelist domains independently of any skill (via the pending-domain queue on `ProxyDomainList`). Do we care? Arguably that was a footgun — a domain should always be tied to a reason it's allowed. If we need global whitelisting for operator convenience, add a separate `proxy_allowlist` table with its own admin surface. Don't mix it with skills.
- **OAuth state.** Phase 6 introduced admin-initiated OAuth flows with encrypted client-secret-at-rest. That machinery stays (separate concern from skill reconciliation), and its outputs write into `skill_credentials` like any other credential. OAuth is just one source of credential values.
- **Multi-user agents.** The design handles per-user credentials via the `user_id` column. "Agent-scoped" (shared across users) credentials have `user_id = NULL`. Turn-time lookup tries `user_id = <session>` first, falls back to `user_id IS NULL`. Simple two-row `OR`.
- **Phase 6 OAuth provider registrations** (admin pre-registers `client_id`+encrypted-`client_secret` per provider). Keep as-is — they're not skill-specific.

## Recommendation

Land this. The time we'll spend on the migration is less than we'll spend on the next 2–3 reconciler-drift bugs, and every step of the migration is independently revertable.

If we want to hedge, do steps 1–2 first (add `getAgentSkills` + dual-write tables) without removing anything. Validate for a week. Then commit to the full cutover or back out cleanly.
