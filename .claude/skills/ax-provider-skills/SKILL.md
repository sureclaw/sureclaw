---
name: ax-provider-skills
description: Use when modifying skill types, AgentSkills format parsing, manifest generation, skill install IPC handler, ClawHub registry client, or skill persistence in src/providers/skills/, src/host/ipc-handlers/skills.ts, and src/clawhub/registry-client.ts
---

## Overview

The skills provider directory now contains only type definitions (`types.ts`). The `SkillStoreProvider` interface, `database.ts`, `readonly.ts`, and `git.ts` implementations have been removed. Skills are now managed through the host's IPC handlers (`src/host/ipc-handlers/skills.ts`). Skill screening is handled by the screener provider (`src/providers/screener/`).

This skill covers: `ParsedAgentSkill` format types, skill install IPC handler, ClawHub registry client, manifest generation, GCS workspace persistence, and agent-side skill loading.

## Skill Install Lifecycle (End-to-End)

Understanding this lifecycle is critical to avoid regressions:

```text
Agent calls skill({ type: "install", slug: "author/name" })
  |  IPC
Host: skill_install handler (src/host/ipc-handlers/skills.ts)
  |-- 1. Download from ClawHub (resolves author/name -> name on 404)
  |-- 2. Parse SKILL.md, generate manifest
  |-- 3. Write files to host filesystem (~/.ax/agents/<id>/users/<userId>/skills/<slug>/)
  |-- 4. Queue files for GCS via providers.workspace?.setRemoteChanges()
  |-- 5. Add domains to proxy allowlist
  |-- 6. Return { installed, slug, requiresEnv, domains }
         |
Session completes -> workspace.commit(sessionId)
  |-- diff('user') returns queued skill files
  |-- commit('user', userId, changes) uploads to GCS
         |
Next session starts -> workspace provision
  |-- downloadScope('user', userId) fetches skill files from GCS
  |-- Files placed at /workspace/<sessionId>/user/skills/<slug>/
         |
Agent: buildSystemPrompt() -> loadSkillsMultiDir()
  |-- Reads SKILL.md from {agentWorkspace}/skills/ and {userWorkspace}/skills/
  |-- Skills appear in prompt as "Available Skills (Already Installed)"
```

### Dual Persistence (filesystem + GCS)

The `skill_install` handler writes files to **two** locations:

1. **Host filesystem** (`userSkillsDir(agentId, userId)`) -- works for subprocess sandbox (shared filesystem). The `userSkillsDir()` function is deprecated but still needed.

2. **GCS via workspace provider** (`setRemoteChanges()`) -- required for k8s mode where sandbox pods can't access the host filesystem. Files are queued as `RemoteFileChange[]` with scope `'user'` and committed to GCS at session end.

**Both writes must happen.** If you only write to filesystem, k8s skills won't persist. If you only write to GCS, subprocess sandbox skills won't work.

### Slug Resolution

ClawHub URLs use `author/name` format (e.g. `ManuelHettich/linear`) but the API download endpoint uses just the skill slug (`linear`). Both `fetchSkillPackage()` and `fetchSkill()` handle this: if the full slug 404s and contains a `/`, they retry with just the name part after `/`.

The `skill_install` handler also parses ClawHub URLs from `slug` or `query` fields. If either field contains a `clawhub.ai/...` URL (e.g. `https://clawhub.ai/ManuelHettich/linear`), the handler extracts the path as the slug (`ManuelHettich/linear`) and bypasses search. This prevents search from returning an unrelated skill.

The `skill_install` handler updates its local `slug` variable to `pkg.slug` (the resolved name) after download, so filesystem paths and GCS paths use the clean slug without the author prefix.

## Key Files

