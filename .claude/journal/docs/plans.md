# Docs: Plans

Architecture analysis, gap analysis, design documents, implementation plans.

## [2026-04-16 14:00] — Design git-native skills and credentials UX

**Task:** Brainstorm the best UX for installing tools/skills and managing credentials given AX's git-based workspace model
**What I did:** Led a brainstorming session through six sections — overall model, frontmatter schema, reconciliation flow, credentials dashboard + OAuth, agent role & progressive disclosure, pending state & security. Key decisions: skills live as files in `.ax/skills/<name>/SKILL.md` in the agent's repo (no install CLI, no DocumentStore); agent authors skills directly via its file-edit tools; YAML frontmatter declares credentials, MCP servers, and domains; post-receive hook drives host-side reconciliation; dashboard shows a single setup card per skill bundling domain approvals + credential collection (OAuth PKCE default, admin-registered app fallback, API key last resort); skill enabled state is derived from gate status (proxy allowlist + credential storage + MCP registration) with "pending" as a soft label on top of hard enforcement; agent sees a progressive-disclosure index (name + description only) and reads full SKILL.md on demand.
**Files touched:** `docs/plans/2026-04-16-git-native-skills-design.md`, `.claude/journal/docs/plans.md`, `.claude/journal/docs/index.md`
**Outcome:** Success — design doc captured with frontmatter schema, reconcile flow, UX mockup for setup card, migration recommendation (fresh start for early-stage AX), and open questions for follow-up.
**Notes:** `request_credential` tool + `credential.required` event bus flow can be reused as-is — dashboard just becomes another subscriber alongside the chat UI. Domain approvals need user-in-the-loop (agent can silently expand its own network reach otherwise). Defense-in-depth matters: pending-state enforcement lives at the proxy/placeholder/MCP-registry gates, not at the agent.

## [2026-03-22 12:00] — Update ax-debug skill with agent_response timer and scanner timeout learnings

**Task:** Add debugging learnings from kind-ax cluster session to ax-debug skill
**What I did:** Added two new rows to the Common Issues table (agent_response timeout firing before sandbox spawn due to pre-processing eating into the timer; scanner LLM classification hanging due to no timeout on classifyWithLLM). Added a note to the "Agent never responds (timeout)" section explaining the deferred timer via startAgentResponseTimer callback and how to diagnose old-code behavior.
**Files touched:** .claude/skills/ax-debug/SKILL.md
**Outcome:** Success — three targeted edits, no full rewrite.
**Notes:** These document the fix where agentResponsePromise timer was moved to after work publish, and guardian scanner got a 15s Promise.race timeout.

## [2026-03-21 14:00] — Add Tier 0 Chat UI Dev Loop to ax-debug skill

**Task:** Create a tight dev loop for chat UI iteration with Playwright MCP visual verification
**What I did:** Created `scripts/chat-dev.sh` (start/stop/status for Vite + ax server), `ui/chat/ax-dev.yaml` (minimal mock config), updated `ui/chat/vite.config.ts` to support `VITE_AX_PORT` env var, added `dev:chat` npm script, updated ax-debug skill with full Tier 0 documentation covering Playwright MCP workflows, file maps, and architecture.
**Files touched:** `scripts/chat-dev.sh`, `ui/chat/ax-dev.yaml`, `ui/chat/vite.config.ts`, `package.json`, `.gitignore`, `.claude/skills/ax-debug/SKILL.md`, `docs/plans/2026-03-21-chat-ui-dev-loop.md`
**Outcome:** Success — smoke test verified AX health, Vite serving, and API proxy all working
**Notes:** Memory/scanner/audit providers don't have `none` variants, so dev config uses real providers (cortex, patterns, database). The `--port` flag sets `VITE_AX_PORT` env var so Vite proxy target stays in sync.

## [2026-03-19 05:46] — Plan authenticated MITM HTTPS proxy for long-tail CLI tools

