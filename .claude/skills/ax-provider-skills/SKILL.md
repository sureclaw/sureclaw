---
name: ax-provider-skills
description: Use when modifying the git-native skills pipeline — skill format parsing, manifest generation, the workspace reconciler, the admin skill-approval flow, or skill state storage in src/host/skills/, src/utils/skill-format-parser.ts, and src/utils/manifest-generator.ts
---

## Overview

Skills are just files in the agent's workspace at `.ax/skills/<name>/SKILL.md`. To add one, write the file and commit. The host reconciler picks it up, parses the frontmatter, and surfaces a card in the admin dashboard for anything that needs operator approval (new domains, MCP servers, credentials). The agent runs the skill once it is approved.

There is no CLI install command, no registry download, and no DocumentStore row. All prior plumbing — `skill_install`/`skill_create`/`skill_update`/`skill_delete` IPC actions, the ClawHub registry client, the legacy `SkillStoreProvider`, and the `ax plugin`/`ax mcp` CLI — has been removed.

## Lifecycle

```text
User/agent writes .ax/skills/<name>/SKILL.md (in workspace git)
  |  git commit in the agent's workspace
Reconciler (src/host/skills/reconcile-orchestrator.ts)
  |-- Parses SKILL.md via parseAgentSkill()
  |-- Generates a manifest (domains, MCP servers, required env)
  |-- Writes rows into skill_states + skill_setup_queue tables
         |
Admin dashboard (/skills)
  |-- Lists pending cards (from skill_setup_queue)
  |-- Operator pastes credentials, approves domains, clicks Approve
  |-- POST /admin/api/skills/setup/approve -> approveSkillSetup()
         |
Skill becomes active:
  |-- Domains added to proxy allowlist
  |-- MCP servers registered with McpConnectionManager
  |-- Credentials stored in credential provider
  |-- skill_state transitions to 'active'
```

## Key Files

| File | Purpose |
|------|---------|
| `src/host/skills/reconcile-orchestrator.ts` | Top-level reconciler: walks workspace skills, writes state + setup queue rows |
| `src/host/skills/state-store.ts` | Kysely-backed CRUD for `skill_states` and `skill_setup_queue` |
| `src/host/skills/current-state.ts` | Reads current domain/credential/MCP state (used by the approval decision) |
| `src/host/skills/mcp-applier.ts` | Registers approved MCP servers with `McpConnectionManager` |
| `src/host/skills/types.ts` | `SkillStateKind`, `SetupRequest`, and related types |
| `src/host/server-admin-skills-helpers.ts` | `approveSkillSetup()` — the approval POST handler |
| `src/host/proxy-domain-list.ts` | Adds approved skill domains to the proxy allowlist |
| `src/migrations/skills.ts` | Kysely migration for `skill_states` + `skill_setup_queue` |
| `src/utils/skill-format-parser.ts` | `parseAgentSkill(raw)` — SKILL.md to ParsedAgentSkill |
| `src/utils/manifest-generator.ts` | `generateManifest(parsed)` — static analysis for domains, bins, etc. |
| `src/agent/prompt/modules/skills.ts` | Skills prompt module — renders active skills in the system prompt |
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

### SkillState (src/host/skills/state-store.ts)

Persisted state for a skill in a particular agent:
- `agent_id`, `skill_name` — composite primary key
- `kind` — `'active' | 'pending' | 'error' | 'dismissed'`
- `description`, `pending_reasons`, `error`

### SetupRequest

An entry in `skill_setup_queue`. Drives admin dashboard cards: what's needed (credentials, domains, MCP servers) for a skill to become active.

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
- **Reconcile an agent's skills**: Call the reconcile orchestrator (usually triggered by workspace commit events).
- **Approve a pending skill setup**: POST to `/admin/api/skills/setup/approve` with the `SetupRequest` body. The helper in `server-admin-skills-helpers.ts` validates, applies domains/MCP/credentials, and transitions state.
- **Add screening logic**: Implement `SkillScreenerProvider.screen()` or `screenExtended()`.

## Gotchas

- **No DocumentStore skill collection**: `documents.get('skills', ...)` / `documents.list('skills')` return nothing. The collection was drained in phase 7; new code should not read from it.
- **No CLI install path**: Don't wire new code to `ax plugin` or `ax mcp`. They're gone. Everything goes through the git-native flow.
- **`skill_propose` still exists**: Agents can still write new SKILL.md files via the `skill_propose` tool. That bypass goes through the screener and lands in the workspace just like a human-authored skill.
- **`safePath` required**: Security invariant (SC-SEC-004) for all path construction.
- **Permission mapping**: OpenClaw names auto-map to AX IPC action names.
- **Hard-reject is non-negotiable**: Enforced regardless of declared permissions.
- **Reconciler is authoritative**: It truncates and rewrites `skill_states` + `skill_setup_queue` in a single transaction per agent. Don't write to those tables outside the reconciler / approval helper.