| File | Purpose |
|------|---------|
| `src/host/ipc-handlers/skills.ts` | `skill_install`, `credential_request`, `audit_query` IPC handlers |
| `src/clawhub/registry-client.ts` | ClawHub API client: search, fetchSkill, fetchSkillPackage, listPopular |
| `src/utils/skill-format-parser.ts` | `parseAgentSkill(raw)` -- SKILL.md to ParsedAgentSkill |
| `src/utils/manifest-generator.ts` | `generateManifest(parsed)` -- static analysis for domains, bins, etc. |
| `src/agent/agent-setup.ts` | `buildSystemPrompt()` -- loads skills from workspace dirs |
| `src/agent/stream-utils.ts` | `loadSkillsMultiDir()` -- reads SKILL.md files from directories |
| `src/agent/skill-installer.ts` | `installSkillDeps()` -- runs install steps from SKILL.md |
| `src/agent/prompt/modules/skills.ts` | Skills prompt module -- renders installed skills table |
| `src/host/workspace-release-screener.ts` | Screens skill .md files and binaries during workspace commit |
| `src/providers/skills/types.ts` | Types-only module -- re-exports screener types |
| `src/paths.ts` | `userSkillsDir()`, `agentSkillsDir()` (both deprecated) |
| `tests/host/skill-install.test.ts` | Unit tests for skill_install handler |

## Core Types (`src/providers/skills/types.ts`)

Types-only module -- re-exports screener types from `src/providers/screener/types.ts` for backward compatibility.

### ParsedAgentSkill

Parsed representation of a SKILL.md file:
- `name`, `description?`, `version?`, `license?`, `homepage?`
- `requires` -- `bins` (required host binaries), `env` (required env vars), `domains` (required API domains for proxy allowlist), `oauth` (`OAuthRequirement[]`), `anyBins` (alternative binary options), `config` (config keys)
- `install` -- `SkillInstallStep[]` (raw `run` shell commands, not structured kind/package taxonomy)
- `os?` -- platform constraints
- `permissions` -- mapped from OpenClaw terms to AX IPC actions
- `triggers?` -- event triggers
- `tags?` -- categorization tags
- `body` -- markdown body text
- `codeBlocks` -- extracted code blocks

### SkillInstallStep

| Field   | Type       | Required | Notes                                    |
|---------|------------|----------|------------------------------------------|
| `run`   | string     | yes      | Shell command to run                     |
| `label` | string     | no       | Human-readable description               |
| `bin`   | string     | no       | Binary that should exist after install   |
| `os`    | string[]   | no       | Platform constraints (darwin, linux, etc.)|

### OAuthRequirement

| Field              | Type     | Required | Notes                              |
|--------------------|----------|----------|------------------------------------|
| `name`             | string   | yes      | Credential name                    |
| `authorize_url`    | string   | yes      | OAuth authorization endpoint       |
| `token_url`        | string   | yes      | OAuth token exchange endpoint      |
| `scopes`           | string[] | yes      | Required OAuth scopes              |
| `client_id`        | string   | yes      | OAuth client ID                    |
| `client_secret_env`| string   | no       | Env var name for client secret     |

### GeneratedManifest

Auto-generated from ParsedAgentSkill via `manifestGenerator.generateManifest()`:
- Static analysis for host commands, env vars, domains, IPC tools, scripts
- Optional `hashExecutables()` adds SHA-256 to manifest entries

## ClawHub Registry Client

`src/clawhub/registry-client.ts` -- public skill discovery:
- `search(query, limit?)` -- search by keyword
- `fetchSkill(slug)` -- download ZIP, extract SKILL.md only
- `fetchSkillPackage(slug)` -- download ZIP, extract ALL files + parse requiresEnv
- `listPopular(limit?)` -- popular skills sorted by downloads
- `listCached()` -- locally cached skill slugs
- Cache TTL: 1 hour. All paths use `safePath()`.
- **Author/name resolution**: Both `fetchSkill` and `fetchSkillPackage` retry with just the name part if a slug containing `/` gets a 404.
- **ZIP extraction**: `extractAllFromZip()` skips binary extensions (png, jpg, zip, dll, etc.) and directories. Strips common root prefix if all entries share one.

## Static Screener (5 Layers)

| Layer | Type | Patterns |
|-------|------|----------|
| 1. Hard-Reject | BLOCK | dangerous runtime calls (eval, spawn, Function, etc.) |
| 2. Exfiltration | FLAG (0.4) | URLs with data params, webhook.site, requestbin, ngrok |
| 3. Prompt Injection | FLAG (0.3) | HTML comment directives, zero-width chars, role reassignment |
| 4. External Deps | FLAG (0.2) | CDN scripts, external binary URLs, curl-pipe-to-shell |
| 5. Capability Mismatch | FLAG (0.15) | Undeclared fs.write, process.env, crypto, docker commands |