**Task:** Create an implementation plan for HTTPS proxying that keeps credentials out of sandboxes while supporting the long tail of CLI tools
**What I did:** Reviewed the existing forward-proxy, credential-injecting proxy, plugin framework, and recent proxy/security lessons. Wrote a phased plan for an authenticated host proxy with session-aware tunnel mode, explicit MITM service bindings, local sandbox bridges, CA distribution, rollout stages, and test strategy.
**Files touched:** `docs/plans/2026-03-19-authenticated-mitm-https-proxy-plan.md`, `.claude/journal/docs/plans.md`, `.claude/journal/docs/index.md`, `.claude/lessons/architecture/entries.md`, `.claude/lessons/architecture/index.md`, `.claude/lessons/index.md`
**Outcome:** Success — plan captured with concrete phases, file touch points, security invariants, and rollout guidance
**Notes:** The key recommendation is "authenticated tunnel by default, MITM only for explicit service bindings" rather than a transparent global MITM proxy

## [2026-03-17 11:02] — Outline safe unified lifecycle for container sandboxes

**Task:** Describe a safe unified workspace lifecycle that could cover k8s, Docker, and Apple without weakening Docker/Apple network isolation.
**What I did:** Reviewed the current web proxy bridge, HTTP IPC client, workspace release path, and Docker/Apple network flags. Synthesized a provider-aware design where all sandboxes share one logical lifecycle but not one identical transport surface.
**Files touched:** .claude/journal/docs/plans.md, .claude/journal/docs/index.md, .claude/journal/index.md
**Outcome:** Success — identified a safe model: shared pre-run/post-run hooks, network brokered through proxy/host endpoints, and provider capabilities that keep Docker/Apple on `--network=none` during the main run.
**Notes:** Key distinction: unify lifecycle orchestration, not raw network access.

## [2026-03-17 10:59] — Explain multi-sandbox redesign scope for phase removal

**Task:** Explain what a broader multi-sandbox redesign would require if AX wants to remove host-driven three-phase orchestration for Docker and Apple too, not just k8s.
**What I did:** Reviewed the current Docker/Apple providers' `config.network` handling, the shared sandbox contract, and the host completion path to outline the real architectural work needed for a global lifecycle change.
**Files touched:** .claude/journal/docs/plans.md, .claude/journal/docs/index.md, .claude/journal/index.md
**Outcome:** Success — clarified that global phase removal requires a new provider-scoped workspace lifecycle contract, not just moving k8s provisioning into the runner.
**Notes:** Smallest safe change is still k8s-only; a true multi-sandbox redesign should centralize lifecycle selection by provider capability.

## [2026-03-17 10:53] — Review NATS-centric workspace provisioning plan

**Task:** Evaluate `docs/plans/2026-03-17-nats-centric-workspace-provisioning.md` against the current k8s host/runner/workspace implementation and identify concrete blockers before implementation.
**What I did:** Read the plan, the current host/runner/workspace files (`server-completions.ts`, `host-process.ts`, `runner.ts`, `workspace.ts`, `workspace-cli.ts`, `k8s.ts`), and the relevant AX skills/lessons. Cross-checked the proposed queue-group provisioning flow, cleanup wiring, cache-key handling, and container-phase removal against the live code paths.
**Files touched:** .claude/journal/docs/plans.md, .claude/journal/docs/index.md, .claude/journal/index.md, .claude/lessons/infrastructure/entries.md, .claude/lessons/infrastructure/index.md, .claude/lessons/index.md
**Outcome:** Success — found several blockers: the host still publishes cold-start work to `agent.work.{podName}` while the runner waits on `sandbox.work`, the plan removes Docker/Apple three-phase behavior globally, and the cleanup/cache-key path is internally inconsistent.
**Notes:** The overall direction still looks right for k8s, but the plan needs a k8s-only migration path and a host dispatch fix before implementation.

## [2026-03-17 10:48] — Compare original workspace plan to current k8s implementation

