# Docs: Website

README.md updates, docs/web site updates, dashboard, warning banners, GitHub Pages deployment, skill syncs.

## [2026-03-29 14:00] — Restructure Agents page and add Plugins section

**Task:** Tasks 5+6: Replace the agents list+detail panel with horizontal tabs with a new layout using agent selector dropdown, vertical sub-nav, and full content area. Add a PluginsSection component for installing/uninstalling/viewing plugins.
**What I did:** Rewrote `agents-page.tsx` completely. Removed old `AgentDetail`, table layout, and horizontal tab bar. Added: `AgentSelector` dropdown with status dots, type badges, and inline kill buttons; `SubNav` vertical navigation with 3 groups (AGENT/TOOLS/DATA) and 6 sections including new Plugins; `ContentArea` wrapper rendering active section in a card; `PluginsSection` with install form (inline toggle, spinner, error), plugin cards grid (name, version, description, stat badges, source, relative time, confirm-on-uninstall), and empty state; `timeAgo` helper. Kept all existing section components (InfoTab, IdentityTab, SkillsTab, WorkspaceTab, MemoryTab, TabSkeleton, TabError, TabEmpty) intact.
**Files touched:** `ui/admin/src/components/pages/agents-page.tsx`
**Outcome:** Success — `npx tsc --noEmit` passes with no errors.
**Notes:** Tasks 5+6 of multi-task plan for MCP/plugin management UI. New `SectionId` type replaces old `TabId`. Auto-selects first agent on load.

## [2026-03-29 13:00] — Create ConnectorsPage for admin dashboard

**Task:** Build a complete "Connectors" page component for managing global MCP servers, with add/edit form, server list table, test/save workflow, and wire it into App.tsx navigation.
**What I did:** Created `connectors-page.tsx` with: page header, inline add/edit form with key-value header editing, test-and-save workflow (test on save, show results, auto-close on success, "Save Anyway" on failure), table listing with status badges (Untested/Connected/Failed), per-server test button with inline spinner, edit/remove actions with confirm-on-delete pattern, empty state, loading skeleton, and error state. Modified `App.tsx` to add Globe icon import, 'connectors' page type, nav item after agents, ConnectorsPage import and rendering.
**Files touched:** `ui/admin/src/components/pages/connectors-page.tsx` (created), `ui/admin/src/App.tsx` (modified)
**Outcome:** Success — `npx tsc --noEmit` passes with no errors.
**Notes:** Task 4 of multi-task plan for MCP/plugin management UI. Follows existing design patterns from agents-page.tsx.

## [2026-03-29 12:00] — Add MCP server and plugin types and API methods to admin dashboard

**Task:** Add TypeScript types (McpServer, InstalledPlugin, McpTestResult) and API client methods for MCP server CRUD/test and agent plugin install/uninstall to the admin dashboard.
**What I did:** Added three new interfaces to `ui/admin/src/lib/types.ts`. Updated imports and added 8 new API methods to `ui/admin/src/lib/api.ts`: mcpServers, addMcpServer, updateMcpServer, removeMcpServer, testMcpServer, agentPlugins, installPlugin, uninstallPlugin.
**Files touched:** `ui/admin/src/lib/types.ts`, `ui/admin/src/lib/api.ts`
**Outcome:** Success — `npx tsc --noEmit` passes with no errors.
**Notes:** Task 3 of multi-task plan for MCP/plugin management UI.

## [2026-03-16 18:00] — Rewrite ax-provider-sandbox skill for unified container model

**Task:** Update the ax-provider-sandbox skill to reflect major architecture changes: removed seatbelt/nsjail/bwrap providers, removed sandbox-worker and nats-sandbox-dispatch, new unified container model with three-phase orchestration, NATS IPC for k8s, warm pool, local sandbox execution, workspace CLI.
**What I did:** Complete rewrite of `.claude/skills/ax-provider-sandbox/SKILL.md`. Removed all references to seatbelt, nsjail, bwrap, sandbox-worker, nats-sandbox-dispatch. Updated implementations table (now: subprocess, docker, apple, k8s). Added sections for three-phase container orchestration, Docker/Apple/K8s provider details, warm pod pool, local sandbox execution, workspace CLI. Updated SandboxConfig/SandboxProcess interface tables with new fields (cpus, network, extraEnv, bridgeSocketPath, podName). Updated gotchas and key files.
**Files touched:** `.claude/skills/ax-provider-sandbox/SKILL.md`, `.claude/journal/docs/index.md`, `.claude/journal/docs/website.md`
**Outcome:** Success
**Notes:** Verified all file references against actual codebase. Provider map confirms only subprocess, docker, apple, k8s in sandbox section.

## [2026-03-13 16:30] — Add GCS workspace K8s setup instructions to README

**Task:** Add instructions to README.md for setting up a K8s AX cluster with GCS as the workspace provider
**What I did:** Added a new "GCS Workspace Provider (Kubernetes)" section to README.md between "Local Development with kind" and "FluxCD GitOps". Covers bucket creation, GKE Workload Identity and service account key auth options, Helm config, deploy, and verification steps.
**Files touched:** README.md
**Outcome:** Success
**Notes:** The GCS provider reads bucket name from `workspace.bucket` config or `GCS_WORKSPACE_BUCKET` env var. Auth via Application Default Credentials (Workload Identity on GKE, or `GOOGLE_APPLICATION_CREDENTIALS` elsewhere).

