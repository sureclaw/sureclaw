---
name: ax-provider-skills
description: Use when modifying the git-native skills pipeline — skill format parsing, manifest generation, live skill-state derivation from git, the admin skill-approval flow, tuple-keyed skill credentials, or the post-receive cache-busting hook in src/host/skills/, src/utils/skill-format-parser.ts, and src/utils/manifest-generator.ts
---

## Overview

Skills are just files in the agent's workspace at `.ax/skills/<name>/SKILL.md`. To add one, the agent writes the file and the sidecar commits + pushes it. The host derives the skill's state live at read time from the git snapshot plus the tuple-keyed `skill_credentials` + `skill_domain_approvals` tables. Anything that needs operator approval (new domains, new credentials) surfaces a card in the admin dashboard. The agent runs the skill once its requirements are satisfied.

Git is the one source of truth. There is no `skill_states` / `skill_setup_queue` state store, no reconciler, no startup rehydrate, no MCP/proxy applier — the derivation is a pure function of the snapshot + the credential/domain tables. A per-(agentId, HEAD-sha) snapshot cache keeps hot paths cheap; a post-receive hook invalidates it after each push.

## Lifecycle

```text
User/agent writes .ax/skills/<name>/SKILL.md (in workspace git)
  |  sidecar commits + pushes in the agent's workspace repo
Post-receive hook (src/host/skills/hook-endpoint.ts)
  |-- HMAC-verifies the payload (X-AX-Hook-Signature: sha256=<hex>)
  |-- Invokes snapshotCache.invalidateAgent(agentId)
         |
Admin dashboard (/skills)
  |-- Per-agent Skills tab + top-level Approvals tab call getAgentSkills / getAgentSetupQueue
  |-- For each agent: walk refs/heads/main, parse every .ax/skills/*/SKILL.md,
      diff frontmatter against stored credentials + approved domains
  |-- Operator pastes credentials, approves domains, clicks Approve
  |-- POST /admin/api/skills/setup/approve -> approveSkillSetup()
         |
Skill transitions to 'enabled' on the next live read:
  |-- skill_credentials row written at (agent_id, skill_name, env_name, user_id)
  |-- skill_domain_approvals row written; proxy allowlist rebuilt from enabled skills
  |-- snapshotCache.invalidateAgent(agentId) called so the next turn reads fresh state
```

## Key Files

| File | Purpose |
|------|---------|
| `src/host/skills/get-agent-skills.ts` | `getAgentSkills()` + `getAgentSetupQueue()` — live derivation from git + host state |
| `src/host/skills/snapshot.ts` | `buildSnapshotFromBareRepo(path, ref)` — walks `.ax/skills/*/SKILL.md` |
| `src/host/skills/snapshot-cache.ts` | Bounded LRU cache keyed on `${agentId}@${headSha}`; supports `invalidateAgent` |
| `src/host/skills/state-derivation.ts` | Pure helpers: `computeSkillStates`, `computeSetupQueue` |
| `src/host/skills/skill-cred-store.ts` | Kysely-backed CRUD for `skill_credentials` (tuple-keyed: agent × skill × env × user) |
| `src/host/skills/skill-domain-store.ts` | Kysely-backed CRUD for `skill_domain_approvals` |
| `src/host/skills/hook-endpoint.ts` | HMAC-verified post-receive hook; drops cache entries for the pushed agent |
| `src/host/skills/types.ts` | `SkillSnapshotEntry`, `SkillState`, `SkillStateKind`, `SetupRequest`, `SkillDerivationState` |
| `src/host/skills/domain-allowlist.ts` | `BUILTIN_DOMAINS` + `getAllowedDomainsForAgent()` — the per-agent proxy allowlist query |
| `src/host/server-admin-skills-helpers.ts` | `approveSkillSetup()` — the approval POST handler |
| `src/migrations/skills.ts` | Kysely migrations for the tuple-keyed `skill_credentials` + `skill_domain_approvals` tables |
| `src/utils/skill-format-parser.ts` | `parseAgentSkill(raw)` — SKILL.md to ParsedAgentSkill |
| `src/utils/manifest-generator.ts` | `generateManifest(parsed)` — static analysis for domains, bins, etc. |
| `src/agent/prompt/modules/skills.ts` | Skills prompt module — renders enabled skills in the system prompt |
| `src/agent/skill-installer.ts` | Runs `install` steps declared in SKILL.md inside the sandbox |

## Core Types

### ParsedAgentSkill (src/utils/skill-format-parser.ts)

Parsed representation of a SKILL.md file:
- `name`, `description?`, `version?`, `license?`, `homepage?`
- `requires` — `bins`, `env`, `domains`, `oauth` (`OAuthRequirement[]`), `anyBins`, `config`
- `install` — `SkillInstallStep[]` (raw `run` shell commands)
- `os?` — platform constraints
- `permissions` — mapped from OpenClaw terms to AX IPC actions
- `triggers?`, `tags?`, `body`, `codeBlocks`

### SkillState (src/host/skills/types.ts)

