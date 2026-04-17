# Git-Native Skills & Credentials Design

**Date:** 2026-04-16
**Status:** Design — implementation in progress (phases 1–4 landed, see Rollout Status below)
**Supersedes:** Parts of the current plugin/skill install flow in `src/plugins/`, `src/providers/storage/skills.ts`, and related CLI commands.

## Rollout Status

- **Phase 4 — Applier + rehydration:** Landed on `feat/skills-phase4-appliers` (commits `cec9015a..c1a2cd76`). Adds `src/host/skills/mcp-applier.ts`, `src/host/skills/proxy-applier.ts`, `src/host/skills/startup-rehydrate.ts`, wires both appliers into `reconcile-orchestrator.ts`, and runs a full reconcile for every registered agent on host boot so live `McpConnectionManager` + `ProxyDomainList` state matches the last-reconciled DB snapshot after a restart.

---

## Summary

Skills and tools in AX become **files in the agent's git workspace**. The agent authors and edits them with its existing file-editing tools — no install CLI, no plugin manifest, no DocumentStore for skills. The host process reconciles on `git push` via a post-receive hook, parses YAML frontmatter on each `SKILL.md`, and updates its side of the world: registers remote MCP servers, updates the proxy domain allowlist, surfaces missing credentials to a dashboard setup card.

Credentials never enter the agent's repo. They stay host-side, scoped by user/agent, and are injected into sandbox traffic by the existing web-proxy placeholder mechanism. OAuth (PKCE by default) is supported for services that offer it; API key paste is the fallback.

Skills that require pending approvals or missing credentials are **pending** — not registered, not on the proxy allowlist, invisible to the MCP connection manager. Pending state is a derived label on top of enforcement gates, not a separate layer of trust.

---

## Mental Model

Installing a skill is editing files. The agent writes `.ax/skills/<name>/SKILL.md` (plus any supporting files) using its normal `Write`/`Edit` tools, commits, and pushes. The host reacts.

**Agent is the author.** It fetches existing skills from URLs (user-provided or web-searched), adapts them, or authors new skills from scratch by reading API docs. Supports both user-directed ("install from github.com/foo/bar") and agent-initiated ("I need a Slack skill to finish this task") flows.

**Host is a reconciler.** After every push, the host computes desired state from the repo's current contents and updates its live state to match. Set-based, idempotent, stateless — desired state is a function of the latest commit.

---

## Directory Layout

```
<agent repo root>/
└── .ax/
    └── skills/
        ├── linear/
        │   ├── SKILL.md           # Required. Frontmatter + prose.
        │   └── examples.md        # Optional supporting files.
        ├── weather/
        │   └── SKILL.md
        └── linear-cli/
            └── SKILL.md
```

Exactly one `SKILL.md` per skill directory. Directory name is the canonical skill name.

---

## Frontmatter Schema

```yaml
---
name: linear
description: When the user wants to query or update Linear issues, projects, or teams.

# Optional — tracks the skill's source for updates.
source:
  url: https://github.com/foo/bar-skill/blob/main/SKILL.md
  version: v1.2.0     # commit hash, tag, or semver — freeform string

# Zero or more credentials.
credentials:
  - envName: LINEAR_TOKEN
    authType: oauth         # oauth | api_key (default: api_key)
    scope: user             # user | agent (default: user)
    oauth:
      provider: linear      # shown in dashboard button: "Connect with Linear"
      clientId: pub_abc123  # public, PKCE-only
      authorizationUrl: https://linear.app/oauth/authorize
      tokenUrl: https://api.linear.app/oauth/token
      scopes: [read, write]

# Zero or more remote MCP servers.
mcpServers:
  - name: linear           # unique per agent
    url: https://mcp.linear.app/sse
    credential: LINEAR_TOKEN  # references credentials[].envName; injected as Bearer

# Domains the skill needs network access to.
domains:
  - api.linear.app
  - mcp.linear.app
---

# Linear skill

(prose instructions for the agent follow)
```

**Field rules:**