**Scoring**: Any BLOCK or score >= 0.8 -> REJECT; score >= 0.3 -> REVIEW; score < 0.3 -> APPROVE.

## Workspace Release Screening

`src/host/workspace-release-screener.ts` screens workspace changes before GCS commit:
- **Skill files** (`skills/*.md`): parsed and screened via screener provider
- **Binary files** (`bin/*`): size limit enforced (100MB default)
- **Other files** (scripts, config, etc.): passed through without screening

This screening applies to BOTH agent-initiated workspace releases AND skill_install queued changes (both go through `workspace.commit()` -> orchestrator -> `screenCommit`).

## Skill Format Parsing

`skillFormatParser.parseAgentSkill(raw)` converts SKILL.md into `ParsedAgentSkill`:
- Extracts YAML frontmatter, resolves `metadata.openclaw` (aliases: `clawdbot`, `clawdis`)
- Maps OpenClaw permissions to AX IPC actions (`full-disk-access` -> `workspace_write`, `web-access` -> `web_fetch`, etc.)
- Extracts code blocks and install specs

## Agent-Side Skill Loading

Skills are loaded by `buildSystemPrompt()` in `src/agent/agent-setup.ts`:
- Reads from `{agentWorkspace}/skills/` (agent scope, shared) and `{userWorkspace}/skills/` (user scope, per-user)
- User skills shadow agent skills (same name)
- `loadSkillsMultiDir()` walks directories, finds SKILL.md files, returns summaries
- Skills appear in the prompt's "Available Skills (Already Installed)" table
- Skill install intent detection (`detectSkillInstallIntent()`) enables the install instructions section only when the user message mentions installing/adding/finding skills

## Common Tasks

- **Add screening logic**: Implement `SkillScreenerProvider.screen()` or `screenExtended()`.
- **Parse a SKILL.md**: Call `parseAgentSkill(raw)` for `ParsedAgentSkill`.
- **Generate a manifest**: Call `generateManifest(parsed)`, optionally `hashExecutables()`.
- **Search ClawHub**: Call `search(query)` or `listPopular()`.
- **Persist skill files in a new IPC handler**: Write to filesystem (for subprocess) AND call `providers.workspace?.setRemoteChanges()` (for k8s/GCS). Use `pkg.slug` for paths, not the raw user-provided slug.

## Gotchas

- **Dual write required**: Skill install must write to BOTH host filesystem AND GCS workspace provider. Filesystem-only breaks k8s. GCS-only breaks subprocess sandbox.
- **Use `providers.workspace?.setRemoteChanges`**: Optional chaining is required -- `workspace` may be undefined in tests, and `setRemoteChanges` only exists in k8s mode (GCS remote transport).
- **Use resolved `pkg.slug` for paths**: The raw slug from the agent may be `author/name` format. Always update to `pkg.slug` after `fetchSkillPackage()` to avoid nested author directories in filesystem and GCS paths.
- **ClawHub slug != URL path**: `clawhub.ai/ManuelHettich/linear` -> API slug is `linear`, not `ManuelHettich/linear`. The registry client handles this, but callers should use the returned `pkg.slug`.
- **Workspace commit happens at session end**: `setRemoteChanges()` only queues files. They are committed to GCS when `workspace.commit(sessionId)` runs after the agent exits in `processCompletion()`. If the session crashes or times out before commit, files are lost.
- **safePath required**: Security invariant (SC-SEC-004) for all path construction.
- **Permission mapping**: OpenClaw names auto-mapped to AX IPC action names.
- **Hard-reject is non-negotiable**: Enforced regardless of declared permissions.
- **Score clamping**: Extended screening score clamped to [0, 1].
- **Test mocks need no `workspace`**: The mock `ProviderRegistry` in tests omits `workspace`. The optional chaining (`?.`) handles this gracefully.
- **`userSkillsDir()` is deprecated**: The comment says "Skills are now stored in DocumentStore and sent via stdin payload" but the migration is incomplete. The filesystem write is still needed for subprocess mode.
