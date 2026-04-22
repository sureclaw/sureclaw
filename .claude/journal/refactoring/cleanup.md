# Refactoring: Cleanup

General refactoring, stale reference cleanup, path realignment, dependency updates.

## [2026-04-22 10:50] — YAGNI: drop unused `WaitFailureTracker.emit()`

**Task:** Code-review fix from Task 5 — `WaitFailureTracker.emit()` (introduced in `8a0f1ee9`) was dead production surface. Production only uses `record()` + `emitTerminal()`. Per CLAUDE.md "YAGNI ruthlessly," remove it.
**What I did:** Deleted the `emit()` method from the tracker, the matching interface entry, and the docstring example referring to it. Removed the two `tracker.emit(...)` test cases from `tests/host/chat-termination.test.ts` (the no-op-when-empty case and the three-attempt exhaustion case — `emitTerminal` already covers the equivalent semantics). Trimmed the heavy ~70-line tracker docstring to a 6-line block on `createWaitFailureTracker` covering only the WHY (per-attempt vs terminal, recorded-cause-wins, fails-then-succeeds emits zero events). Kept the file-header comment as is (it explains the cross-subsystem contract).
**Files touched:** Modified: `src/host/chat-termination.ts`, `tests/host/chat-termination.test.ts`.
**Outcome:** Success. `npm run build` clean. `npx vitest run tests/host/chat-termination.test.ts tests/host/chat-termination-retry.test.ts` → 12 tests pass (down from 14, as expected). `grep -rn 'tracker\.emit\b\|tracker\.emit(' src/ tests/` → zero hits.
**Notes:** Skill files already only reference `emitTerminal` — `ax-logging-errors/SKILL.md` was correct, `ax-host/SKILL.md` was generic ("emits chat_terminated EXACTLY ONCE per terminated chat"). No skill updates needed.

## [2026-04-18 16:37] — Tool-modules final review cleanup: drop `compactIndex` + `ToolStubCache` helpers + Task-N refs