- `name` and `description` are required.
- `authType` defaults to `api_key`. `oauth` requires an `oauth:` block.
- `scope` defaults to `user` — each user gets their own token. `agent` means shared across users of this agent.
- `domains` is the full set of hosts the skill will reach. The reconciler unions these across all skills to build the proxy allowlist.
- `mcpServers[].credential` references a `credentials[].envName` in the same skill. The host injects the stored credential as `Authorization: Bearer <token>` when connecting to the MCP server.
- `source` is optional — agent-authored skills omit it. Used by the agent when re-fetching for updates.

Validation: Zod `.strict()` schema. Invalid frontmatter → skill is skipped, a `skill.invalid` event is emitted to the dashboard with the validation error. Push is not rejected.

---

## Reconciliation Flow

**Trigger:** git post-receive hook on the agent's workspace repo.

- `git-local` workspace: shell script in `hooks/post-receive` of the bare repo calls the host's IPC endpoint with the agent ID.
- `git-http` workspace: the git-http server (same process as the host) emits a post-receive event directly into the event bus.

**Steps:**

1. **Snapshot.** Check out `.ax/skills/` from the latest commit into a host-side temp directory (never shared with the sandbox). Walk all `SKILL.md` files.

2. **Parse & validate.** Each SKILL.md's frontmatter through the Zod schema. Invalid → skip, emit `skill.invalid`.

3. **Compute desired state** as unions across all valid skills:
   - **MCP servers**: keyed by `name`. Conflict (same name, different URL) → error, surface to dashboard, skip.
   - **Domains needed**: union of all `domains:` fields.
   - **Credentials needed**: keyed by `envName`. Conflict (same envName, different authType) → error, skip.

4. **Compute enable state per skill.** A skill is **enabled** iff all its domains are on the approved allowlist AND all its credentials have stored values at the required scope. Otherwise **pending**.

5. **Apply:**
   - **MCP servers:** register URLs of *enabled* skills with `McpConnectionManager`; unregister ones no enabled skill references anymore.
   - **Proxy allowlist:** equal to the approved allowlist intersected with domains referenced by enabled skills. Atomic replace.
   - **Domain approval requests:** for each domain referenced by a pending skill that isn't on the approved allowlist, queue an approval on the skill's setup card.
   - **Credential requests:** for each missing credential, queue it on the skill's setup card with its OAuth/API-key metadata.

6. **Notify.** Emit `skills.reconciled` (summary) and `skill.setup_required` per skill needing setup. Dashboard renders setup cards.

7. **Audit.** Every enable/disable transition, approval queue entry, MCP register/unregister, and allowlist change logs an entry.

**Resource lifecycle:**

- MCP servers and domains are reference-counted via set membership — a resource stays as long as *any* enabled skill references it. When the last reference is removed, the MCP server is unregistered and the domain is marked "unused" in the dashboard (user can prune the approved allowlist entry).
- **Credentials are never auto-deleted.** Even if no skill references an envName anymore, the stored value persists until the user deletes it via the dashboard.

---

## Credentials & Setup UX

### Dashboard Credentials page

Two kinds of cards:

**1. Skill setup card (primary UX).** One card per skill with pending setup. Bundles everything the user needs to approve/provide in one place:

```
┌─ Linear ────────────────────────────────────────┐
│ When the user wants to query or update Linear    │
│ issues, projects, or teams.                      │
│                                                  │
│ NETWORK ACCESS                                   │
│ ☑ api.linear.app                                 │
│ ☑ mcp.linear.app                                 │
│                                                  │
│ CREDENTIALS                                      │
│ LINEAR_TOKEN  [ Connect with Linear → ]          │
│                                                  │
│ MCP SERVERS (info)                               │
│ • linear → https://mcp.linear.app/sse            │
│                                                  │
│ [ Cancel ]              [ Approve & enable ]     │
└──────────────────────────────────────────────────┘
```

Atomic approval: user clicks once; domain allowlist, credential storage, and MCP registration all land together. If canceled, nothing is applied — the skill files sit in the repo but the host treats it as pending.

**Deltas on update:** when a reconciled skill changes, the card surfaces only the new parts ("Linear skill updated: wants access to `mcp.linear.app`"), with the existing approved parts noted.

**Persistence across sessions:** setup cards sit in a queue until the user reviews them. If the agent adds a skill during a cron run, the card waits in the dashboard until the user logs in.

**2. Standalone credential card (ad-hoc).** When the agent calls `request_credential` outside any skill frontmatter (e.g., ad-hoc HTTP call), a standalone card shows `envName` + paste field. `authType` defaults to `api_key` since there's no frontmatter to declare OAuth.

