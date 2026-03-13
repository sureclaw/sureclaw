# Workspace Provider Journal

## [2026-03-13] — Update acceptance test plan for GCS backend

**Task:** Update workspace acceptance test plan now that gcs.ts backend is implemented.
**What I did:** Added ST-9 (GCS backend structural verification: createGcsBackend export, lazy SDK import, mount downloads from GCS, commit uploads to GCS, GcsBucketLike interface, safePath usage, bucket config requirement). Updated ST-3 to verify all three source files exist on disk. Updated k8s environment notes to distinguish kind (uses local backend) from GKE production (uses gcs backend). Added GKE production environment section. Updated acceptance criteria list (now 19 items, was 18). Corrected "GCS not yet implemented" language throughout. Test count: 17 (ST: 9, BT: 5, IT: 3).
**Files touched:** Modified tests/acceptance/workspace/test-plan.md
**Outcome:** Success — test plan reflects current implementation state.
**Notes:** K8s kind tests still use `workspace: local` since kind clusters don't have GCS. The GCS backend is verified structurally (ST-9) and via its 20 unit tests, but not via behavioral acceptance tests (would require a real GCS bucket).

## [2026-03-13 11:42] — Add GCS workspace backend

**Task:** Implement GCS workspace backend per the design plan section 9 (`gcs` — Google Cloud Storage).
**What I did:** Added `@google-cloud/storage` dependency. Added `bucket` and `prefix` fields to `WorkspaceConfig` in types.ts. Created `src/providers/workspace/gcs.ts` with `createGcsBackend()` (exported for testing) and `create()` factory. Created `tests/providers/workspace/gcs.test.ts` with 20 tests using an in-memory mock GCS bucket. TDD approach: wrote tests first (RED), verified failure, then implemented (GREEN).
**Files touched:** package.json (dep), src/providers/workspace/types.ts, src/providers/workspace/gcs.ts (new), tests/providers/workspace/gcs.test.ts (new)
**Outcome:** Success — 20 new tests pass, all 2449 tests in full suite pass (209 files).
**Notes:** The `createGcsBackend()` accepts a `GcsBucketLike` interface for testability — tests pass a Map-backed mock. The GCS SDK is lazily imported in `create()` to avoid requiring it when other backends are used. Diff logic reuses the same snapshot approach as the local backend (hash-based). The provider-map already had the `gcs` entry from the integration step.

## [2026-03-13] — Design workspace provider acceptance test plan

**Task:** Create acceptance test plan for the workspace provider covering both local and k8s environments.
**What I did:** Read the design plan (docs/plans/2026-03-13-workspace-provider-design.md), all 4 implementation files, 3 unit test files, IPC schemas, IPC handler, tool catalog, server-completions lifecycle, and both local/k8s acceptance fixtures. Designed 16 tests: 8 structural (interface shape, provider-map, registry, IPC schema, tool catalog, orchestration defaults, IPC handler wiring), 5 behavioral (mount via chat, write+persist, none disables tools, oversized file rejection, ignore pattern filtering), 3 integration (cross-session persistence, additive scope escalation, host auto-mount of remembered scopes). Included full k8s execution plan using `workspace: local` on the host pod (GCS backend not yet implemented). Documented fixture changes, config patching strategy, side-effect checks for both environments, and the execution architecture.
**Files touched:** Created tests/acceptance/workspace/test-plan.md
**Outcome:** Success — comprehensive test plan ready for review and execution.
**Notes:** K8s uses `workspace: local` (not gcs) since gcs backend is unimplemented. The local backend runs on the host pod's ephemeral filesystem, which is fine for acceptance tests but NOT for production. BT-3 (none provider test) requires a separate server/namespace since it needs a different config. BT-4 needs `maxFileSize: 100` override for testability.

## [2026-03-13 10:47] — Add comprehensive workspace provider tests