**Task:** Land three small cleanups (plus one bonus) from the final code review of the tool-modules-git-native migration.
**What I did:**
- **Dead `ToolStubCache` helpers:** Reduced `src/providers/storage/tool-stubs.ts` to just the `ToolStubFile` interface + a one-line header. Dropped `ToolStubCache`, `computeSchemaHash`, `getToolStubs`, `putToolStubs`, `getCachedOrNull` (zero callers anywhere in `src/` + `tests/`) plus the now-orphan `createHash` / `DocumentStore` / `McpToolSchema` imports.
- **Unused `compactIndex` on `prepareToolModules`:** Dropped `compactIndex` from `PrepareToolModulesResult` + stopped calling `generateCompactIndex(groups)` in `src/host/toolgen/generate-and-cache.ts`. Deleted the `generateCompactIndex` function from `src/host/toolgen/codegen.ts`. Removed it from the re-export in `src/host/toolgen/index.ts`. Stripped the 2 assertions from `tests/host/toolgen/generate-and-cache.test.ts`, 9 assertions + 2 test-name tweaks from `tests/host/toolgen/e2e.test.ts`, and deleted the `describe('generateCompactIndex')` block + `groupToolsByServer` import from `tests/host/toolgen/module-codegen.test.ts`. Production prompt-render now lives agent-side (Task 6's `tool-index-loader.ts` generates it from `_index.json`).
- **Task-N references in `tool-module-sync.ts`:** Dropped the `(Task 3)` / `(Task 4)` parentheticals from the header comment; rest of the sentence kept.
- **Bonus — stale `.claude/skills/ax-provider-storage/SKILL.md` section:** Replaced the Tool Stubs Cache section (described the deleted `computeSchemaHash` + `getCachedOrNull` + `putToolStubs` API) with a one-liner describing what `tool-stubs.ts` is now — just the shared `ToolStubFile` shape used by host-side tool-module generation. Also corrected the Key Files description of the same file.
**Files touched:** Modified: `src/providers/storage/tool-stubs.ts`, `src/host/toolgen/generate-and-cache.ts`, `src/host/toolgen/codegen.ts`, `src/host/toolgen/index.ts`, `src/host/skills/tool-module-sync.ts`, `tests/host/toolgen/generate-and-cache.test.ts`, `tests/host/toolgen/e2e.test.ts`, `tests/host/toolgen/module-codegen.test.ts`, `.claude/skills/ax-provider-storage/SKILL.md`.
**Outcome:** Success — `npm run build` clean. `npx vitest run tests/host/toolgen/ tests/host/skills/` → 18 files / 124 tests green. Exit-criteria greps: `rg 'ToolStubCache|getToolStubs|putToolStubs|computeSchemaHash|getCachedOrNull' src/ tests/` → zero hits. `rg 'generateCompactIndex|compactIndex' src/ tests/` → zero hits.
**Notes:** `rg 'Task [0-9]' src/` flagged 12 remaining hits, all of them `// Phase 6 Task N` references in `src/host/server-admin.ts` / `admin-oauth-providers.ts` / `server-init.ts` — out of scope for this cleanup (different phase, at least scoped by "Phase 6" so they retain some meaning).

## [2026-04-18 14:45] — Tool-modules Task 8: scrub dead `generateCLI` + `McpProvider.listTools`

**Task:** Final task of the tool-modules-git-native plan — residual cleanup sweep. Task 5 deleted `prepareMcpCLIs`, which was the only live caller of `generateCLI`. And the filesystem-scan approach from Tasks 2 + 6 means nothing in `src/` calls `McpProvider.listTools` anymore either. Both were dead contract surface.
**What I did:**
- **`generateCLI` + helpers:** Removed `generateCLI`, `mcpToolToCLICommand`, and `inferGroup` from `src/host/toolgen/codegen.ts` (~170 lines including the embedded CLI template). Dropped `generateCLI` from the re-export in `src/host/toolgen/index.ts`. Removed the `describe('generateCLI')` + `describe('mcpToolToCLICommand')` blocks from `tests/host/toolgen/codegen.test.ts`, leaving only `groupToolsByServer` coverage. Kept `groupToolsByServer`, `generateModule`, `generateIndex`, `generateCompactIndex`, `snakeToCamel` — those are live for the PTC tool-module pipeline.
- **`McpProvider.listTools`:** Removed the `listTools` method from the `McpProvider` interface in `src/providers/mcp/types.ts`. Deleted the implementation in `src/providers/mcp/database.ts` along with the now-orphaned `toolCache` Map, `cacheTtlMs` constant, and the `toolCache.delete(...)` call in `callTool` that only existed to invalidate it. `connectAndListTools` is kept in the import list (still used by `testGlobalMcpServer`). `src/providers/mcp/none.ts` didn't need editing — it uses `disabledProvider<T>()` which auto-stubs every interface method via a Proxy. Dropped the `async listTools() { return []; }` stubs from `tests/host/tool-router.test.ts` (1), `tests/host/inprocess.test.ts` (1), and `tests/host/mcp-exfiltration.test.ts` (7).
**Files touched:** Modified: `src/host/toolgen/codegen.ts`, `src/host/toolgen/index.ts`, `src/providers/mcp/types.ts`, `src/providers/mcp/database.ts`, `tests/host/toolgen/codegen.test.ts`, `tests/host/tool-router.test.ts`, `tests/host/inprocess.test.ts`, `tests/host/mcp-exfiltration.test.ts`.
**Outcome:** Success — `npm run build` clean. Directly-related tests green: `npx vitest run tests/host/toolgen tests/host/tool-router.test.ts tests/host/mcp-exfiltration.test.ts tests/host/inprocess.test.ts tests/providers/mcp` → 8 files / 58 tests pass for the toolgen/router/inprocess/exfil quartet, plus 8/8 in `tests/providers/mcp/database.test.ts`. Full `tests/host/ tests/agent/` run: 143 files / 1486 tests pass; the 29 failures across 3 files are the pre-existing macOS Unix-socket EINVAL issue in `server.test.ts`, `smoke.test.ts`, `history-smoke.test.ts` — identical to the phase-7 baseline, unrelated to these changes.
**Notes:** `McpProvider.listTools` used to be the MCP discovery surface for the per-turn-generated tool stubs. After Tasks 2 + 4 + 6, tool discovery happens at skill-approval time (filesystem scan + `syncToolModules` writing to `.ax/tools/`) and the agent reads the module index from disk — so the runtime MCP listing contract became a ghost limb. `toolCache` going with it was incidental but correct: it was only ever populated inside `listTools`, so without callers it was pure dead state. `disabledProvider<T>()` is a nice safety net for interface shrinkage — no explicit stub maintenance in `none.ts`.

## [2026-04-17 19:58] — Phase 7 Task 7 post-review fixes (1 critical + 3 important)

**Task:** Address code-quality review findings on Task 7 (commit 5a3f4144) — an orphan admin UI SkillsTab still calling the deleted per-agent `/agents/:id/skills` endpoints, plus three stale references.
**What I did:**
- **CRITICAL — Admin UI orphan SkillsTab:** Deleted the `SkillsTab` component (~175 lines) from `ui/admin/src/components/pages/agents-page.tsx`, dropped `'skills'` from the `SectionId` union, removed the `{ id: 'skills', label: 'Skills', icon: Sparkles }` sidebar nav entry, removed the `{activeSection === 'skills' && <SkillsTab ... />}` render branch, and removed the now-unused icon imports (`Sparkles`, `Pencil`, `Save`, `X`) + `SkillEntry` type import. Removed `agentSkills` / `agentSkillContent` / `updateSkill` / `deleteSkill` methods from `ui/admin/src/lib/api.ts` and their `SkillEntry` / `SkillContent` type imports. Deleted `SkillEntry` + `SkillContent` interfaces from `ui/admin/src/lib/types.ts`. Deleted the Playwright route mocks for `/agents/*/skills` and `/agents/*/skills/*` from `ui/admin/tests/fixtures.ts` along with the `MOCK_SKILLS` constant, and updated `ui/admin/tests/agent-tabs.spec.ts` to drop the `MOCK_SKILLS` import + the two Skills-tab test cases + retitled `"shows all five tabs"` → `"shows all four tabs"`. **Kept** the separate phase-5 `SkillsPage` (admin setup cards + credential requests at `/admin/?page=skills`) untouched — different feature, live endpoint.
- **Stale comment (mcp-exfiltration test):** `tests/host/mcp-exfiltration.test.ts:262` — replaced `"handled by discoverTools, not the router"` with `"handled at MCP tool discovery time, not the router"`.
- **Stale config sample (docs/web):** `docs/web/index.html:230` — dropped the `providers.skills: git` line from the personal profile config sample (skills is no longer a provider category).
- **Misleading log (server-completions):** `src/host/server-completions.ts:590-592` — renamed `fast_path_skip_no_documents` → `sandbox_state_unavailable_fallback` and rewrote the comment to say "Can't determine sandbox liveness without the documents store" (the guard exists because `hasActiveSandbox` reads from `documents`, not because the fast path itself needs documents).
**Files touched:** Modified: `ui/admin/src/components/pages/agents-page.tsx`, `ui/admin/src/lib/api.ts`, `ui/admin/src/lib/types.ts`, `ui/admin/tests/fixtures.ts`, `ui/admin/tests/agent-tabs.spec.ts`, `tests/host/mcp-exfiltration.test.ts`, `docs/web/index.html`, `src/host/server-completions.ts`.
**Outcome:** Success — `npm run build` clean; `cd ui/admin && npx tsc --noEmit` clean; `npx vitest run tests/host/mcp-exfiltration tests/host/server-completions` → 3 files / 14 tests green; `npx vitest run tests/host/server-admin` → 4 files / 87 tests green. No lingering hits for `agentSkills|agentSkillContent|updateSkill|deleteSkill|MOCK_SKILLS|SkillEntry|SkillContent` in `ui/admin/`.
**Notes:** The SkillsTab had never been wired to anything real after Task 1 removed its IPC backing — the client-side dashboard was calling endpoints that returned 404s from the moment Task 7 landed. Classic dead-code-after-backend-delete hazard: remember to grep UI callers when removing REST routes.

## [2026-04-17 19:45] — Phase 7 Task 7 (final): Docs sweep + dead-code cleanup + full verification

**Task:** Final task of phase 7 — delete the last readers of the retired `documents.skills` / `documents.plugins` collections, update README + web docs + `.claude/skills/ax*/` for the git-native skill flow, fix stale in-code comments, and verify the five exit-criteria greps return zero.
**What I did:**
- **Dead code:** Removed `findSkillContent` + `listWorkspaceSkills` helpers and the two GET endpoints in `src/host/server-admin.ts` they backed (`/admin/api/agents/:id/skills` and `/admin/api/agents/:id/skills/:name`); dropped the now-unused `parseAgentSkill` import. Removed `loadSkillsFromDB` from `src/host/inprocess.ts` along with `extractAppHints` / `discoverTools` (the only callers), the `documents` + `McpProvider` imports, the `documents` field on `FastPathDeps`, and the `documents: providers.storage.documents` pass-through in `src/host/server-completions.ts`. Inlined the prompt builder (no more skills param) and renumbered the in-loop step comments.
- **Tests:** Dropped `extractAppHints` + `loadSkillsFromDB` tests from `tests/host/inprocess.test.ts`, removed the `documents: mockDocuments()` injections, deleted the `GET /admin/api/agents/:id/skills` block from `tests/host/server-admin.test.ts`, rewired the stray `skill_delete` in `tests/agent/ipc-client.test.ts` to `memory_list`, deleted the `skill_update` / `skill_delete` branches in `tests/integration/cross-component.test.ts`, updated a stale comment in `tests/host/web-proxy.test.ts`. Fixed pre-existing stale `sandbox-isolation.test.ts` assertions — the MCP server now exports 14 tools (was 15) and `ipc-tools` no longer has a `skill` entry.
- **Docs:** Rewrote the Skills + MCP + CLI sections in `README.md` (git-native flow, admin dashboard approval, retired `ax plugin` / `ax mcp`). Flipped the `ax plugin add @ax/web` example in `docs/web/index.html` to `ax provider add`. Rewrote `.claude/skills/ax-provider-skills/SKILL.md` top-to-bottom to document the current reconciler + admin-approval pipeline. Updated `ax-ipc`, `ax-host`, `ax-cli`, `ax-agent`, `ax-security`, `ax-web-proxy`, `ax-runners`, `ax-debug`, `ax-testing`, `ax-provider-credentials`, and `ax/SKILL.md` to drop retired rows, refresh file listings, and describe the current flow.
- **Stale in-code comments:** `src/host/plugin-manifest.ts` (printed during `ax provider add`), `src/host/registry.ts` (describes skill reconciler + admin API instead of retired CLI), `src/plugins/startup.ts` (loadDatabaseMcpServers source note).
**Files touched:** Modified: `src/host/server-admin.ts`, `src/host/inprocess.ts`, `src/host/server-completions.ts`, `src/host/plugin-manifest.ts`, `src/host/registry.ts`, `src/plugins/startup.ts`, `README.md`, `docs/web/index.html`, `.claude/skills/ax-provider-skills/SKILL.md`, `.claude/skills/ax-ipc/SKILL.md`, `.claude/skills/ax-host/SKILL.md`, `.claude/skills/ax-cli/SKILL.md`, `.claude/skills/ax-agent/SKILL.md`, `.claude/skills/ax-security/SKILL.md`, `.claude/skills/ax-web-proxy/SKILL.md`, `.claude/skills/ax-runners/SKILL.md`, `.claude/skills/ax-debug/SKILL.md`, `.claude/skills/ax-testing/SKILL.md`, `.claude/skills/ax-provider-credentials/SKILL.md`, `.claude/skills/ax/SKILL.md`, `tests/host/inprocess.test.ts`, `tests/host/server-admin.test.ts`, `tests/agent/ipc-client.test.ts`, `tests/integration/cross-component.test.ts`, `tests/host/web-proxy.test.ts`, `tests/sandbox-isolation.test.ts`.
**Outcome:** Success — `npm run build` clean. Full suite: 251 files pass / 2634 tests pass; the 33 failures / 5 files are the pre-existing macOS Unix-socket `EINVAL` issue in `smoke.test.ts`, `history-smoke.test.ts`, `server.test.ts`, `server-history.test.ts`, `server-multimodal.test.ts` — unchanged from the phase-7 baseline. All five exit-criteria greps over `src/` + `tests/` + `README.md` + `docs/web/` return zero hits (the one `DocumentStore.*skill` hit in `src/providers/storage/migrations.ts` is the Migration-008 comment explaining why the collection is empty, which is load-bearing).
**Notes:** Phase 7 is now complete. Phases 1–6 built the git-native skills pipeline, the admin approval flow, the state store, and the OAuth PKCE path. Phase 7 removed the legacy install surface — the `skill_install/create/update/delete` IPC actions + agent tool (Task 1), the ClawHub registry client + DocumentStore skill storage (Task 2), the plugin manifest/install machinery keeping only the MCP connection manager (Task 3), the `ax plugin` + `ax mcp` CLI + admin plugin endpoints + admin UI Plugins tab (Task 4), the skill-install-intent prompt artifacts + `skillInstallEnabled` flags (Task 5), the retired DB rows via Migration 008 (Task 6), and today's docs sweep + dead-code pruning (Task 7). No production code reads `documents.skills` / `documents.plugins` anymore.

## [2026-04-17 19:10] — Phase 7 Task 6: Drop retired DB data via migration

**Task:** Delete `documents` rows left behind by the retired plugin-install path and the pre-phase-3 DocumentStore-backed skills. Data is legacy; live code path now reads git-native skills + state-store.
**What I did:** Added migration `storage_008_drop_legacy_documents` to `src/providers/storage/migrations.ts`. Uses Kysely's `deleteFrom('documents').where('collection', 'in', ['plugins', 'skills']).execute()` — dialect-agnostic for SQLite + Postgres. Wrapped in a try/catch that swallows only "no such table" / "does not exist" / "relation does not exist" errors so pre-004 DBs don't blow up; genuine errors still bubble. `down()` is a deliberate no-op — we don't resurrect retired data. Important: plan doc used `kind` as the column name, but the real schema uses `collection` (confirmed via `storage_004_documents` + `src/providers/storage/database.ts`). Added smoke test `tests/migrations/storage-drop-legacy-documents.test.ts` with three cases: (1) deletes plugins+skills rows while leaving identity/config intact, (2) idempotent re-run is a no-op, (3) calling `up()` directly against a DB with no `documents` table doesn't throw.
**Files touched:** Modified: `src/providers/storage/migrations.ts`. Created: `tests/migrations/storage-drop-legacy-documents.test.ts`.
**Outcome:** Success — `npm run build` clean; `npx vitest run tests/providers/storage tests/migrations` → 5 files / 51 tests green (including the 3 new ones).
**Notes:** Chose Path A (add to the existing storage migration set) over Path B (new file under `src/migrations/`) because the `documents` table is owned by `src/providers/storage/migrations.ts`, and piggybacking on the existing `storage_migration` tracking table avoids spinning up yet another tracking table for a one-shot cleanup. Execution order guaranteed by alphanumeric key sort — `storage_008_*` runs after `storage_007_*` regardless of file position.

## [2026-04-17 18:22] — Phase 7 Task 5: Clean up skills prompt module + tool-catalog filter

**Task:** Remove residual install-intent prompt artifacts — `detectSkillInstallIntent`, the four regex constants (`INSTALL_ACTIONS`, `SKILL_NOUNS`, `INQUIRY_PATTERNS`, `REGISTRY_REF`), the "Installing New Skills" prompt block, and `skillInstallEnabled` across `PromptContext`, `ToolFilterContext`, and all callers.
**What I did:** Rewrote `src/agent/prompt/modules/skills.ts` to the clean version from the plan (drops the four regex constants, `detectSkillInstallIntent`, and the install-instructions block; keeps available-skills + no-skills + Creating Skills + renderMinimal paths). Removed `skillInstallEnabled?: boolean` from `src/agent/prompt/types.ts` (`PromptContext`). Removed the flag from `src/agent/tool-catalog.ts` (`ToolFilterContext`). In `src/agent/agent-setup.ts` dropped the `detectSkillInstallIntent` import, the intent-detection block, and both write sites (`skillInstallEnabled` in PromptBuilder.build args + in the `toolFilter` return). Updated tests: replaced the entire `detectSkillInstallIntent` describe + three `skillInstallEnabled`-gated cases in `tests/agent/prompt/modules/skills.test.ts` with a slim SkillsModule suite; stripped the flag from filter objects in `tests/agent/mcp-server.test.ts` (2), `tests/agent/ipc-tools.test.ts` (2), and the `ALL_FLAGS`/`NO_FLAGS`/variant-filter test in `tests/agent/tool-catalog.test.ts`. Also trimmed a stale `detectSkillInstallIntent` bullet in `.claude/skills/ax-provider-skills/SKILL.md` to reflect the current prompt shape.
**Files touched:** Modified: `src/agent/prompt/modules/skills.ts`, `src/agent/prompt/types.ts`, `src/agent/tool-catalog.ts`, `src/agent/agent-setup.ts`, `tests/agent/prompt/modules/skills.test.ts`, `tests/agent/mcp-server.test.ts`, `tests/agent/ipc-tools.test.ts`, `tests/agent/tool-catalog.test.ts`, `.claude/skills/ax-provider-skills/SKILL.md`.
**Outcome:** Success — `npm run build` clean; targeted tests green (19 files / 160 tests across `tests/agent/prompt`, `tool-catalog`, `mcp-server`, `ipc-tools`, `agent-setup`). Exit grep for the six terms is zero across `src/` and `tests/`.
**Notes:** `hasWorkspace`-gated Creating Skills block stays (correct for the git-native flow). Remaining hits for these symbols live only in append-only journal/lessons entries and the task plan doc, which is expected.

## [2026-04-17 18:05] — Phase 7 Task 4: Drop CLI plugin+mcp + admin plugin endpoints

**Task:** Delete `ax plugin` and `ax mcp` CLI commands plus the 410-stubbed admin plugin routes from Task 3. Drop the admin UI Plugins tab + API surface.
**What I did:** `git rm`'d `src/cli/plugin.ts` and `src/cli/mcp.ts`. Stripped `plugin`/`mcp` from `src/cli/index.ts` (handler interface, switch cases, `knownCommands` set, dynamic imports, help text). Deleted the 410-stub plugin routes from `src/host/server-admin.ts` (lines ~941-956). Kept `mcpManager` on AdminDeps + `server-webhook-admin.ts` — still used by `/admin/api/mcp-servers` POST/PUT/DELETE routes (lines 551, 572, 579, 597) to sync the in-memory MCP manager with DB changes. Admin UI: removed `PluginsSection` component, the `plugins` SectionId + nav entry, `Puzzle`/`Package` icon imports, `InstalledPlugin` type import, and the `activeSection === 'plugins'` render branch from `ui/admin/src/components/pages/agents-page.tsx`. Removed `agentPlugins`/`installPlugin`/`uninstallPlugin` methods from `ui/admin/src/lib/api.ts` and the `InstalledPlugin` interface from `ui/admin/src/lib/types.ts`.
**Files touched:** Deleted: `src/cli/plugin.ts`, `src/cli/mcp.ts`. Modified: `src/cli/index.ts`, `src/host/server-admin.ts`, `ui/admin/src/components/pages/agents-page.tsx`, `ui/admin/src/lib/api.ts`, `ui/admin/src/lib/types.ts`.
**Outcome:** Success — `npm run build` clean; targeted tests green (`tests/host/server-admin*` + `tests/cli/*`: 10 files/136 tests). No admin-plugin tests existed, so nothing to remove there.
**Notes:** `mcpManager` stays on AdminDeps — it's used by the global MCP server admin routes, not the (now-deleted) plugin routes. `src/host/ipc-server.ts` still imports `createPluginHandlers` from `./ipc-handlers/plugin.js` — that's a separate IPC handler module, not the CLI file, and is outside Task 4 scope.

## [2026-04-17 17:44] — Phase 7 Task 3: Strip legacy plugin machinery (keep MCP manager)

**Task:** Remove the plugin-manifest install pipeline (fetcher/install/parser/store/types) while keeping `mcp-manager`, `mcp-client`, and `loadDatabaseMcpServers` — phase-4 MCP wiring still depends on those.
**What I did:** `git rm`'d `src/plugins/{fetcher,install,parser,store,types}.ts` plus `tests/plugins/{fetcher,parser,store}.test.ts`. Rewrote `src/plugins/startup.ts` to a ~55-line module exporting only `loadDatabaseMcpServers` (dropped `reloadPluginMcpServers`, `autoInstallDeclaredPlugins`, and imports of the removed modules). Updated `src/host/server-init.ts` import to a single `loadDatabaseMcpServers` and removed the `reloadPluginMcpServers` call site. Inlined `PluginMcpServer` into `src/plugins/mcp-manager.ts` (formerly imported from `types.ts`). Trimmed `tests/plugins/startup.test.ts` to keep only the three `loadDatabaseMcpServers` cases. Stubbed Task-4 scope so build stays green: `src/cli/plugin.ts` now exports a single `runPlugin` that prints a retirement notice and exits 1; plugin list/install/uninstall routes in `src/host/server-admin.ts` collapse to a single 410 response with a `TODO(phase7-task4)` marker. Both stubs carry `TODO(phase7-task4)` so the next task knows what to delete.
**Files touched:** Deleted: `src/plugins/fetcher.ts`, `src/plugins/install.ts`, `src/plugins/parser.ts`, `src/plugins/store.ts`, `src/plugins/types.ts`, `tests/plugins/fetcher.test.ts`, `tests/plugins/parser.test.ts`, `tests/plugins/store.test.ts`. Modified: `src/plugins/startup.ts`, `src/plugins/mcp-manager.ts`, `src/host/server-init.ts`, `src/host/server-admin.ts`, `src/cli/plugin.ts`, `tests/plugins/startup.test.ts`.
**Outcome:** Success — `npm run build` clean; targeted tests green (`tests/plugins`: 4 files/28 tests; `tests/host/server-admin`: 36 tests). The 29 macOS EINVAL socket failures in `tests/host/server.test.ts` are pre-existing (long-path Unix socket issue, unrelated).
**Notes:** `server-admin.ts`'s plugin routes and `cli/plugin.ts` still exist as stubs because their static/dynamic imports of deleted modules would have broken the build. Task 4 deletes them outright. `mcp-manager.ts` kept its public `PluginMcpServer` export (renamed doc comment, same shape) — used by inprocess, server-completions, mcp-applier, and the DB MCP provider.

## [2026-04-17 17:30] — Phase 7 Task 2: Delete ClawHub registry + legacy skill DocumentStore

**Task:** Remove the ClawHub registry client and the DocumentStore-backed skill storage module, now that skills are authored git-natively and phase 3+ state-store handles reconciliation.
**What I did:** `git rm`'d `src/clawhub/registry-client.ts`, `tests/clawhub/registry-client.test.ts`, `src/providers/storage/skills.ts`, `tests/providers/storage/skills.test.ts`, `tests/e2e/mock-server/clawhub.ts`, and two dependent tests (`tests/host/ipc-handlers/skills-crud.test.ts`, `tests/plugins/install.test.ts`). Rewired e2e mock server to drop the ClawHub route. Removed `CLAWHUB_API_URL` env var from `tests/e2e/global-setup.ts` and `tests/e2e/kind-values.yaml`. Stripped the DB-stored-skill domain-allowlist block from `src/host/server-init.ts` (git-native block below already handles it). Removed PUT/DELETE admin skill endpoints and the DocumentStore-backed plugin-skill list augmentation from `src/host/server-admin.ts`. Neutered `src/plugins/install.ts` skill storage (file is deleted in Task 3; this keeps Task 3's structure intact while unblocking the build). Trimmed `skill_install/update/delete` from `src/utils/manifest-generator.ts` IPC_TOOLS list. Surgical edits to remove "clawhub" string mentions in `src/agent/prompt/modules/skills.ts`, prompt tests, and a stale doc comment in `src/plugins/store.ts`. Deleted the `skills endpoint returns 500 when provider fails` test — the endpoint no longer depends on the failing provider.
**Files touched:** Deleted: `src/clawhub/registry-client.ts`, `tests/clawhub/registry-client.test.ts`, `src/providers/storage/skills.ts`, `tests/providers/storage/skills.test.ts`, `tests/e2e/mock-server/clawhub.ts`, `tests/host/ipc-handlers/skills-crud.test.ts`, `tests/plugins/install.test.ts`. Modified: `tests/e2e/mock-server/index.ts`, `tests/e2e/global-setup.ts`, `tests/e2e/kind-values.yaml`, `tests/host/post-agent-credential-detection.test.ts`, `tests/host/server-admin.test.ts`, `tests/agent/prompt/builder.test.ts`, `tests/agent/prompt/modules/skills.test.ts`, `src/host/server-init.ts`, `src/host/server-admin.ts`, `src/plugins/install.ts`, `src/plugins/store.ts`, `src/agent/prompt/modules/skills.ts`, `src/utils/manifest-generator.ts`.
**Outcome:** Success — build clean; targeted tests (`tests/e2e`, `tests/providers/storage`, `tests/host/server-admin`, `tests/host/server-init`, `tests/host/post-agent-credential-detection`, `tests/plugins`, `tests/agent/prompt`) all green. Exit criteria met: `rg "clawhub|providers/storage/skills"` returns zero hits in `src/` and `tests/`.
**Notes:** Task 2's plan assumed no live importers remained after Task 1, but `server-init.ts`, `server-admin.ts`, and `plugins/install.ts` still pulled from `providers/storage/skills.js`. Cleaned them minimally — `install.ts` loses its skill-storage branch but retains plugin/command/MCP handling (Task 3 will delete the file outright). `skill-format-parser.ts` and `manifest-generator.ts` stay: both are still used by git-native seed parsing and `proxy-domain-list`.

