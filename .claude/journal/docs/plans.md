# Docs: Plans

Architecture analysis, gap analysis, design documents, implementation plans.

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
