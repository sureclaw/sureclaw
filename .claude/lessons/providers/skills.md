# Provider Lessons: Skills

### Validate skillName with a positive-match allowlist, not a denylist
**Date:** 2026-04-18
**Context:** Code review on `tool-module-sync.ts` flagged `assertSkillNameSafe` for using a denylist of `/`, `\`, `..`, `\0`, `''`. The frontmatter schema allows any Unicode, so `\r`, `\n`, spaces, and leading dashes would pass — landing in both a repo-relative path AND a git commit message.
**Lesson:** Any skill-name (or user-supplied identifier) that reaches a filesystem path, git commit message, or git ref MUST be validated with a positive-match regex, not a denylist. For AX skill names the accepted pattern is `/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/` plus an explicit `..` check (the dot in the char class would otherwise allow `foo..bar` path-traversal). Denylists always miss something — newlines and leading dashes are typical blind spots.
**Tags:** skills, validation, security, path-traversal, commit-message, allowlist

### MCP `authForServer` at tool discovery must read `skill_credentials`, not the unscoped credential store
**Date:** 2026-04-18
**Context:** Live bug — after approving a skill with a Linear MCP server, zero tool modules got generated because `authForServer` looked up `LINEAR_API_KEY` via `providers.credentials.get` (unscoped, falls back to `process.env`) and returned null. New skill creds only land in `skill_credentials` (tuple-keyed).
**Lesson:** Every host-side code path that needs to authenticate a skill-declared MCP server MUST read from `deps.skillCredStore.listForAgent(agentId)`, applying the same user-scope precedence as turn-time credential injection (user-scoped row > agent-scope sentinel `''`). A `process.env` last-resort fallback is OK for dev/infra creds but is expressly NOT the primary path. When adding any new MCP-auth code, grep for `authForServer` — server-completions, server-init, and inprocess all have copies and they can drift.
**Tags:** skills, mcp, credentials, authForServer, skill_credentials, tuple-keyed

### Shared service adapters scale better than per-skill credential routes
**Date:** 2026-03-19
**Context:** Explaining how AX should generalize the `/internal/linear-proxy` idea as more credentialed skills are installed.
**Lesson:** Do not model host-mediated auth as one bespoke internal route per skill. Skills are recipes and prompts; many of them will target the same upstream system. The scalable unit is a shared host-side service adapter/provider (for example `linear`, `github`, `slack`) that owns auth injection, request policy, and auditing. Skills should reference that service capability instead of declaring only raw env var names whenever host mediation is required.
**Tags:** skills, architecture, proxy, credentials, providers, scaling

### Env-auth CLIs cannot stay sandbox-safe without a proxy or helper
**Date:** 2026-03-19
**Context:** Reviewing how the published Linear skill (`LINEAR_API_KEY` env var plus a local Node CLI) could run in AX's k8s sandbox without violating the "no credentials in containers" invariant.
**Lesson:** If a CLI must read a raw API key from its own process environment, there is no Kubernetes-only trick that keeps the sandbox credential-free. Env vars, Secret volumes, init containers, and stdin payloads all place the secret inside the untrusted process boundary. In AX, the safe options are: adapt the CLI to call a host-side credential-injecting proxy using a short-lived per-turn token, or run the credentialed CLI in a trusted helper/sidecar/plugin process and expose only a narrow RPC to the sandbox.
**Tags:** skills, credentials, k8s, sandbox, proxy, sidecar, linear

### ClawHub API is at clawhub.ai, not registry.clawhub.dev; skills are ZIP files
**Date:** 2026-03-18
**Context:** Debugging skills.search network errors — registry-client.ts pointed at nonexistent domain
**Lesson:** The real ClawHub API base URL is `https://clawhub.ai/api/v1` (discoverable via `GET /.well-known/clawhub.json`). The old `registry.clawhub.dev` domain is NXDOMAIN. Key endpoints: `/search?q=` returns `{ results: [{slug, displayName, summary, version, score}] }`, `/download?slug=` returns a ZIP binary, `/skills?sort=downloads` returns paginated `{items, nextCursor}` (currently empty from the API). Skills are distributed as ZIP files containing `SKILL.md` — fetchSkill must download and extract, not call a JSON detail endpoint.
**Tags:** clawhub, skills, registry, api, zip