## [2026-04-17 17:13] — Phase 7 Task 1: Remove skill IPC + agent tool

**Task:** Delete skill_install/skill_create/skill_update/skill_delete IPC actions plus the `skill` agent tool, now that skills are authored git-natively under `.ax/skills/`.
**What I did:** Removed 4 schema declarations from `src/ipc-schemas.ts`. Rewrote `src/host/ipc-handlers/skills.ts` to keep only `skills_index`, `audit_query`, and `credential_request` — dropped clawhub/manifest-generator/skill-format-parser/storage.skills/server-admin-helpers imports. Trimmed `SkillsHandlerOptions` to `requestedCredentials`, `eventBus`, `stateStore`. Removed the skill tool block + `category: 'skill'` from tool-catalog.ts and mcp-server.ts, dropped `stripSkillInstall`, simplified `filterTools`. Deleted `tests/host/ipc-handlers/skills.test.ts`, edited related tests (tool counts 15→14, remove skill assertions). Touched stale `skill_install` comments in web-proxy.ts and ipc-server.ts.
**Files touched:** `src/ipc-schemas.ts`, `src/host/ipc-handlers/skills.ts`, `src/host/ipc-server.ts`, `src/host/web-proxy.ts`, `src/agent/tool-catalog.ts`, `src/agent/mcp-server.ts`, `tests/host/ipc-handlers/skills.test.ts` (deleted), `tests/host/post-agent-credential-detection.test.ts`, `tests/agent/tool-catalog.test.ts`, `tests/agent/mcp-server.test.ts`, `tests/agent/ipc-tools.test.ts`.
**Outcome:** Success — build clean, 155/155 targeted tests pass. Remaining `skill_*` references in `utils/manifest-generator.ts` and `integration/cross-component.test.ts` are slated for Tasks 2 and 7.
**Notes:** `IPCHandlerOptions.domainList` / `adminCtx` remain (other subsystems still use them) but no longer reach the skills handler.

