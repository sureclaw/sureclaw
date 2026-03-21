---
name: ax-provider-skills
description: Use when modifying skill types, AgentSkills format parsing, manifest generation, or the skill installer in src/providers/skills/ and src/agent/skill-installer.ts
---

## Overview

The skills provider directory now contains only type definitions (`types.ts`). The `SkillStoreProvider` interface, `database.ts`, `readonly.ts`, and `git.ts` implementations have been removed. Skills are now managed through the host's DocumentStore + IPC handlers (`src/host/ipc-handlers/skills.ts`). Skill screening is handled by the screener provider (`src/providers/screener/`).

This skill covers: `ParsedAgentSkill` format types, skill installer, ClawHub registry client, and manifest generation.

## Core Types (`src/providers/skills/types.ts`)

Types-only module — re-exports screener types from `src/providers/screener/types.ts` for backward compatibility.

### ParsedAgentSkill

Parsed representation of a SKILL.md file:
- `name`, `description?`, `version?`, `license?`, `homepage?`
- `requires` -- `bins` (required host binaries), `env` (required env vars), `oauth` (`OAuthRequirement[]`), `anyBins` (alternative binary options), `config` (config keys)
- `install` -- `SkillInstallStep[]` (raw `run` shell commands, not structured kind/package taxonomy)
- `os?` -- platform constraints
- `permissions` -- mapped from OpenClaw terms to AX IPC actions
- `triggers?` -- event triggers
- `tags?` -- categorization tags
- `body` -- markdown body text
- `codeBlocks` -- extracted code blocks

### SkillInstallStep (NEW)

| Field   | Type       | Required | Notes                                    |
|---------|------------|----------|------------------------------------------|
| `run`   | string     | yes      | Shell command to execute                 |
| `label` | string     | no       | Human-readable description               |
| `bin`   | string     | no       | Binary that should exist after install   |
| `os`    | string[]   | no       | Platform constraints (darwin, linux, etc.)|

### OAuthRequirement (NEW)

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

## Static Screener (5 Layers)

| Layer | Type | Patterns |
|-------|------|----------|
| 1. Hard-Reject | BLOCK | exec(), spawn(), eval(), Function(), atob(), fetch() |
| 2. Exfiltration | FLAG (0.4) | URLs with data params, webhook.site, requestbin, ngrok |
| 3. Prompt Injection | FLAG (0.3) | HTML comment directives, zero-width chars, role reassignment |
| 4. External Deps | FLAG (0.2) | CDN scripts, external binary URLs, curl-pipe-to-shell |
| 5. Capability Mismatch | FLAG (0.15) | Undeclared fs.write, process.env, crypto, docker commands |

**Scoring**: Any BLOCK or score >= 0.8 -> REJECT; score >= 0.3 -> REVIEW; score < 0.3 -> APPROVE.

## Skill Format Parsing

`skillFormatParser.parseAgentSkill(raw)` converts SKILL.md into `ParsedAgentSkill`:
- Extracts YAML frontmatter, resolves `metadata.openclaw` (aliases: `clawdbot`, `clawdis`)
- Maps OpenClaw permissions to AX IPC actions (`full-disk-access` -> `workspace_write`, `web-access` -> `web_fetch`, etc.)
- Extracts code blocks and install specs

## ClawHub Registry Client

`src/clawhub/registry-client.ts` -- public skill discovery:
- `search(query)`, `fetchSkill(name)`, `listPopular()`, `listCached()`
- Cache TTL: 1 hour. All paths use `safePath()`.

## Directory Structure

Skills stored at `~/.ax/agents/<agentId>/agent/workspace/skills/`. Git store maintains commit history for revert and audit.

## Common Tasks

- **Add a writable provider**: Implement all `SkillStoreProvider` methods. Use `safePath()`.
- **Add screening logic**: Implement `SkillScreenerProvider.screen()` or `screenExtended()`.
- **Parse a SKILL.md**: Call `parseAgentSkill(raw)` for `ParsedAgentSkill`.
- **Generate a manifest**: Call `generateManifest(parsed)`, optionally `hashExecutables()`.
- **Search ClawHub**: Call `search(query)` or `listPopular()`.

## Gotchas

- **Readonly throws on writes**: Callers must handle.
- **safePath required**: Security invariant (SC-SEC-004) for all path construction.
- **Default directory**: Uses `agentSkillsDir(agentId)` from `src/paths.ts`.
- **Permission mapping**: OpenClaw names auto-mapped to AX IPC action names.
- **Hard-reject is non-negotiable**: Enforced regardless of declared permissions.
- **Score clamping**: Extended screening score clamped to [0, 1].