### Floating promises in Promise.all tests pollute subsequent mocks
**Date:** 2026-03-18
**Context:** Testing fetchSkill which runs fetchBinary and search concurrently; "throws on download error" test left search running after fetchBinary threw
**Lesson:** When `Promise.all([A, B])` rejects because A throws, B keeps running in the background. If B calls `fetch`, it consumes a mock registered for the NEXT test. Fix: register a mock for B's fetch call in the throwing test AND `await new Promise(resolve => setTimeout(resolve, 10))` to let the background promise settle before the test exits.
**Tags:** testing, async, promise-all, mock-pollution, vitest

### Popular OpenClaw skills use clawdbot alias, not openclaw
**Date:** 2026-02-26
**Context:** Implementing AgentSkills SKILL.md parser for gog, nano-banana-pro, and mcporter
**Lesson:** Real-world SKILL.md files use `metadata.clawdbot` (not `metadata.openclaw`) for their requirements blocks. Always check all three aliases (openclaw, clawdbot, clawdis) when resolving metadata. The parser must handle all of them or it will miss requirements from the most popular skills.
**Tags:** skills, parser, openclaw, clawdbot, compatibility

### Many skills have no metadata block — static analysis is essential
**Date:** 2026-02-26
**Context:** Parsing nano-banana-pro SKILL.md which only has name+description in frontmatter
**Lesson:** A significant fraction of real-world skills declare ZERO requirements in their YAML frontmatter. Their dependencies (binaries like `uv`, env vars like `GEMINI_API_KEY`, scripts like `scripts/generate_image.py`) are only mentioned in the markdown body or code blocks. The manifest generator's static analysis (regex scanning of body text and code blocks) is not optional — without it, these skills get empty manifests and are useless.
**Tags:** skills, manifest-generator, static-analysis, nano-banana-pro

### OpenClaw's security failures validate AX's zero-trust architecture
**Date:** 2026-02-25
**Context:** Researching OpenClaw's ClawHavoc supply chain attack for skills architecture comparison
**Lesson:** The ClawHavoc attack (824+ malicious skills on ClawHub) succeeded because: 1) no sandbox (skills run on host with full privileges), 2) no screening at upload time, 3) skills can bundle binaries added to PATH with no integrity verification, 4) no capability narrowing. AX's existing sandbox + IPC proxy + capabilities.yaml already prevents all of these attack vectors. When designing executable skills for AX, the sandbox is the runtime — binaries run inside it, not on the host. Untrusted skills must never be allowed to execute.
**Tags:** skills, security, openclaw, sandbox, supply-chain, architecture

### Skill `install` and `requires` must be inside metadata.openclaw block
**Date:** 2026-03-05
**Context:** Creating test skills for k8s acceptance tests — skill_install returned empty steps/binChecks
**Lesson:** The `parseAgentSkill()` function in `skill-format-parser.ts` reads `install` and `requires` from `resolveMetadata(fm)`, which looks for `fm.metadata.openclaw` (or `clawdbot`/`clawdis`). Placing `install:` or `requires:` at the top level of YAML frontmatter will be IGNORED — they must be nested under `metadata.openclaw:`. If skill_install returns empty steps, check the skill format first.
**Tags:** skills, parser, metadata, install, frontmatter, acceptance-test

### GCS downloadScope requires user IDs, not agent name — enumerate with listScopeIds
**Date:** 2026-03-22
**Context:** Startup domain scan called `downloadScope('user', agentName)` with `agentName='main'`, which queried GCS prefix `test/user/main/` — but skills are stored under user IDs like `test/user/chat-ui/`. No skills found, no domains added, proxy blocked api.linear.app.
**Lesson:** The `downloadScope(scope, id)` method takes the actual scope ID (user ID for 'user' scope, agent name for 'agent' scope). When scanning all user skills at startup, you must enumerate user IDs first via `listScopeIds('user')` then iterate each. Don't assume `agentName` works as the ID for user-scoped GCS data. The local filesystem scan already iterates `users/*/skills/` — the GCS scan must do the equivalent.
**Tags:** skills, workspace, gcs, k8s, proxy, domain-allowlist, startup