## [2026-04-15 12:40] — Remove old identity system (Tasks 5-12 of git-identity plan)

**Task:** Remove database-backed identity IPC schemas, handlers, tools, and governance system; simplify identity-loader; update prompt modules to use git-based identity evolution; seed .ax/ directory in workspace init
**What I did:**
- Removed 13 IPC schemas (identity, company identity, governance, agent registry) from ipc-schemas.ts
- Deleted 3 handler files: identity.ts, governance.ts, company.ts (and their test files)
- Removed identity and governance tools from tool-catalog.ts, mcp-server.ts, pi-session.ts
- Removed normalizeOrigin, normalizeIdentityFile, TOOLS_WITH_ORIGIN, GOVERNANCE_ACTIONS
- Simplified identity-loader.ts to just unpack preloaded payload (no filesystem fallback)
- Removed `user` field from IdentityFiles and IdentityPayload (USER.md dropped)
- Rewrote identity prompt module evolution guidance for git-based workflow
- Removed loadIdentityFromDB and IDENTITY_FILE_MAP from server-completions.ts
- Added seedAxDirectory() function and calls after hostGitSync
- Updated k8s git-init to create .ax/ directories
- Removed proposalsDir from paths.ts, identity_write/user_write from taint budget sensitive actions
- Updated 20+ test files, deleted 4 test files
**Files touched:** src/ipc-schemas.ts, src/host/ipc-server.ts, src/host/server-completions.ts, src/host/server-init.ts, src/host/taint-budget.ts, src/agent/tool-catalog.ts, src/agent/mcp-server.ts, src/agent/identity-loader.ts, src/agent/agent-setup.ts, src/agent/runner.ts, src/agent/ipc-tools.ts, src/agent/runners/pi-session.ts, src/agent/prompt/types.ts, src/agent/prompt/modules/identity.ts, src/agent/prompt/modules/runtime.ts, src/agent/prompt/modules/security.ts, src/providers/sandbox/k8s.ts, src/paths.ts, and 20+ test files
**Outcome:** Success — build passes, all test failures are pre-existing socket path issues
**Notes:** The 5 remaining test failures (server.test.ts, smoke.test.ts, etc.) are EINVAL socket path length errors on macOS — pre-existing, not caused by these changes