## [2026-03-13 15:00] — Sync all ax/* skills with codebase changes

**Task:** Update all .claude/skills/ax/ skills to reflect codebase changes since last sync
**What I did:** Updated 12 skill files across all subsystems:
- provider-storage: Added DocumentStore, migrate-to-db, content serialization
- provider-memory: Complete rewrite — only cortex remains with SummaryStore, embeddings
- provider-scanner: Removed basic scanner references
- provider-sandbox: Rewrote for canonical paths, K8s/NATS sandbox, sandbox-worker
- host: Added NATS subsystem, agent registry, admin API, new IPC handler files
- agent: Updated boot sequence for stdin payload identity/skills loading
- cli: Added k8s-init, reload, setup-server
- utils: Added migrator, content-serialization, bin-exists, install-validator
- persistence: Complete rewrite for unified StorageProvider architecture
- testing: Full directory structure rewrite (removed stale files, added 60+ new tests)
- security: Updated sandbox isolation for canonical mounts, added install validation
- ipc: Added sandbox tools, skill_install, NATS transport, removed workspace_read/list
- runners: Added NATS bridge, identity-loader, stdin payload gotchas
- parent ax: Added admin-dashboard-ui category
**Files touched:** 14 files under .claude/skills/ax/
**Outcome:** Success — all skills now accurate with current codebase state

## [2026-03-05 22:30] — Add Kubernetes deployment instructions to README.md

**Task:** Add step-by-step K8s deployment instructions to README.md
**What I did:** Added a comprehensive "Deploying to Kubernetes" section between Configuration and CLI sections, covering: prerequisites, building/pushing images, creating secrets, values file, helm install, verification, architecture overview table, key configuration reference, ingress exposure, kind local dev, and FluxCD GitOps.
**Files touched:** README.md
**Outcome:** Success — README now has actionable deployment guide matching the Helm chart configuration
**Notes:** Followed project voice guidelines (warm, self-deprecating). Instructions reference actual values from charts/ax/values.yaml.

## [2026-03-05 21:00] — Update README.md with changes since last update

**Task:** Update README.md to reflect all changes made since the last update (commit c143cbd, 68 commits ago)
**What I did:** Updated README to reflect: k8s sandbox + Helm chart, memoryfs→cortex rename, promptfoo→guardian scanner, new database/storage/eventbus provider categories, shared DatabaseProvider pattern, NATS JetStream for distributed events, updated provider table (13→16 categories, 43→45+ implementations), dual config examples (local vs k8s), credential provider rename (env→plaintext)
**Files touched:** README.md
**Outcome:** Success — README now accurately reflects current state of the project
**Notes:** Major themes: k8s production readiness, provider consolidation (shared DB), and security scanner evolution

## [2026-03-04 12:00] — Create AX admin dashboard React source files

**Task:** Create all React component source files for the AX admin dashboard
**What I did:** Created 6 new page components (overview, agents, logs, security, settings, setup). Verified that 7 files already existed and were complete (main.tsx, index.css, lib/types.ts, lib/api.ts, hooks/use-api.ts, App.tsx, login-page.tsx). All 13 files now form a complete dashboard with: dark zinc/gray theme with amber accents, sidebar navigation, auth gate with token-based login, setup wizard with multi-step flow (welcome/profile/agent-type/api-key/review/done), overview with stats + live agents + activity feed, agents management with detail panel + kill, audit logs with filtering, security monitoring with threat patterns + scan history, read-only settings display.
**Files touched:**
- `dashboard/src/components/pages/overview-page.tsx` (created)
- `dashboard/src/components/pages/agents-page.tsx` (created)
- `dashboard/src/components/pages/logs-page.tsx` (created)
- `dashboard/src/components/pages/security-page.tsx` (created)
- `dashboard/src/components/pages/settings-page.tsx` (created)
- `dashboard/src/components/pages/setup-page.tsx` (created)
**Outcome:** Success — all 13 dashboard source files complete
**Notes:** Uses lucide-react icons, Tailwind CSS with custom component classes (card, btn-primary, badge-green, etc.), useApi hook for data fetching. All components handle loading/error/empty states.

## [2026-03-03 12:00] — Sync ax/* skills and docs/web with codebase changes