**Task:** Evaluate `docs/plans/2026-03-14-sandbox-workspace-permissions.md` against the current sandbox/workspace implementation and recommend the better architecture direction.
**What I did:** Read the original March 14 plan, the current k8s transport/workspace code (`server-completions.ts`, `host-process.ts`, `runner.ts`, `workspace-cli.ts`, `workspace.ts`, `k8s.ts`), related AX skills, and the follow-up March 17 design notes. Compared the original NATS-centric claim/release flow with the implemented hybrid of NATS queue-group work dispatch plus HTTP IPC/workspace release.
**Files touched:** .claude/journal/docs/plans.md, .claude/journal/docs/index.md, .claude/journal/index.md, .claude/lessons/architecture/entries.md, .claude/lessons/architecture/index.md, .claude/lessons/index.md
**Outcome:** Success — concluded the best direction is the newer hybrid split (NATS for work claiming, HTTP for IPC/file transfer) with k8s-specific in-pod provisioning/cleanup, not the host-driven three-phase pod orchestration.
**Notes:** Main gap: `server-completions.ts` still runs provision/run/cleanup as separate sandbox spawns, but k8s pods use pod-local `emptyDir` volumes, so that choreography cannot preserve workspace state across phases.

## [2026-03-16 12:00] — Update architecture plans with k8s NATS IPC supersession notes

**Task:** Add supersession notes to two architecture docs pointing to the new k8s NATS IPC sandbox plan.
**What I did:** Added an "Updated 2026-03-16" blockquote to k8s-agent-compute-architecture.md and a "K8s update 2026-03-16" blockquote to agent-in-container-design.md, both referencing docs/plans/2026-03-16-k8s-nats-ipc-sandbox.md.
**Files touched:** docs/plans/2026-03-04-k8s-agent-compute-architecture.md, docs/plans/2026-03-15-agent-in-container-design.md
**Outcome:** Success — both docs now have clear pointers to the new plan.
**Notes:** Minimal changes — only added supersession notes, no other content modified.

## [2026-03-16 10:32] — Review host merge + NATS auth plan

**Task:** Review `~/.claude/plans/inherited-cuddling-flask.md` for architecture and security gotchas against the current AX k8s implementation.
**What I did:** Cross-checked the plan against `host-process`, `agent-runtime-process`, NATS IPC/LLM/eventbus clients, the k8s sandbox provider, pool-controller, Helm RBAC/templates, and prior infrastructure lessons.
**Files touched:** .claude/journal/docs/plans.md, .claude/journal/docs/index.md, .claude/lessons/infrastructure/entries.md, .claude/lessons/infrastructure/index.md
**Outcome:** Success — identified concrete risks around shared sandbox NATS credentials, incomplete auth rollout, IPC JetStream reply hazards, and the missing warm-pool/claim migration work.
**Notes:** Review only; no product code changed.

## [2026-03-15 14:26] — Review local sandbox execution architecture plan

**Task:** Review `docs/plans/2026-03-15-local-sandbox-execution.md` and provide actionable feedback.
**What I did:** Read the full plan and appended a structured review section covering strengths, concrete risk gaps (execution hardening, network isolation, k8s cleanup, migration sequencing, observability), and recommended additions (rollout/backout, compatibility matrix, failure modes, security checklist, DoD).
**Files touched:** docs/plans/2026-03-15-local-sandbox-execution.md, .claude/journal/docs/plans.md, .claude/journal/docs/index.md
**Outcome:** Success — feedback is now embedded directly in the plan document for implementation teams.
**Notes:** Emphasized turning security/runtime claims into testable acceptance criteria to reduce migration risk.

## [2026-03-11 13:00] — Keep agent/user workspaces as filesystem mounts in storage plan

**Task:** Fix plan that incorrectly proposed moving agent/user workspace artifacts to DB
**What I did:** Updated Phase 1, Phase 4, SandboxConfig, elimination/preservation tables. Agent/user workspaces stay as filesystem mounts (ro in sandbox, writes via IPC) because they hold large binary artifacts (images up to 10MB, files up to 20MB). Added future consideration note about migrating backing store to GCS/S3 for K8s. Mount count changed from "2 after" to "4 after".
**Files touched:** docs/plans/simplify-storage-architecture.md
**Outcome:** Success — plan now correctly scopes DB migration to identity + skills only
**Notes:** Only identity (small markdown) and skills (small markdown) move to DB. Workspace artifacts stay on filesystem with a future path to object storage.