**Task:** Write tests for none.ts, shared.ts, and local.ts workspace providers in tests/providers/workspace/.
**What I did:** Created 3 test files with 52 total tests: none.test.ts (7 tests: empty returns, no-op behavior, session independence), shared.test.ts (27 tests: scope tracking, structural checks for size/count/commit-size/ignore/binary, scanner integration with mock ScannerProvider, commit result shapes, cleanup behavior, config defaults), local.test.ts (18 tests: mount directory creation, idempotent mount, safePath traversal protection, diff detection for add/modify/delete, commit persistence and re-snapshot, full lifecycle with cross-session persistence).
**Files touched:** Created tests/providers/workspace/{none.test.ts, shared.test.ts, local.test.ts}
**Outcome:** Success — all 52 tests pass. Used real filesystem with tmpdir for local.test.ts, mocked backend/scanner for shared.test.ts.
**Notes:** Followed existing test patterns (vitest, .js extension imports, Config cast, tmpdir+randomUUID for temp dirs). The shared.test.ts tests exercise both structural filter layers and scanner integration by injecting mock backends that return controlled FileChange arrays.

## [2026-03-13] — Integrate workspace provider into AX infrastructure

**Task:** Wire the workspace provider into 7 integration points: types, provider-map, IPC schemas, agent tools, host IPC handler, host turn lifecycle, and config defaults.
**What I did:** Added WorkspaceProvider to ProviderRegistry and Config types. Added workspace category (none/local/gcs) to provider-map.ts with WorkspaceProviderName type. Added WorkspaceMountSchema + WorkspaceWriteSchema + WorkspaceWriteFileSchema to ipc-schemas.ts. Added workspace_scopes tool category and workspace_mount tool to tool-catalog.ts with hasWorkspaceScopes filter. Added workspace_mount to mcp-server.ts. Expanded workspace IPC handler with mount logic. Added workspace to registry.ts provider loading. Integrated workspace lifecycle (auto-mount, commit, cleanup) into server-completions.ts. Added workspace config block with defaults to config.ts. Updated 12 test files with workspace mocks and adjusted tool counts (14->15).
**Files touched:** src/types.ts, src/host/provider-map.ts, src/ipc-schemas.ts, src/agent/tool-catalog.ts, src/agent/agent-setup.ts, src/agent/runner.ts, src/agent/mcp-server.ts, src/host/ipc-handlers/workspace.ts, src/host/registry.ts, src/host/server-completions.ts, src/config.ts, tests/agent/ipc-tools.test.ts, tests/agent/tool-catalog.test.ts, tests/e2e/harness.ts, tests/host/delegation-hardening.test.ts, tests/host/ipc-delegation.test.ts, tests/host/ipc-handlers/image.test.ts, tests/host/ipc-handlers/llm-events.test.ts, tests/host/ipc-handlers/skills-install.test.ts, tests/host/ipc-server.test.ts, tests/host/router.test.ts, tests/integration/cross-component.test.ts, tests/integration/e2e.test.ts
**Outcome:** Success — 27 files changed across all 7 integration categories. All 205 test files (2377 tests) pass.
**Notes:** Used separate workspace_scopes category (not existing workspace category) because workspace_mount filters on hasWorkspaceScopes (provider != 'none') while workspace write/write_file filter on hasWorkspaceTiers (enterprise). Three additional test files needed updates beyond the initial 12: tests/sandbox-isolation.test.ts, tests/agent/mcp-server.test.ts, and tests/agent/tool-catalog.test.ts required workspace_mount in expected tool lists, count bumps (14->15), and hasWorkspaceScopes in filter contexts.

## [2026-03-13] — Implement workspace provider category

**Task:** Create 4 new files under src/providers/workspace/ implementing the WorkspaceProvider category per the design plan.
**What I did:** Created types.ts (interfaces), none.ts (stub), shared.ts (orchestration with structural checks + scanner delegation), local.ts (filesystem backend with snapshot-based diffing). Followed existing provider patterns (scanner/types.ts, scheduler/none.ts). Used safePath() for all path construction in local.ts.
**Files touched:** Created src/providers/workspace/{types.ts, none.ts, shared.ts, local.ts}
**Outcome:** Success — all 4 files pass tsc with zero errors, no existing files modified.
**Notes:** Config type doesn't have a workspace block yet (that requires modifying src/types.ts). Local provider uses `config as unknown as Record<string, unknown>` cast to safely access the optional workspace config section.