### Skill install writes to host filesystem only — must also queue for GCS in k8s
**Date:** 2026-03-22
**Context:** Debugging why installed skills didn't persist across sessions in k8s. The `skill_install` IPC handler wrote files to `~/.ax/agents/<id>/users/<userId>/skills/` on the host filesystem, but sandbox pods (separate containers) can't access that. Workspace provisions from GCS returned 0 files.
**Lesson:** In k8s mode, any IPC handler that writes files intended for the agent must ALSO commit them to the workspace provider via `providers.workspace?.setRemoteChanges(sessionId, changes)`. The filesystem write only works for subprocess sandbox (shared filesystem). For k8s, files must flow through: `setRemoteChanges()` → `workspace.commit()` (at session end) → GCS upload → `workspace.downloadScope()` (next session provision). Use optional chaining (`?.`) since `workspace` may be undefined in tests and `setRemoteChanges` is only defined in k8s mode.
**Tags:** skills, workspace, gcs, k8s, persistence, ipc-handler

### Kind cluster `ax` vs `ax-dev` — volume mount dev loop requires k8s-dev setup
**Date:** 2026-03-22
**Context:** Debugging the skill persistence fix against a manually-created `ax` cluster that lacked dist/ volume mounts. The `k8s:dev cycle` command had no effect on host code.
**Lesson:** The `npm run k8s:dev setup` command creates a cluster named `ax-dev` with kind extraMounts that share `dist/`, `templates/`, and `skills/` from the host into kind nodes. Manually-created clusters won't have these mounts — the host pod uses the Docker image's baked-in `dist/`. If `k8s:dev cycle` doesn't pick up code changes, verify the cluster was created with `k8s:dev setup` and check for hostPath volume mounts on the host pod.
**Tags:** k8s, kind, dev-loop, volume-mounts, debugging

### ClawHub URL in query triggers search, returns wrong skill — always extract slug from URL
**Date:** 2026-03-22
**Context:** When user provided `https://clawhub.ai/ManuelHettich/linear`, the LLM passed it as `query` which searched ClawHub and returned an unrelated skill ("virtually-us") as top result
**Lesson:** The `skill_install` handler must parse ClawHub URLs from both `slug` and `query` fields before searching. Use regex `clawhub\.ai\/([^?#\s]+)` to extract the author/name path. The prompt must also instruct the LLM to pass ClawHub URLs as `slug`, not `query`, since search is unreliable for URL-based installs.
**Tags:** skills, clawhub, url-parsing, slug-resolution, prompt

### Skill domains must be declared in frontmatter — body URL scanning is insufficient
**Date:** 2026-03-22
**Context:** The Linear skill installed correctly but couldn't reach `api.linear.app` because the SKILL.md body didn't mention the URL, so `generateManifest()` extracted zero domains
**Lesson:** The manifest generator's URL regex (`https?://...`) only catches domains explicitly written as URLs in body text. Many skills use API domains that aren't mentioned as URLs in docs. Add `requires.domains` to the SKILL.md frontmatter format and merge with auto-detected domains in `generateManifest()`. Skill authors should declare ALL required API domains in `requires.domains`.
**Tags:** skills, proxy, domains, allowlist, manifest-generator, SKILL.md

### Tool filtering must align with prompt module shouldInclude()
**Date:** 2026-02-26 (updated 2026-04-13)
**Context:** Added context-aware tool filtering — scheduler tools were initially excluded when no heartbeat, but this was wrong. HEARTBEAT.md controls heartbeat content, not whether the agent can schedule tasks. Scheduler tools are now always available.
**Lesson:** When adding tool filtering by category, don't gate tool availability on content configuration — the ability to use a feature (scheduling) should not depend on having configured a specific feature detail (heartbeat content). Only gate on true capability flags like `hasGovernance`.
**Tags:** tools, filtering, prompt-modules, testing, heartbeat