### OAuth flow (PKCE default)

When the user clicks "Connect with Linear":

1. Dashboard generates PKCE verifier + challenge.
2. Opens `authorizationUrl` in a new tab with `clientId`, `redirect_uri` (the dashboard callback), `code_challenge`, `scopes`.
3. User authenticates with Linear; Linear redirects back with an auth code.
4. Dashboard callback exchanges code + verifier at `tokenUrl`; receives access token.
5. Token stored as `envName` (`LINEAR_TOKEN`) at the declared scope.
6. "Connect with Linear" flips to "Connected as <user>"; final "Approve & enable" becomes clickable.

**Admin-registered OAuth fallback.** If an admin has configured a provider named `linear` in AX settings with their own `clientId`/`clientSecret`, the host uses those (confidential flow if secret present) instead of the frontmatter's public `clientId`. Invisible to the end user. Enables enterprise OAuth apps and services that don't support PKCE.

---

## Agent's Role

### Discovery

For launch, no central catalog:

- **User-provided URL:** "Install from `github.com/foo/bar-skill`" → agent fetches, validates, copies in.
- **Web search:** "Install a Linear skill" → agent searches via proxy, picks a candidate, explains its choice.
- **Author from scratch:** no existing skill → agent reads API docs, writes a bespoke SKILL.md.

A curated registry can come later; the primitive (agent + web + git) is sufficient.

### Install / update / remove

All three are file operations:

- **Install:** agent writes `.ax/skills/<name>/SKILL.md`, commits, pushes. Reconcile takes over.
- **Update:** agent re-fetches from `source.url`, overwrites files, commits, pushes. Changes to `credentials:`/`domains:`/`mcpServers:` re-trigger a setup card.
- **Remove:** agent deletes `.ax/skills/<name>/`, pushes. Reconcile unregisters resources; credentials persist.

### Prompt context (progressive disclosure)

The prompt builder emits a short index, not full content:

```
## Available skills

- **linear** — (setup pending: needs LINEAR_TOKEN, awaiting approval for mcp.linear.app) When the user wants to query or update Linear issues...
- **weather** — When the user asks about weather conditions or forecasts.
- **linear-cli** — When the user wants to manage Linear issues from the CLI.

To use a skill, read `.ax/skills/<name>/SKILL.md` and follow its instructions.
```

The agent loads full SKILL.md on demand via its existing `Read` tool — no new primitive. Scales to hundreds of skills without bloating the prompt.

**The index is host-authoritative.** The prompt module queries the host's reconciled state (via IPC) for `{name, description, enabled|pending, pendingReasons}` — it does not naively glob and parse frontmatter itself. This prevents the agent from editing a file to claim a skill is enabled when the host hasn't approved it.

---

## Pending State & Defense-in-Depth

Pending is a derived label. Enforcement lives at the gates:

1. **Proxy allowlist.** Domains of pending skills are not on the allowlist. Any outbound HTTP hits a proxy block.
2. **Credential placeholder injection.** Missing credentials → no placeholder generated → env var empty in sandbox → upstream returns 401.
3. **MCP registration.** Pending skill's MCP servers are not registered → no tool stubs exposed → agent has no way to call them.
4. **Skill index marker (soft).** Index shows pending reasons so the agent knows not to try. Not a trust boundary.

If an agent ignores the index (prompt injection, odd reasoning), layers 1–3 still hold. No enforcement relies on agent cooperation.

---

## Security Invariants

| Invariant | How it holds up |
|---|---|
| No network in agent containers | Preserved. Proxy + per-domain approval strengthens it. |
| Credentials never enter containers | Preserved. Skill files contain only `envName` references; real values stay host-side; placeholder injection unchanged. |
| All external content is taint-tagged | Preserved. Fetched skill sources arrive through the proxy, already tainted. User approval on the setup card gates the skill's declared resources. |
| Everything audited | Preserved. Reconcile, approvals, OAuth flows, credential writes, enable/disable transitions — all emit audit entries. |
| No dynamic imports from config | Preserved. Frontmatter drives *registration* only (URLs, envNames, domain strings). No code is loaded from skill metadata. Static provider map unchanged. |

### New attack surfaces

