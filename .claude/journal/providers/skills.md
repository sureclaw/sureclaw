# Providers: Skills

Skills import pipeline, screener, manifest generator, ClawHub client, architecture comparison, install orchestration.

## [2026-03-22 09:45] — Fix skill install persistence in k8s (GCS workspace)

**Task:** Debug why installed skills don't persist across sessions in k8s mode — agent re-installs on every turn
**What I did:** Traced the full skill install → workspace provision lifecycle. Found that `skill_install` IPC handler writes files to host filesystem (`~/.ax/agents/<id>/users/<userId>/skills/`) but never commits them to the GCS workspace provider. In k8s, sandbox pods can't access the host filesystem, so workspace provisions returned `fileCount:0`. Fixed by calling `providers.workspace?.setRemoteChanges()` in the skill_install handler to queue files for GCS commit. Added optional chaining to handle test mocks where workspace is undefined.
**Files touched:** `src/host/ipc-handlers/skills.ts`
**Outcome:** Success — skill files now persist to GCS and are provisioned to subsequent sandbox pods. Verified end-to-end on kind cluster: turn 1 installs skill (9 files queued for GCS), turn 2 provisions 9 files from GCS, agent recognizes skill as already installed.
**Notes:** The `userSkillsDir()` function is marked @deprecated ("skills are now stored in DocumentStore and sent via stdin payload") but the migration was never completed. The filesystem write is still needed for subprocess sandbox mode. The `setRemoteChanges` method is only available on the GCS provider in k8s mode, so the optional chaining handles both cases correctly.

## [2026-03-22 10:00] — Fix ClawHub author/name slug resolution

**Task:** ClawHub URLs use `author/name` format (e.g. `ManuelHettich/linear`) but the API download endpoint only accepts the skill name (`linear`). This caused 404 errors and fallback to search which picked the wrong skill.
**What I did:** Added retry logic in `fetchSkillPackage()` and `fetchSkill()` in `registry-client.ts` — if a slug with `/` gets a 404, retry with just the name part after `/`. Also updated `skill_install` handler to use `pkg.slug` (the resolved slug) instead of the original input for filesystem and GCS paths.
**Files touched:** `src/clawhub/registry-client.ts`, `src/host/ipc-handlers/skills.ts`
**Outcome:** Success — `ManuelHettich/linear` now resolves to `linear` (3 files, no npm deps) instead of 404ing and falling back to wrong skill. GCS paths use the clean slug without author prefix.
**Notes:** The old behavior caused the LLM agent to try the exact slug, get 404, then search for "linear" which returned `linear-skill` (9 files with graphql npm deps) as the first result.

## [2026-03-19 05:11] — Explain scalable service-proxy model for skill auth

**Task:** Clarify whether an explicit `/internal/linear-proxy`-style route scales as more users install credentialed skill binaries
**What I did:** Reviewed the host proxy/plugin patterns and the current skill schema (`requires.env`) to separate the one-off Linear example from the more scalable service-capability model AX should use.
**Files touched:** `.claude/journal/providers/skills.md`, `.claude/journal/providers/index.md`, `.claude/lessons/providers/skills.md`, `.claude/lessons/providers/index.md`
**Outcome:** Success — concluded that per-skill bespoke routes do not scale, but shared host-side service adapters referenced by skills do
**Notes:** Skills should converge on declaring service dependencies rather than raw env var names when they need host-mediated auth

## [2026-03-19 04:58] — Analyze sandbox-safe auth for env-based skill CLIs

**Task:** Figure out how skills like Linear can use API-key-based CLIs in k8s without putting credentials in the sandbox
**What I did:** Reviewed AX's sandbox/security guidance, the k8s pod env injection path, host per-turn token routes, plugin credential injection, and the published Linear skill requirements to map safe runtime options.
**Files touched:** `.claude/journal/providers/skills.md`, `.claude/journal/providers/index.md`, `.claude/lessons/providers/skills.md`, `.claude/lessons/providers/index.md`
**Outcome:** Success — documented that raw env-var auth cannot stay outside the untrusted sandbox boundary; AX needs a host-side proxy or a trusted helper boundary for this class of skill
**Notes:** `extraEnv`, Secret mounts, and stdin payloads are acceptable for scoped turn tokens, but not for long-lived upstream API keys that the sandboxed process can read directly

