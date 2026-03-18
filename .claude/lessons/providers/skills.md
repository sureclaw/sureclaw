# Provider Lessons: Skills

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

### Tool filtering must align with prompt module shouldInclude()
**Date:** 2026-02-26
**Context:** Added context-aware tool filtering — scheduler tools excluded when no heartbeat. Pi-session test broke because it expected scheduler tools without providing a HEARTBEAT.md file.
**Lesson:** When adding tool filtering by category, ensure the filter flags derive from the same data that prompt modules use in `shouldInclude()`. If HeartbeatModule checks `identityFiles.heartbeat?.trim()`, the scheduler filter must check the same thing. Test fixtures must provide the relevant identity files (e.g., HEARTBEAT.md in agentDir) when expecting those tools to be present.
**Tags:** tools, filtering, prompt-modules, testing, heartbeat