## [2026-04-14 06:20] — Replace ClawHub filesystem cache with in-memory cache

**Task:** Remove filesystem cache from ClawHub registry client (part of removing ~/.ax/cache/ directory)
**What I did:** Replaced `cacheDir()`, `ensureCacheDir()`, and fs-based `readCached()`/`writeCache()` with a module-level `Map<string, { data: string; timestamp: number }>`. Removed imports of `mkdir`, `readFile`, `writeFile`, `readdir`, `stat`, `safePath`, `axHome`, and `join`. Made `readCached` synchronous. Updated `listCached()` to query the Map. Updated test to remove AX_HOME temp dir setup and afterAll cleanup.
**Files touched:** `src/clawhub/registry-client.ts`, `tests/clawhub/registry-client.test.ts`
**Outcome:** Success — all 11 tests pass
**Notes:** The in-memory cache has same 1-hour TTL semantics. Cache is per-process and resets on restart, which is acceptable for this use case.

## [2026-04-14 00:00] — Move MITM CA from agents/ to data/ directory

**Task:** Task 6 of plan to remove ~/.ax/agents/ directory — move MITM CA directory from per-agent path to shared data directory
**What I did:** Changed `const caDir = join(agentDir(agentId), 'ca')` to `const caDir = join(dataDir(), 'ca')` in server-completions.ts line 820. Removed unused `agentDir` from the import statement.
**Files touched:** `src/host/server-completions.ts`
**Outcome:** Success. Build compiles cleanly (pre-existing tsc errors in clawhub unrelated).
**Notes:** The CA is now shared across all agents at `~/.ax/data/ca/` instead of per-agent at `~/.ax/agents/{id}/ca/`.

## [2026-04-06 14:00] — PVC Workspace Phase 2: Update host and agent code for single workspace

**Task:** Fix all host-side and agent-side code to use the single /workspace model (Phase 1 simplified sandbox providers)
**What I did:** Removed agentWorkspace/userWorkspace/workspaceProvider/agentReadOnly from AgentConfig and StdinPayload. Updated applyPayload() to write skills to /workspace/skills/ and MCP CLIs to /workspace/bin/. Merged agent-scoped and user-scoped skills into single array in server-completions.ts. Removed enterprise workspace setup (agentWsPath/userWsPath/mkdir). Updated sandboxConfig to use pvcName instead of agentWorkspace/userWorkspace. Updated agent-setup.ts scanMcpCLIs() and buildSystemPrompt() to use config.workspace. Updated PromptContext (hasWorkspace replaces hasAgentWorkspace/hasUserWorkspace/userWorkspaceWritable). Updated RuntimeModule and SkillsModule. Updated both runners (pi-session, claude-code) for single workspace skill deps. Fixed 30 test failures across 8 test files.
**Files touched:** src/host/server-completions.ts, src/agent/runner.ts, src/agent/agent-setup.ts, src/agent/prompt/types.ts, src/agent/prompt/modules/skills.ts, src/agent/prompt/modules/runtime.ts, src/agent/runners/pi-session.ts, src/agent/runners/claude-code.ts, src/paths.ts, src/agent/skill-installer.ts, src/host/capnweb/generate-and-cache.ts, src/host/capnweb/codegen.ts, tests/sandbox-isolation.test.ts, tests/agent/prompt/modules/skills.test.ts, tests/agent/prompt/modules/runtime.test.ts, tests/providers/sandbox/canonical-paths.test.ts, tests/agent/agent-setup.test.ts
**Outcome:** Success — build zero errors, 2584 tests pass (2 pre-existing flaky integration failures unrelated to changes)
**Notes:** paths.ts functions agentWorkspaceDir/userWorkspaceDir marked deprecated but kept for backward compat in host-side file storage (server-files.ts, server-channels.ts, llm handler).