## [2026-03-11 12:30] — Add subdirectory support to skills key scheme in storage plan

**Task:** Update simplify-storage-architecture.md to explicitly support subdirectories in skill keys
**What I did:** Updated skills key scheme to use path-like keys (e.g. `main/ops/deploy-checklist`), added `path` field to stdin payload, documented subdirectory listing queries, updated migration to recursively scan skill directories, updated merge logic to shadow by relative path
**Files touched:** docs/plans/simplify-storage-architecture.md
**Outcome:** Success — plan now documents subdirectory support as a first-class feature of DB-backed skills
**Notes:** DB schema already supports this (key is opaque TEXT). The current filesystem code (`loadSkills`, `safePath`) would need changes but the plan is about the target architecture.

## [2026-03-11 12:00] — Clarify storage simplification plan for K8s and DB backends

**Task:** Update simplify-storage-architecture.md to fix two inaccuracies
**What I did:** (1) Changed "SQLite-only storage" to clarify that both SQLite and Postgres remain behind the StorageProvider contract — only the file-based backend is dropped. (2) Added deployment-specific callout to Phase 3 clarifying that K8s lightweight turns still route through agent-runtime pods, preserving the stateless host invariant.
**Files touched:** docs/plans/simplify-storage-architecture.md
**Outcome:** Success — plan now accurately reflects both deployment modes and DB backend flexibility
**Notes:** Important to keep plan docs consistent with the K8s agent compute architecture decision from 2026-03-04.

## [2026-03-08 22:00] — Produce unified WASM sandbox architecture plan

**Task:** Analyze two overlapping WASM design documents (autopilot fast sandbox + WASM agent platform), identify strengths/weaknesses, resolve tensions, and produce a single unified plan.
**What I did:** Deep-read both design documents alongside the existing k8s compute architecture, security hardening spec, credential proxy plan, sandbox provider types, IPC client, and provider-map. Produced a comprehensive unified plan with 5 Architecture Decision Records resolving key tensions (agent loop location, tool tiering, security model, k8s architecture, routing design), detailed critiques of both original docs, a concrete 8-week implementation roadmap, risk analysis, and explicit lists of what to cut from each proposal.
**Files touched:** docs/plans/2026-03-08-unified-wasm-sandbox-plan.md (new), .claude/journal/docs/plans.md (updated)
**Outcome:** Success — unified plan resolves all identified tensions with opinionated, pragmatic decisions backed by codebase analysis.
**Notes:** Core decision: WASM for tool execution only, agent stays native Node.js. Takes autopilot doc's hostcall API + security model, platform doc's k8s topology + HTTP proxy insight. Cuts agent-in-WASM, three-lane routing, signed capability tokens, python.wasm/quickjs.wasm from initial scope.

## [2026-03-08 20:41] — Harden unified WASM sandbox plan against current AX seams

**Task:** Review `docs/plans/2026-03-08-unified-wasm-sandbox-plan.md`, critique implementation gaps, and improve the plan so it matches the current AX architecture.
**What I did:** Cross-checked the draft against the actual `sandbox_*` IPC actions, `createSandboxToolHandlers()`, the NATS sandbox worker, provider-map/config blast radius, and the current credential + taint model. Rewrote the plan to anchor Tier 1 behind the existing sandbox IPC surface, deny raw WASI filesystem/HTTP in v1, add a k8s credential-boundary rollout gate, tighten fallback semantics, and add explicit parity/security/classifier/operational test requirements.
**Files touched:** docs/plans/2026-03-08-unified-wasm-sandbox-plan.md (updated), .claude/journal/docs/plans.md (updated), .claude/journal/docs/index.md (updated), .claude/lessons/architecture/entries.md (updated), .claude/lessons/architecture/index.md (updated)
**Outcome:** Success — plan is now grounded in AX's real host/IPC/sandbox seams instead of assuming new tools or looser security boundaries.
**Notes:** Biggest correction: initial WASM scope must fit the current tool catalog (`bash`, `read_file`, `write_file`, `edit_file`) and should attach at the host-side sandbox handler seam before any provider-kind or tool-catalog expansion.