Live-derived per-skill verdict for an agent:
- `name`, `kind` (`'enabled' | 'pending' | 'invalid'`)
- `description?` (present for valid frontmatter)
- `pendingReasons?` (why a skill is pending — missing creds, unapproved domains)
- `error?` (present for invalid parse results)

### SetupRequest

Live-derived setup-card payload for a skill that's still pending. What's needed (credentials, domains, MCP servers) for a skill to become enabled. Emitted only for skills with at least one unmet requirement.

### SkillDerivationState

The `(approvedDomains, storedCredentials)` tuple that `computeSkillStates` / `computeSetupQueue` consume. Built inside `getAgentSkills` from `skillDomainStore.listForAgent(agentId)` + `skillCredStore.listForAgent(agentId)`. Keys are **skill-scoped** (`${skillName}/${envName}@${scope}` and `${skillName}/${normalizedDomain}`) so a row from one skill can't silently satisfy a different skill with the same envName/domain.

### Orphan Sweep

`sweepOrphanedRows(agentId, snapshot, deps)` in `get-agent-skills.ts` deletes `skill_credentials` + `skill_domain_approvals` rows whose `skill_name` isn't in the current workspace snapshot. Called by `getAgentSkills`, `getAgentSetupQueue`, and `getAllowedDomainsForAgent` before projection. Ensures **delete-then-re-add** of a skill (remove SKILL.md, commit, re-add SKILL.md with the same name) forces a fresh admin approval — rows from the prior life don't auto-enable the re-added skill. Cross-skill credential reuse still works via the approve helper (step 6 in `approveSkillSetup`), where the admin clicks Approve and the value is pulled from another skill's row.

## Static Screener

Skill content and workspace releases still pass through the screener provider (`src/providers/screener/`). Five layers:

| Layer | Type | Patterns |
|-------|------|----------|
| 1. Hard-Reject | BLOCK | dangerous runtime calls (eval, spawn, Function, etc.) |
| 2. Exfiltration | FLAG (0.4) | URLs with data params, webhook.site, requestbin, ngrok |
| 3. Prompt Injection | FLAG (0.3) | HTML comment directives, zero-width chars, role reassignment |
| 4. External Deps | FLAG (0.2) | CDN scripts, external binary URLs, curl-pipe-to-shell |
| 5. Capability Mismatch | FLAG (0.15) | Undeclared fs.write, process.env, crypto, docker commands |

Scoring: Any BLOCK or score >= 0.8 -> REJECT; score >= 0.3 -> REVIEW; score < 0.3 -> APPROVE.

## Skill Format Parsing

`parseAgentSkill(raw)` in `src/utils/skill-format-parser.ts` converts SKILL.md into `ParsedAgentSkill`:
- Extracts YAML frontmatter, resolves `metadata.openclaw` (aliases: `clawdbot`, `clawdis`)
- Maps OpenClaw permissions to AX IPC actions (`full-disk-access` -> `workspace_write`, `web-access` -> `web_fetch`, etc.)
- Extracts code blocks and install specs

## Common Tasks

- **Parse a SKILL.md**: Call `parseAgentSkill(raw)` for `ParsedAgentSkill`.
- **Generate a manifest**: Call `generateManifest(parsed)`.
- **Read an agent's skill states**: `await getAgentSkills(agentId, deps)` — returns `SkillState[]` derived live.
- **Read an agent's pending setup queue**: `await getAgentSetupQueue(agentId, deps)` — one card per skill with unmet requirements.
- **Approve a pending skill setup**: POST to `/admin/api/skills/setup/approve` with the `SetupRequest` body. The helper in `server-admin-skills-helpers.ts` validates against the live card, writes rows to `skill_credentials` + `skill_domain_approvals`, invalidates the snapshot cache, and returns the fresh `SkillState`.
- **Invalidate cache after a push**: The post-receive hook handles this automatically. Direct callers can use `snapshotCache.invalidateAgent(agentId)`.
- **Add screening logic**: Implement `SkillScreenerProvider.screen()` or `screenExtended()`.

## Gotchas

- **No DocumentStore skill collection**: `documents.get('skills', ...)` / `documents.list('skills')` return nothing. The collection was drained in phase 7; new code should not read from it.
- **No CLI install path**: Don't wire new code to `ax plugin` or `ax mcp`. They're gone. Everything goes through the git-native flow.
- **`skill_propose` still exists**: Agents can still write new SKILL.md files via the `skill_propose` tool. That bypass goes through the screener and lands in the workspace just like a human-authored skill.
- **`safePath` required**: Security invariant (SC-SEC-004) for all path construction.
- **Permission mapping**: OpenClaw names auto-map to AX IPC action names.
- **Hard-reject is non-negotiable**: Enforced regardless of declared permissions.
- **Git is authoritative**: `skill_states` + `skill_setup_queue` tables have been dropped. Always derive from `getAgentSkills` / `getAgentSetupQueue`.
- **Credential scope is a tuple**: `(agent_id, skill_name, env_name, user_id)` — no prefix matching. User-scope rows store the caller's user_id; agent-scope uses `''` as the sentinel.
- **Cache key is `${agentId}@${headSha}`**: `probeHead` runs `git ls-remote` for the main ref; the result scopes cache hits. A reduce-cost shortcut when HEAD hasn't moved.