## [2026-03-18 10:25] — Fix ClawHub registry client to use real API

**Task:** Debug network errors when agents use skills.search — registry client pointed at nonexistent domain
**What I did:**
- Diagnosed root cause: `CLAWHUB_API` pointed to `registry.clawhub.dev` (NXDOMAIN — never registered)
- Discovered real API via `/.well-known/clawhub.json` and clawhub npm CLI source: base is `https://clawhub.ai/api/v1`
- Rewrote `src/clawhub/registry-client.ts`: new base URL, updated response shapes (`results[]` not `skills[]`, `slug`/`displayName`/`summary` fields), ZIP download + SKILL.md extraction for `fetchSkill` using Node.js `zlib` and manual ZIP Central Directory parsing
- Updated `tests/clawhub/registry-client.test.ts`: new test for `extractFileFromZip`, `buildStoredZip` helper, fixed floating-promise mock pollution, added `AX_HOME` isolation
**Files touched:** `src/clawhub/registry-client.ts`, `tests/clawhub/registry-client.test.ts`
**Outcome:** All 10 tests pass; full suite unaffected (pre-existing sync failure unrelated)
**Notes:** fetchSkill now downloads real ZIP files and extracts SKILL.md; listPopular uses `/api/v1/skills?sort=downloads` which currently returns empty items from the API (not a client bug)

## [2026-03-03 20:40] — Implement skills install architecture

**Task:** Implement the full skills install architecture from docs/plans/2026-03-03-skills-install-architecture.md — two-phase inspect/execute flow, command validation, env scrubbing, concurrency control, TOCTOU defense, state persistence, prompt/tool integration
**What I did:**
- Created `src/utils/bin-exists.ts` — cross-platform safe binary lookup using `command -v` via validated shell
- Created `src/utils/install-validator.ts` — command prefix allowlisting, env scrubbing, concurrency semaphore
- Updated `src/providers/skills/types.ts` — new `SkillInstallStep`, `SkillInstallState`, `SkillInstallInspectResponse` types; deprecated old `AgentSkillInstaller`
- Updated `src/utils/skill-format-parser.ts` — backward-compat conversion from old kind/package/formula format to new `run`/`bin` format
- Updated `src/utils/manifest-generator.ts` — install steps now use `run`/`bin`/`label`/`os` instead of `kind`/`package`
- Added `SkillInstallSchema` and `SkillInstallStatusSchema` to `src/ipc-schemas.ts`
- Added `skill_install` (two-phase inspect/execute) and `skill_install_status` handlers to `src/host/ipc-handlers/skills.ts`
- Added `install` and `install_status` operations to tool catalog and MCP server
- Added `skill_install` to taint budget sensitive actions
- Enriched `skill_read` and `skill_list` responses with missing-bin warnings
- Updated skills prompt module to surface warnings and install guidance
- Created comprehensive test suite: `bin-exists.test.ts`, `install-validator.test.ts`, `skills-install.test.ts`
- Updated existing tests: `skill-format-parser.test.ts`, `manifest-generator.test.ts`, `tool-catalog.test.ts`
**Files touched:** src/providers/skills/types.ts, src/utils/bin-exists.ts (new), src/utils/install-validator.ts (new), src/utils/skill-format-parser.ts, src/utils/manifest-generator.ts, src/ipc-schemas.ts, src/host/ipc-handlers/skills.ts, src/host/taint-budget.ts, src/agent/tool-catalog.ts, src/agent/mcp-server.ts, src/agent/prompt/modules/skills.ts, src/agent/prompt/types.ts, tests/utils/bin-exists.test.ts (new), tests/utils/install-validator.test.ts (new), tests/host/ipc-handlers/skills-install.test.ts (new), tests/utils/skill-format-parser.test.ts, tests/utils/manifest-generator.test.ts, tests/agent/tool-catalog.test.ts
**Outcome:** Success — 208 test files pass (2288 tests), clean TypeScript compilation
**Notes:** Key security properties: command prefix allowlisting blocks arbitrary execution, inspectToken (SHA-256 of steps) defends against TOCTOU, env scrubbing strips credentials, per-agent concurrency semaphore prevents resource exhaustion. Backward compat: old kind/package SKILL.md format auto-converts to new run/bin format.

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