## [2026-04-06 12:00] — PVC Workspace Phase 1: Simplify workspace model + PVC support

**Task:** Replace agent/user workspace split with single /workspace per agent, add PVC support to k8s sandbox provider
**What I did:** Removed agentWorkspace/userWorkspace/agentWorkspaceWritable/userWorkspaceWritable from SandboxConfig, added pvcName. Simplified CANONICAL to just {root: '/workspace'}. Simplified canonicalEnv() to remove agent/user env vars, always prepend /workspace/bin to PATH. Simplified createCanonicalSymlinks() to a pass-through. Removed symlinkEnv(). Updated Docker/Apple providers to mount single /workspace (rw). Removed workspaceLocation from SandboxProvider interface. Added ensurePvc() and deletePvc() to k8s provider, with PVC-backed volumes when pvcName is set.
**Files touched:** src/providers/sandbox/types.ts, src/providers/sandbox/canonical-paths.ts, src/providers/sandbox/docker.ts, src/providers/sandbox/apple.ts, src/providers/sandbox/k8s.ts
**Outcome:** Success — sandbox provider files compile cleanly. One expected downstream error in server-completions.ts (Phase 2 fix).
**Notes:** The build has 1 error in server-completions.ts referencing removed agentWorkspace field — intentionally left for Phase 2.

## [2026-04-06 06:30] — Phase 7: Final verification, docs, skills cleanup

**Task:** Final cleanup pass for architecture simplification — verify build/tests, update all docs and skills to reflect removed features (browser, image, workspace, NATS, subprocess, pool controller, scanner/screener split, catalog)
**What I did:** Verified build passes (zero errors) and tests pass (5 pre-existing failures unrelated to simplification). Updated README.md, ax-prp.md, ax-architecture-doc.md, docs/web/index.html, and 7 skill files (ax, ax-config, ax-provider-sandbox, ax-provider-eventbus, ax-security, ax-host). Removed browser/image/workspace/NATS/subprocess/pool-controller/screener references. Updated provider count from 18 to 15. Verified provider-map.ts and ipc-schemas.ts are clean. Confirmed test references to "browser", "screener", "scanner", "catalog", "subprocess", "nats" are all legitimate (test fixtures, security provider tests, tool-catalog, etc.), not dangling references.
**Files touched:** README.md, docs/plans/ax-prp.md, docs/plans/ax-architecture-doc.md, docs/web/index.html, .claude/skills/ax/SKILL.md, .claude/skills/ax-config/SKILL.md, .claude/skills/ax-provider-sandbox/SKILL.md, .claude/skills/ax-provider-eventbus/SKILL.md
**Outcome:** Success — all docs and skills now accurately reflect the 15-category architecture
**Notes:** 5 pre-existing test failures (3 timeouts, 1 docker image pull, 1 assertion) are not related to the simplification.

## [2026-04-06 05:10] — Phase 5: Host cleanup — heartbeat, event store, file registry, CLI dead code

**Task:** Remove heartbeat monitor, event store, file-based agent registry, and CLI dead code
**What I did:**
- Task 5.1: Deleted heartbeat-monitor.ts and test. Removed HeartbeatMonitor from orchestrator (instantiation, heartbeat field, recordActivity call, shutdown unsub). Removed HeartbeatMonitorConfig from types.ts. Fixed delegation-hardening test.
- Task 5.2: Deleted event-store.ts, orchestration migrations, and tests. Removed OrchestrationEventStore from orchestrator and types.ts. Removed agent_orch_timeline IPC schema and handler. Updated cross-component and tool-catalog-sync tests.
- Task 5.3: Removed FileAgentRegistry class. Made DatabaseAgentRegistry dialect-aware (SQLite + PostgreSQL). Added createSqliteRegistry() convenience factory. Updated createAgentRegistry() factory to always use database. Updated 6 test files from FileAgentRegistry to createSqliteRegistry.
- Task 5.4: Deleted unused src/cli/utils/commands.ts REPL parser. Removed warm pool tier selection and minReady/maxReady from k8s init wizard.
**Files touched:**
- Deleted: src/host/orchestration/heartbeat-monitor.ts, src/host/orchestration/event-store.ts, src/migrations/orchestration.ts, src/cli/utils/commands.ts, + 3 test files
- Modified: orchestrator.ts, types.ts (orch), ipc-schemas.ts, orchestration IPC handler, governance IPC handler, agent-registry.ts, agent-registry-db.ts, ipc-server.ts, k8s-init.ts, + 8 test files
**Outcome:** Success. Build passes. 2600 tests pass (4 pre-existing failures in admin-gate, server, smoke tests).
**Notes:** SQLite DEFAULT expression requires outer parens: `(datetime('now'))` not `datetime('now')`. FileAgentRegistry tests needed `async beforeEach` since DatabaseAgentRegistry.register() is truly async.

## [2026-04-06 01:15] — Phase 4: Remove catalog, cowork-plugins, simplify plugin install

**Task:** Execute Phase 4 of architecture simplification: remove catalog system, remove cowork-plugins IPC handler, simplify plugin install to GitHub-based
**What I did:**
- Task 4.1: Deleted catalog-store.ts, ipc-handlers/catalog.ts, and their tests. Removed 5 catalog IPC schemas and handler registration from ipc-server.ts. Updated tool-catalog-sync test.
- Task 4.2: Deleted ipc-handlers/cowork-plugins.ts and test. Removed 3 cowork IPC schemas and handler registration. Removed coworkPlugins option from IPCHandlerOptions. Updated cross-component test and removed Cowork branding from comments in 6 files.
- Task 4.3: Added shared?: boolean to InstalledPlugin and PluginUpsertInput. Added --shared CLI flag. Updated CLI help to emphasize GitHub sources. Updated test fixtures from cowork: to GitHub-style sources.
**Files touched:** src/host/catalog-store.ts (deleted), src/host/ipc-handlers/catalog.ts (deleted), src/host/ipc-handlers/cowork-plugins.ts (deleted), src/ipc-schemas.ts, src/host/ipc-server.ts, src/host/server-init.ts, src/host/server-completions.ts, src/host/inprocess.ts, src/host/server-admin.ts, src/host/registry.ts, src/plugins/types.ts, src/plugins/store.ts, src/plugins/install.ts, src/cli/plugin.ts, src/cli/index.ts, tests/agent/tool-catalog-sync.test.ts, tests/integration/cross-component.test.ts, tests/plugins/store.test.ts, plus 4 deleted test files
**Outcome:** Success — build passes, 229/231 test files pass (2 pre-existing Docker-dependent failures)
**Notes:** The admin REST plugin routes in server-admin.ts were kept since they use plugins/install directly (not the cowork IPC handler). The fetcher already handled GitHub well with local path for dev.

## [2026-04-06 00:40] — Phase 3.2: credentials provider review — no simplification needed

**Task:** Review credentials provider implementations for redundancy
**What I did:** Read all 3 implementations (plaintext, keychain, database) and assessed whether any could be removed
**Files touched:** None — all implementations are reasonable
**Outcome:** No changes. Each variant serves a distinct use case: plaintext for file-based local dev, keychain for OS-level secure storage, database for K8s/PostgreSQL deployments. Config already auto-promotes from keychain to database for container sandboxes.
**Notes:** The `env` provider was already removed in a prior phase; `keychain` falls back to plaintext when keytar is unavailable.

## [2026-04-06 00:30] — Phase 3.1: merge scanner + screener into unified security provider

