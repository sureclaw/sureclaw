# Providers: Skills

Skills import pipeline, screener, manifest generator, ClawHub client, architecture comparison.

## [2026-02-27 14:30] — Create exploring-reference-repos skill

**Task:** Create a new skill for exploring other git repositories to get architectural inspiration
**What I did:** Created `~/.claude/skills/exploring-reference-repos/SKILL.md` — a technique skill with an 8-step workflow: define target, find repos, shallow clone to temp dir, orient via README, targeted search, read and trace patterns, summarize insights, clean up. Includes a reference table of well-known projects for common patterns and common mistakes section.
**Files touched:** `~/.claude/skills/exploring-reference-repos/SKILL.md` (created)
**Outcome:** Success — skill loads via Skill tool and appears in the discoverable skills list
**Notes:** Personal skills at `~/.claude/skills/` ARE auto-discovered by Claude Code (initially tried project dir too, removed duplicate)

## [2026-02-26 01:02] — Implement AgentSkills import, screener, manifest generator, and ClawHub client

**Task:** Implement Phase 3 Wave 1 (static screener) and Wave 2 (ClawHub compatibility): parse SKILL.md format, auto-generate MANIFEST.yaml, screen imported skills, wire into IPC
**What I did:** Built complete skills import pipeline across 8 steps: expanded screening types, created 5-layer static screener, registered screener provider, built AgentSkills format parser (handles openclaw/clawdbot/clawdis metadata aliases), built manifest auto-generator with static analysis (detects host commands, env vars, script paths, domains from body text), created ClawHub registry client with caching, wired skill_import and skill_search into IPC schemas/handlers/tool catalog/MCP server, integrated screener with git skill store provider. Verified against real-world skills: gog, nano-banana-pro, mcporter.
**Files touched:** Created: src/providers/screener/static.ts, src/providers/screener/none.ts, src/utils/skill-format-parser.ts, src/utils/manifest-generator.ts, src/clawhub/registry-client.ts + 4 test files. Modified: src/providers/skills/types.ts, src/host/provider-map.ts, src/host/registry.ts, src/providers/skills/git.ts, src/ipc-schemas.ts, src/host/ipc-handlers/skills.ts, src/agent/tool-catalog.ts, src/agent/mcp-server.ts + 5 test files
**Outcome:** Success — 154 test files pass, 1580 tests pass, 0 failures, build clean
**Notes:** nano-banana-pro has NO metadata block — static analysis is critical for these skills. Both gog and mcporter use `metadata.clawdbot` alias.

## [2026-02-25 20:45] — OpenClaw vs AX skills architecture comparison

**Task:** Compare OpenClaw skills architecture to AX's, design how AX can safely allow executable skills
**What I did:** Researched OpenClaw's skills system (SKILL.md, bins/, ClawHub, ClawHavoc attacks), Claude Code's extensibility (skills, hooks, MCP, plugins), and AX's current skills provider (readonly, git, trust tiers, capability narrowing). Wrote comprehensive analysis with three-tier safe execution model: sandboxed execution, host-proxied commands, and install hooks.
**Files touched:** `docs/plans/2026-02-25-compare-skills-architecture.md` (created)
**Outcome:** Success — comprehensive architecture comparison and design proposal
**Notes:** OpenClaw's ClawHub had 824+ malicious skills (12-20% of registry) by Feb 2026. AX's existing sandbox + IPC architecture already prevents most attack vectors. The key design insight: skill binaries run inside the sandbox (not on host), and untrusted skills can never execute binaries — only approved skills can.