- **Malicious MCP server URL.** Frontmatter could declare `url: attacker.com/mcp, credential: LINEAR_TOKEN`. **Mitigation:** setup card prominently displays MCP URLs; `attacker.com` also requires domain approval. Two visible signals.
- **Prompt injection via description/prose.** A fetched SKILL.md might contain adversarial instructions. **Mitigation:** user sees name + description on the setup card; documentation recommends only installing from trusted sources.
- **Silent prose updates.** Updates that touch only prose don't re-prompt. **Mitigation:** user can diff via git. Changes to any declared resource (`credentials`, `mcpServers`, `domains`) always re-prompt.
- **Skill writes during cron.** Agent can add skills when no user is present. **Mitigation:** pending state + persistent setup queue; no skill is silently enabled.

---

## Migration Strategy

AX is early-stage. Recommended approach: **fresh start**.

- Drop the DocumentStore skill storage (`src/providers/storage/skills.ts`) and its schema.
- Remove `ax plugin install/remove/list` commands (or leave as shims that print "say `install X` in chat").
- Remove `ax mcp add/remove/list` commands — MCP servers now come from skill frontmatter.
- Keep `ax provider add/remove` — providers are host-side code, a different concept.
- Keep credential storage untouched; dashboard is one path, any future CLI another.
- In chat, when a user previously relied on `ax plugin install`, the agent can help them reinstall by writing the skill files.

If real users have production skills, a one-time migrator (walk DocumentStore, synthesize frontmatter, write into each agent's repo, run reconcile) is straightforward but not recommended until needed.

---

## What Goes Away

- `src/plugins/` directory (fetcher, parser, install, store, mcp-manager's plugin-install paths) — most or all.
- `src/providers/storage/skills.ts` — skills are files, not DocumentStore entries.
- `src/cli/plugin.ts` and `src/cli/mcp.ts` — replaced by agent-driven install / frontmatter.
- Plugin-scoped skill keys (`plugin:<name>:<skill>`).
- Skill install IPC handler (`src/host/ipc-handlers/skills.ts` install action; keep `credential_request`).

## What Stays

- `request_credential` tool — still the primitive for ad-hoc credential requests. Frontmatter-driven path is additive.
- `src/providers/credentials/database.ts` and credential scoping — unchanged.
- `src/host/credential-placeholders.ts` — unchanged.
- `src/host/web-proxy.ts` — unchanged, now fed by reconciled skill allowlist.
- `McpConnectionManager` — now populated from frontmatter rather than plugin install.
- Git workspace providers (`git-local`, `git-http`) — extended with post-receive hook wiring.

## What's New

- Post-receive hook infrastructure for both workspace implementations.
- Frontmatter Zod schema and parser.
- Reconciler module (host-side): snapshot → parse → diff → apply → emit events.
- Dashboard Credentials page with skill setup cards.
- OAuth PKCE flow + dashboard callback handler.
- Admin-registered OAuth app config section in AX settings.
- Enable/pending state model + host-authoritative skill index for the agent prompt.
- Audit events for skill lifecycle (`skill.installed`, `skill.updated`, `skill.removed`, `skill.enabled`, `skill.pending`, `skill.invalid`, `domain.approved`, `domain.rejected`).

---

## Open Questions

- **Per-agent vs per-workspace reconciler state.** A single AX deployment can host multiple agents, each with its own repo. Reconciler should be keyed by `agentId`; audit entries scoped accordingly. Implementation detail.
- **Approved-but-unused domain cleanup UX.** Dashboard should show "N approved domains are no longer referenced by any skill — prune?" Not required for launch but improves hygiene.
- **Skill enable/disable toggle independent of setup.** Should the user be able to manually disable an otherwise-enabled skill? Probably yes — a simple boolean on the card. Not in v1.
- **MCP auth schemes beyond Bearer.** Current design injects the referenced credential as `Authorization: Bearer <token>`. Some MCPs want other schemes. Extend `mcpServers[].credential` to an object when real use cases demand it (`{ envName: ..., scheme: 'bearer' | 'header:X-API-Key' | ... }`).
- **Cron-initiated skill writes rate limit.** Should there be a limit on how many skills an agent can add in a cron window? Probably unnecessary given pending-state safety, but worth revisiting if abuse appears.