**Task:** Merge ScannerProvider and SkillScreenerProvider into a single SecurityProvider interface
**What I did:**
1. Created `src/providers/security/` with types.ts, patterns.ts, guardian.ts, none.ts — each implementing the unified SecurityProvider interface (scanner + screener methods)
2. Updated provider-map.ts: replaced `scanner:` and `screener:` entries with `security: { patterns, guardian, none }`
3. Updated types.ts: replaced `scanner: ScannerProvider` and `screener?: SkillScreenerProvider` with `security: SecurityProvider` in both Config and ProviderRegistry
4. Updated config.ts: replaced `providers.scanner` and `providers.screener` Zod schemas with `providers.security`
5. Updated registry.ts: replaced loadScanner with loadSecurity, removed screener loading
6. Updated all 20+ YAML config files (ax.yaml, helm values, flux, test fixtures, e2e, ui dev configs)
7. Updated all source references: router.ts, governance.ts, identity.ts, provider-sdk, skills/types.ts, onboarding
8. Moved tests to tests/providers/security/, updated 15+ test files with mock provider changes
9. Deleted old directories: src/providers/scanner/, src/providers/screener/, and their skills
**Files touched:** 50+ files across src/, tests/, charts/, flux/, ui/
**Outcome:** Success — build passes, all test failures are pre-existing (server.test.ts, smoke.test.ts)
**Notes:** The unified SecurityProvider has all scanner methods (scanInput, scanOutput, canaryToken, checkCanary) plus all screener methods (screen, screenExtended, screenBatch). Guardian variant uses no-op screener methods; patterns variant has full implementations of both.

## [2026-04-06 00:00] — Phase 2 architecture simplification: remove pool controller, NATS, subprocess sandbox

**Task:** Remove unused infrastructure subsystems as Phase 2 of AX architecture simplification
**What I did:** Executed 3 sequential tasks:
1. Removed pool controller: deleted src/pool-controller/ (4 files) and tests/pool-controller/ (4 files), removed poolController config from Helm values, kind-dev-values, flux HelmReleases, NOTES.txt, and host deployment template.
2. Removed NATS: deleted src/utils/nats.ts, src/providers/eventbus/nats.ts, tests/utils/nats.test.ts, and 4 NATS-related test harness files. Removed nats from provider-map and package.json. Updated all NATS comments across 12+ source files. Switched flux and e2e configs from eventbus: nats to eventbus: postgres.
3. Removed subprocess sandbox: deleted src/providers/sandbox/subprocess.ts and its test. Changed default sandboxType from 'subprocess' to 'docker' in runner.ts, agent-setup.ts, setup-server.ts. Updated 53 files total (27 test files, 5 YAML fixtures, source comments).
**Files touched:** 97 files modified/deleted across 3 commits
**Outcome:** Success — build passes, 2676/2680 tests pass (4 failures are pre-existing flaky tests unrelated to changes)
**Notes:** The subprocess references in claude-code.ts, tcp-bridge.ts, bin-exists.ts etc. are about generic CLI subprocesses, not the sandbox provider — correctly left in place.

## [2026-03-24 12:55] — Fix CI: bump pi-ai to match pi-agent-core/pi-coding-agent

**Task:** Fix failing GitHub Actions test job on PR #117 (dependabot production dep bump)
**What I did:** The dependabot PR bumped pi-agent-core and pi-coding-agent to ^0.61.1 but left pi-ai at ^0.58.1. The newer packages depend on pi-ai@^0.61.1 internally, creating nested duplicate copies with incompatible AssistantMessageEventStream types (private property 'isComplete' mismatch). Bumped pi-ai to ^0.61.1 in package.json to deduplicate.
**Files touched:** package.json, package-lock.json
**Outcome:** Success — tsc --noEmit passes, all 225 test files (2554 tests) pass, fuzz tests pass
**Notes:** Dependabot doesn't always catch transitive peer alignment. When pi-* packages are bumped together, pi-ai must be bumped to the same version family.

## [2026-03-20 08:40] — Phase 2: createRequestHandler() shared route factory