## [2026-03-08 20:23] — Review and consolidate WASM sandbox architecture plans

**Task:** Review `2026-03-08-autopilot-fast-sandbox-architecture.md` and `2026-03-08-wasm-agent-platform-design.md`, critique the tradeoffs, and produce a stronger final architecture direction.
**What I did:** Compared both plans against the existing Kubernetes compute architecture, repository security invariants, and lessons learned. Identified where the hybrid fast-path plan is sound, where the full WASM-worker replacement overreaches, and synthesized a safer final direction: keep pod isolation for agent sessions, adopt the direct HTTP credential proxy first, and limit WASM to explicit deterministic tool capsules behind a routed execution policy.
**Files touched:** docs/plans/2026-03-08-autopilot-fast-sandbox-architecture.md (reviewed), docs/plans/2026-03-08-wasm-agent-platform-design.md (reviewed), docs/plans/2026-03-04-k8s-agent-compute-architecture.md (reviewed), docs/plans/2026-02-10-credential-injecting-proxy.md (reviewed), .claude/journal/docs/plans.md (updated), .claude/journal/docs/index.md (updated)
**Outcome:** Success — produced a concrete recommendation that preserves AX's pod-level trust boundary while still extracting the low-risk performance wins from the WASM proposals.
**Notes:** Main recommendation is to treat "direct HTTP proxy" and "WASM fast-path tools" as separate workstreams, and to leave "WASM agent sessions" as a research track until there is a stronger threat model and compatibility proof.

## [2026-03-08 14:08] — Specify concrete Wasm hostcall ABI for capsules

**Task:** Address feedback requesting implementation-level detail for running untrusted code in Wasm capsules.
**What I did:** Expanded the fast-sandbox architecture plan with a concrete hostcall design (`ax.fs.read`, `ax.fs.write`, optional policy-gated `ax.http.fetch`), capability-token model, strict schema/policy enforcement flow, audit/fallback semantics, and phased implementation milestones.
**Files touched:** docs/plans/2026-03-08-autopilot-fast-sandbox-architecture.md (updated)
**Outcome:** Success — plan now describes exactly how untrusted capsules interact with trusted host services while preserving least privilege.
**Notes:** Kept `ax.proc.exec` disabled by default to minimize trusted surface for initial rollout.

## [2026-03-08 13:39] — Design hybrid Wasm + pod sandbox strategy for GKE Autopilot

**Task:** Propose a more secure low-latency execution architecture for common tool calls in GKE Autopilot where nsjail/bwrap are unavailable.
**What I did:** Wrote a new architecture plan that introduces policy-routed execution lanes: Wasm capsules for the fast 80% path, warm gVisor sandbox pods for full POSIX fallback, and heavy dedicated pods for long-running tasks. Included routing intent model, capsule signing/provenance, rollout phases, SLOs, risks, and concrete AX implementation steps.
**Files touched:** docs/plans/2026-03-08-autopilot-fast-sandbox-architecture.md (new)
**Outcome:** Success — design gives a practical way to improve UX in Autopilot without weakening existing security invariants.
**Notes:** Recommended shadow-mode telemetry first, then canary rollout for read-only capsules before enabling write/network capsules.

## [2026-03-08 12:00] — Design plan: WASM agent platform with direct HTTP proxy

**Task:** Write up the WASM agent platform design, incorporating the insight that worker pods should reach the host pod's credential-injecting proxy via direct HTTP (not NATS)
**What I did:** Created a comprehensive design doc covering: revised three-layer architecture (host/NATS/worker with WASM sandboxes), the HTTP vs NATS communication split (HTTP for LLM proxy, NATS for IPC), WASI capability model, three options for running agent code in WASM, bash/file tool execution strategies, security model, scaling approach, and phased migration path. Key architectural insight: the proxy is stateless HTTP — wrapping it in NATS adds complexity for zero benefit. Worker pods already need host-reachable network for NATS, so adding HTTP proxy access requires no new network policy.
**Files touched:** docs/plans/2026-03-08-wasm-agent-platform-design.md (new)
**Outcome:** Success — design document written
**Notes:** Recommends hybrid approach (Option C): WASM for isolation boundary, subprocess for agent execution, HTTP for LLM proxy, NATS for IPC. Phase 1 (HTTP proxy extraction) is valuable independently of WASM adoption. Open questions around WASM runtime choice, JS-in-WASM, and WASI-HTTP maturity.