**Task:** Update all ax/* skill files and docs/web/index.html to reflect codebase changes since last documentation update
**What I did:**
- Updated 12 skill files across provider-llm (added DeepInfra), provider-credentials (removed encrypted, renamed env→plaintext), provider-sandbox (added bwrap), provider-memory (added memoryfs v2), provider-scheduler (added plainjob + full), provider-system (added groq image), host (added orchestration subsystem, webhooks, history summarizer, memory recall, 13 new IPC handler files), ipc (added 11 orchestration/delegation/identity actions), utils (added embedding-client, openai-compat, circuit-breaker, database, migrator), config (added history.summarize/memory_recall fields, webhooks config), testing (added acceptance tests, new test categories), persistence (added job-store, session-store)
- Updated docs/web/index.html: provider count 43→46, test files 170→199, TS lines 10700→27600, "Encrypted Credentials"→"Secure Credentials" (encrypted provider removed), og:description updated
**Files touched:** 12 .claude/skills/ax/ SKILL.md files, docs/web/index.html
**Outcome:** Success — skills and docs now accurately reflect current codebase state (46 providers, 13 categories, 199 tests, ~27.6k LoC)
**Notes:** Major additions since last update: orchestration subsystem, MemoryFS v2 (embedding-based), plainjob scheduler, DeepInfra LLM, webhook transforms, history summarization, memory recall. Encrypted credential provider was removed.

## [2026-02-28 18:00] — Move warning banner below navbar

**Task:** Reposition the dev warning banner to appear below the main navigation header instead of above it
**What I did:** Swapped the visual stacking order of the navbar and dev-banner. Updated CSS so navbar is `top: 0; z-index: 60` and dev-banner is `top: 4rem; z-index: 50`. Removed the now-unnecessary mobile `navbar { top: 3.5rem }` override. Updated HTML comment to clarify placement.
**Files touched:** `docs/web/index.html`, `docs/web/styles.css`
**Outcome:** Success — banner now renders directly beneath the navbar on both desktop and mobile
**Notes:** Total fixed header height unchanged (navbar 4rem + banner ~2.5rem), so hero padding didn't need adjustment.

## [2026-02-28 14:30] — Update README.md and docs/web to reflect all recent changes

**Task:** Comprehensively update README.md and docs/web/index.html to reflect all features added since they were last updated, and use the ax-logo.svg file as the logo.
**What I did:**
- Updated README.md: fixed logo path (`docs/ax-logo.svg` → `docs/web/ax-logo.svg`), updated line count (~13,500 → ~10,700), added 12 new feature sections (streaming event bus, plugin framework, image generation, OpenTelemetry tracing, extended thinking, Kysely migrations, skill import, subagent delegation, active hours scheduling, CLI commands, OpenAI-compatible API enhancements), updated provider table (13 categories, 43 implementations), added CLI section, updated config example with task-type model routing
- Updated docs/web/index.html: replaced inline SVG logos with `<img src="ax-logo.svg">`, expanded feature grid from 6 to 9 cards (added plugin ecosystem, image generation, streaming & observability), updated code showcase with current config format showing models by task type, updated deep-dive sections (added extended thinking, OTel, plugin SDK references, task-type model routing), added "Get Started" section with CLI commands, updated stats (13 categories, 43 implementations, 170 test files, 10,700 LoC), updated provider grid blocks, added `#capabilities` nav link
- Updated docs/web/styles.css: added `img` selectors alongside SVG for navbar and footer logo, added `max-width: 100%` to img reset
**Files touched:** `README.md`, `docs/web/index.html`, `docs/web/styles.css`
**Outcome:** Success — both files now accurately reflect the current state of all 13 provider categories, 43 provider implementations, plugin framework, streaming event bus, image generation, OTel tracing, and other recent additions
**Notes:** The ax-logo.svg uses a gold gradient (#eab308 → #facc15) while the website's CSS accent is cyan. The `<img>` tag approach means the logo renders in its native gold color rather than inheriting CSS accent colors — this is a deliberate branding distinction.

## [2026-02-28 14:30] — Add development warning banner to docs/web/index.html

**Task:** Add a friendly/witty warning banner to the website that the project is under heavy development
**What I did:** Added a fixed-position orange warning banner between the navbar and hero section. Styled it with the existing design tokens (--ds-orange, --ds-orange-dim). Adjusted navbar top offset and hero padding to accommodate the banner. Added responsive styles for mobile. Used the project's voice: self-deprecating but competent ("APIs will change, things will break, and we'll probably rename at least three more modules before lunch").
**Files touched:** `docs/web/index.html`, `docs/web/styles.css`
**Outcome:** Success — banner displays above navbar with orange styling, responsive on mobile
**Notes:** Used z-index: 60 for the banner (above navbar's z-index: 50). The banner is ~2.5rem on desktop, ~3.5rem on mobile due to text wrapping.

## [2026-02-25 00:00] — Fix GitHub Pages deployment workflow

**Task:** GitHub Pages site in docs/web wasn't showing up — diagnose and fix
**What I did:** Found three issues in `.github/workflows/pages.yml`: (1) Missing `contents: read` permission — when `permissions` is explicitly set at workflow level, it replaces ALL defaults, so `actions/checkout` couldn't clone the repo. (2) No `workflow_dispatch` trigger, preventing manual re-runs. (3) No `concurrency` group, risking overlapping deployments. Also added the workflow file itself to the paths trigger so workflow changes redeploy.
**Files touched:** .github/workflows/pages.yml
**Outcome:** Success — workflow now has correct permissions, manual trigger support, and concurrency control
**Notes:** The `contents: read` omission is a common GitHub Actions gotcha. When you explicitly set `permissions`, you lose all defaults — including the `contents: read` that `actions/checkout` needs.