**Task:** Extract remaining duplicated HTTP route dispatch from server-local.ts and server-k8s.ts into a shared createRequestHandler() factory
**What I did:** (1) Added createRequestHandler() factory to server-request-handlers.ts with all shared routes (CORS, health, models, completions, files, SSE events, webhooks, credentials, OAuth, admin, root redirect, 404) plus hooks for extraRoutes and graceful drain. (2) Rewrote server-local.ts to use createRequestHandler() -- replaced ~160-line inline handleRequest. (3) Rewrote server-k8s.ts to use createRequestHandler() with handleInternalRoutes for /internal/* routes. (4) Removed inline NATS SSE handler from k8s (NATS eventbus provider already bridges events to EventBus). (5) Added graceful drain tracking to k8s shutdown. (6) Cleaned up unused imports.
**Files touched:** src/host/server-request-handlers.ts, src/host/server-local.ts, src/host/server-k8s.ts
**Outcome:** Success — all 215 test files pass (2473 tests), build clean. server-local.ts dropped 188 lines, server-k8s.ts dropped 90 net lines. Both servers now gain file routes, OAuth, credentials, bootstrap gate, and root redirect from the shared handler.
**Notes:** Key discovery: NATS eventbus provider (src/providers/eventbus/nats.ts) already implements the full EventBus interface by subscribing to NATS subjects and dispatching to listeners. The inline NATS SSE handler in server-k8s.ts was redundant with the shared handleEventsSSE that uses EventBus.subscribe/subscribeRequest. Server-k8s.ts was previously missing: file upload/download, OAuth callback, bootstrap gate pre-flight, root->admin redirect, and graceful drain.

## [2026-03-20 08:05] — Rename server.ts to server-local.ts, host-process.ts to server-k8s.ts

**Task:** Rename server entry points to reflect their semantic role (local vs k8s) and update all imports across the codebase
**What I did:** Used `git mv` for both renames. Updated imports in 8 source/test files (cli/index.ts, cli/reload.ts, 4 test files, 2 test harnesses). Updated Dockerfile CMD, Helm chart commands (values.yaml, kind-dev-values.yaml), k8s archive YAML. Fixed 3 test files that read source by filename (sandbox-isolation, workspace-provision-fixes, gcs-remote-transport). Updated 5 skill files (ax-host, ax-debug, ax-provider-credentials, ax-provider-sandbox, acceptance-test). Updated internal comments in server-k8s.ts and server-init.ts.
**Files touched:** src/host/server.ts (renamed), src/host/host-process.ts (renamed), src/cli/index.ts, src/cli/reload.ts, tests/host/server.test.ts, tests/host/server-multimodal.test.ts, tests/host/server-history.test.ts, tests/host/admin-gate.test.ts, tests/e2e/server-harness.ts, tests/providers/sandbox/run-nats-local.ts, tests/sandbox-isolation.test.ts, tests/agent/workspace-provision-fixes.test.ts, tests/providers/workspace/gcs-remote-transport.test.ts, container/agent/Dockerfile, charts/ax/values.yaml, charts/ax/kind-dev-values.yaml, k8s/archive/host.yaml, src/host/server-init.ts, .claude/skills/ax-host/SKILL.md, .claude/skills/ax-debug/SKILL.md, .claude/skills/ax-provider-credentials/SKILL.md, .claude/skills/ax-provider-sandbox/SKILL.md, .claude/skills/acceptance-test/SKILL.md
**Outcome:** Success — `npx tsc --noEmit` clean, all 215 test files pass (2473 tests)
**Notes:** Source-reading tests (sandbox-isolation, gcs-remote-transport, workspace-provision-fixes) reference filenames as string literals to readFileSync, not as imports. These needed manual updates beyond grep for import patterns. Historical acceptance test results/plans/lessons left as-is per append-only policy.

## [2026-03-20 08:00] — Server init extraction: deduplicate server.ts and host-process.ts

**Task:** Extract ~700 lines of duplicated initialization, request handling, and lifecycle code from server.ts and host-process.ts into shared modules
**What I did:** Created 4 new shared modules and rewrote both server.ts and host-process.ts to use them:
- `server-admin-helpers.ts` — pure admin functions (isAdmin, claimBootstrapAdmin, etc.)
- `server-init.ts` — `initHostCore()` shared initialization (storage, routing, IPC, templates, orchestrator)
- `server-request-handlers.ts` — shared HTTP handlers (completions, events SSE, scheduler callback, models)
- `server-webhook-admin.ts` — shared webhook + admin handler factories
**Files touched:** Created: src/host/server-admin-helpers.ts, src/host/server-init.ts, src/host/server-request-handlers.ts, src/host/server-webhook-admin.ts. Modified: src/host/server.ts, src/host/host-process.ts, src/host/server-completions.ts, src/host/ipc-handlers/identity.ts, src/host/ipc-handlers/governance.ts
**Outcome:** Success — all 215 test files pass (2473 tests), build clean. server.ts shrank from ~1250 to ~500 lines, host-process.ts from ~1248 to ~630 lines.
**Notes:** Key pattern: shared `runCompletion` callback lets server.ts pass `processCompletion` directly while host-process.ts wraps with `processCompletionWithNATS`. Legacy migration and USER_BOOTSTRAP filesystem copy kept as server.ts-specific post-init steps. NATS-based SSE events kept in host-process.ts since they use a fundamentally different subscription mechanism.

## [2026-03-13 09:15] — Phase 2: Drop file-based StorageProvider

**Task:** Remove `src/providers/storage/file.ts` and all file-based storage code; make database storage the only option.
**What I did:** (1) Deleted `src/providers/storage/file.ts` and `tests/providers/storage/file.test.ts`. (2) Removed 'file' from storage provider map in `src/host/provider-map.ts`. (3) Changed storage default from 'file' to 'database' and database default from undefined to 'sqlite' in `src/config.ts`. (4) Added legacy file-storage directory warning in `src/providers/storage/database.ts`. (5) Updated `tests/integration/history-smoke.test.ts` to check for SQLite DB file instead of JSONL conversation files. (6) Updated acceptance fixture, README, skill files, and paths.ts comments.
**Files touched:** `src/providers/storage/file.ts` (deleted), `tests/providers/storage/file.test.ts` (deleted), `src/host/provider-map.ts`, `src/config.ts`, `src/providers/storage/database.ts`, `src/paths.ts`, `tests/integration/history-smoke.test.ts`, `tests/acceptance/fixtures/ax.yaml`, `README.md`, `.claude/skills/ax/provider-storage/SKILL.md`, `.claude/skills/ax/config/SKILL.md`
**Outcome:** Success — build passes, all 205 test files pass (2378 tests), zero failures.
**Notes:** StorageProviderName type automatically narrows to just 'database' since it's derived from the provider map. The `database` config field now defaults to 'sqlite' so the storage provider always has a database backend available.

## [2026-03-05 20:44] — Rename memoryfs → cortex

**Task:** Rename the "memoryfs" memory provider to "cortex" across the entire codebase
**What I did:** Renamed directories (src, tests, acceptance), updated all type names (MemoryFSItem→CortexItem, MemoryFSConfig→CortexConfig), provider-map registration, config values in 13 YAML files, source file internals (headers, logger, JSDoc), 21+ test files, 4 skill files, and acceptance README. Used 6 parallel agents for efficiency.
**Files touched:** 50+ files across src/, tests/, charts/, flux/, .claude/skills/, ax.yaml
**Outcome:** Success — build passes, all 2325 tests pass, no remaining memoryfs references in src/ or YAML configs. Only 2 intentionally preserved historical skip-test descriptions in phase2.test.ts.
**Notes:** Historical journal/lessons entries left as-is (append-only policy). Acceptance test plan/results/fixes docs under tests/acceptance/cortex/ still reference old name in historical context.

## [2026-03-05 19:25] — Database layer refactoring (14-task plan)

**Task:** Consolidate 10+ standalone SQLite connections into a shared DatabaseProvider factory
**What I did:** Implemented full 14-task plan: (1) Created DatabaseProvider interface + SQLite/PostgreSQL implementations. (2) Created storage/database and storage/file providers. (3) Created audit/database provider. (4) Ported memoryfs ItemsStore and EmbeddingStore to Kysely. (5) Ported JobStore, FileStore, OrchestrationEventStore to shared DB. (6) Removed legacy sqlite/postgresql providers. (7) Extracted content-serialization utils. (8) Deleted dead code (db.ts, session-store.ts, conversation-store.ts, old migrations). (9) Updated 50+ test files and YAML configs.
**Files touched:** ~80 files created/modified/deleted across src/providers/, src/host/, src/utils/, tests/, charts/
**Outcome:** Success — 202 test files pass (2305 tests), only pre-existing k8s mock failure remains
**Notes:** Union return types (`T | Promise<T>`) needed for interfaces supporting both sync MemoryJobStore and async KyselyJobStore. Provider-local migrations pattern (each consumer runs own migrations against shared Kysely) works well.

## [2026-03-03 21:45] — Fix PR #60: production dependency bumps (7 packages)

**Task:** Fix Dependabot PR #60 that bumps 7 production dependencies including 3 major version bumps (ink 5→6, marked 11→17, react 18→19)
**What I did:** (1) Merged dependabot branch into working branch. (2) Fixed `AuthStorage` constructor change in pi-agent-core 0.55.4 — now uses `AuthStorage.create()` factory method instead of `new AuthStorage()`. (3) Rewrote `src/cli/utils/markdown.ts` renderer for marked v17 API — all methods now use token objects instead of positional args, `this.parser.parseInline(tokens)` for inline rendering, and `list()` must manually iterate items via `this.listitem()` instead of `this.parser.parse(token.items)`. (4) React 18→19 and Ink 5→6 required zero code changes.
**Files touched:** `src/agent/runners/pi-session.ts`, `src/cli/utils/markdown.ts`, `package.json`, `package-lock.json`
**Outcome:** Success — build clean, all 208 test files pass (2298 tests)
**Notes:** The marked v17 `list()` renderer cannot pass `token.items` to `this.parser.parse()` because the parser doesn't recognize `list_item` tokens. Must iterate items manually and call `this.listitem(item)` for each.

## [2026-03-01 15:50] — Clean up stale scratch tier references

**Task:** Remove stale "scratch" tier references from tool catalog, MCP server, and runtime prompt after upstream PR removed the scratch tier from IPC schemas
**What I did:** (1) Reverted `.filter(t => t.name !== 'write')` in pi-session.ts so local `write` tool is available for ephemeral `/scratch` writes. (2) Updated 4 tier description strings in tool-catalog.ts from `"agent", "user", or "scratch"` to `"agent" or "user"`. (3) Updated 1 tier description in mcp-server.ts similarly. (4) Renamed runtime prompt section from "Workspace Tiers" to "Workspace" and added `/scratch` ephemeral working directory description. (5) Updated test assertions to match new heading.
**Files touched:** `src/agent/runners/pi-session.ts`, `src/agent/tool-catalog.ts`, `src/agent/mcp-server.ts`, `src/agent/prompt/modules/runtime.ts`, `tests/agent/prompt/enterprise-runtime.test.ts`
**Outcome:** Success — build clean, all 2005 tests pass
**Notes:** The mcp-server.ts file had a stale reference not mentioned in the original plan. Always grep broadly for stale references when cleaning up removed features.