## [2026-03-06 14:00] — Design plan: K8s Helm presets + ax k8s init CLI

**Task:** Evaluate whether to build a K8s operator for AX, and design a simpler alternative
**What I did:** Brainstormed with user through the tradeoffs of a K8s operator vs Helm improvements. Concluded an operator is overkill for the target audience (developers who barely know K8s). Designed two complementary features: (1) Helm presets (small/medium/large) that collapse 230+ lines of values.yaml into a single key, (2) `ax k8s init` interactive CLI that creates secrets and generates a minimal values file. Covered preset definitions, CLI flow, DB migration strategy (auto on startup, no init job needed), file changes, and edge cases.
**Files touched:** docs/plans/2026-03-06-k8s-presets-and-init-design.md (new)
**Outcome:** Success — design document written and committed
**Notes:** Key decisions: no dev preset for K8s (just use npm start locally), CLI creates secrets via kubectl but does NOT run helm install, no new npm dependencies, presets use resolution order (user override > preset > chart default).

## [2026-03-05] — Add 5 missing provider skills to skills/ax

**Task:** Add skills for provider categories that had implementations but no corresponding skill documentation.
**What I did:** Compared `src/providers/` directories against `.claude/skills/ax/provider-*` skills. Found 5 missing: database, eventbus, image, screener, storage. Created SKILL.md for each following the established format (overview, interface tables, implementations table, provider-map entries, common tasks, gotchas, key files). Updated the parent `skills/ax/SKILL.md` to list all 18 providers.
**Files touched:** `.claude/skills/ax/provider-{database,eventbus,image,screener,storage}/SKILL.md` (new), `.claude/skills/ax/SKILL.md` (updated)
**Outcome:** Success — all provider categories now have corresponding skills.
**Notes:** Explored each provider's types.ts, implementations, and test files to write accurate skill docs. Provider-map entries verified against src/host/provider-map.ts.

## [2026-03-05 15:30] — Design acceptance tests for K8s agent compute architecture

**Task:** Design acceptance tests for `docs/plans/2026-03-04-k8s-agent-compute-architecture.md` using kind (Kubernetes IN Docker) as the test platform.
**What I did:** Read the full architecture plan and explored the codebase to verify implementation status (all core components exist: StorageProvider, EventBusProvider, k8s-pod sandbox, NATS protocols, pool controller, sandbox worker, host/agent-runtime process separation, Helm chart + FluxCD). Designed 42 acceptance tests across 5 categories: Structural (16), Helm Template (8), Kind Cluster (8), Integration (6), Security (4). Documented kind-specific adaptations (no gVisor, no GCS, no KEDA, single NATS node) and plan deviations. Created kind-values.yaml override spec and full setup/teardown instructions.
**Files touched:** `tests/acceptance/k8s-agent-compute/test-plan.md` (new)
**Outcome:** Success — comprehensive test plan ready for review before execution.
**Notes:** Codebase is extensively implemented — all Phase 1-3 components exist. Tests designed to validate integration and deployment rather than basic existence. Key risk areas: NATS stream init, NetworkPolicy enforcement (needs Calico on kind), per-turn pod affinity, conversation history persistence across pod restarts.

## [2026-03-05 12:00] — Helm templates: pool controller deployment, RBAC, sandbox templates

**Task:** Create Helm templates for the pool controller component (Task 6 of Helm chart build)
**What I did:** Created 5 template files: Deployment, ConfigMap (sandbox tier templates), ServiceAccount, Role, and RoleBinding. The sandbox templates ConfigMap renders each tier (light/heavy) as a JSON file consumed by the pool controller via SANDBOX_TEMPLATE_DIR env var. Deployment includes checksum annotations for config rollover.
**Files touched:** charts/ax/templates/pool-controller/{deployment,configmap-sandbox-templates,serviceaccount,role,rolebinding}.yaml (all new)
**Outcome:** Success — all templates render correctly via `helm template`, JSON is valid, RBAC grants pods CRUD to the pool controller service account.
**Notes:** The sandbox tier range loop handles both tiers with optional nodeSelector. Checksums on both ax-config and sandbox-templates ConfigMaps ensure pod restarts on config changes.

## [2026-03-02 22:35] — Save skills install plan feedback to file

**Task:** Save the previously provided plan-review comments into a standalone markdown file.
**What I did:** Created `skill-install-feedback.md` in the repo root and copied the full prioritized findings, open questions, and summary from the review response.
**Files touched:** skill-install-feedback.md (new)
**Outcome:** Success — feedback captured as a dedicated file for sharing/tracking.
**Notes:** Content mirrors the reviewed findings order (P0→P2) so implementation work can be triaged directly.

## [2026-03-02 22:10] — Review skills install architecture plan

**Task:** Review the proposed skills install architecture plan and provide concrete implementation feedback.
**What I did:** Fetched the draft plan, cross-checked it against current AX skills/IPC/tool-catalog code paths, and identified security, correctness, and testing gaps with line-referenced findings.
**Files touched:** Remote plan doc only (reviewed), local context files under src/ and tests/ read for validation.
**Outcome:** Success — produced prioritized findings (approval bypass risk, TOCTOU approval drift, integration/test omissions, and execution model concerns).
**Notes:** The plan is directionally solid, but inspect-phase command execution and execute-phase drift checks need hardening before implementation.

## [2026-03-02 12:00] — Create MemoryFS v2 plan (files-first, memU-inspired)

**Task:** Summarize conversation decisions about memory architecture and create a revised plan
**What I did:** Reviewed conversation about git tracking (rejected), SQLite-as-source-of-truth (rejected), and markdown-files-as-source-of-truth (chosen). Incorporated memU's architecture: three-layer data model (Resource→Item→Category), inline processing (memorize extracts+categorizes in one call), reinforcement instead of decay, no background processes. Wrote comprehensive v2 plan with 3 phases: Phase 1 (core memory, zero SQLite), Phase 2 (FTS5+embeddings search index), Phase 3 (richer history options).
**Files touched:** docs/plans/2026-03-02-memoryfs-v2-plan.md (new)
**Outcome:** Success — plan written, not yet committed
**Notes:** Key removals vs v1: Reconciler, Decayer, Monitor, Anticipator, Git Worker, two-phase writes, trigger files. SQLite is now a derived search index only — blow it away and rebuild from files. Reinforcement (access count [×N] inline in files) replaces timer-based decay.

## [2026-02-22 20:30] — OpenClaw gap analysis

**Task:** Identify major functionality gaps between AX and OpenClaw
**What I did:** Researched OpenClaw's full feature set (12+ channels, ClawHub marketplace with 3,286+ skills, voice support, Canvas visual workspace, native apps, Semantic Snapshots browser automation, Lobster workflow shell, webhook triggers, embedding-based memory search) and mapped it against AX's actual implementation state. Produced a prioritized gap analysis document with 15 identified gaps, categorized by priority and whether they're intentional design decisions.
**Files touched:** docs/plans/2026-02-22-openclaw-gap-analysis.md (created), .claude/journal.md (modified)
**Outcome:** Success — comprehensive gap analysis with prioritized recommendations
**Notes:** Key findings: (1) Channel coverage is the #1 adoption blocker — only Slack is implemented, WhatsApp/Telegram/Discord files don't exist despite being in provider-map.ts. (2) Phase 3 competitive strategy (ClawHub compatibility, skill screener, security officer) is entirely unimplemented. (3) AX has genuine security advantages that OpenClaw lacks (kernel sandbox, credential proxy, taint tracking). (4) Several gaps are intentional architectural decisions (no web UI, no marketplace).
