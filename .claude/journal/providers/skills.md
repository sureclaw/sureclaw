# Providers: Skills

Skills import pipeline, screener, manifest generator, ClawHub client, architecture comparison, install orchestration.

## [2026-04-17 06:10] — Phase 3 Task 4: wire SkillStateStore into IPC handler

**Task:** Phase 3 Task 4 of git-native skills rollout — thread the `SkillStateStore` instance through IPC handler plumbing so the `skills_index` handler (Task 3) gets a live state store instead of the `undefined` fallback. Previously `server.ts:162` created the store *after* `initHostCore()` already built the IPC handler, so the IPC handler never saw it. Goal: single shared `stateStore` reaches `createSkillsHandlers` via `createIPCHandler` → `IPCHandlerOptions`, and `server.ts` reuses the SAME instance for its reconcile-hook wiring.
**What I did:** TDD: wrote `tests/host/ipc-server-stateStore.test.ts` with 2 cases (threaded into handler, empty when not provided) — confirmed 1/2 failing as expected. Added `SkillStateStore` import + `stateStore?` field on `IPCHandlerOptions` in `ipc-server.ts`; passed `stateStore: opts?.stateStore` into `createSkillsHandlers(...)`. Moved migration-creation + `createSkillStateStore(providers.database.db)` from `server.ts` into `initHostCore` in `server-init.ts` (guarded by `if (providers.database)`, dynamic imports inside the guard to match surrounding file style). Added `stateStore?: SkillStateStore` to the `HostCore` interface + the `createIPCHandler(...)` options object + the returned object. In `server.ts`, destructured `stateStore` from `core`, changed the reconcile-hook guard from `if (providers.database)` to `if (stateStore)`, removed the local migration/state-store creation, and removed the now-unused imports (`runMigrations`, `skillsMigrations`, `createSkillStateStore`).
**Files touched:** `src/host/ipc-server.ts`, `src/host/server-init.ts`, `src/host/server.ts`, `tests/host/ipc-server-stateStore.test.ts` (new, 2 tests)
**Outcome:** Success — 2/2 new tests pass, 34/34 related suite tests pass (`skills-index.test.ts`, `skills.test.ts`, `state-store.test.ts`, `e2e-reconcile.test.ts`), `npm run build` clean. `tests/host/` full suite has 29 pre-existing failures (macOS Unix socket path length `EINVAL` — confirmed present on base commit ff48f1ab), not caused by this change.
**Notes:** The `handleIPC` response shape wraps handler returns as `respond({ ok: true, ...result })` (line 296 in `ipc-server.ts`), so the skills_index response is `{ ok: true, skills: [...] }` with skills spread at top level — not wrapped in `{result: ...}`. Adjusted the test assertions accordingly before running. Kept the pre-existing `logger.debug('skills_reconcile_hook_disabled_no_database')` log in the else branch; since `stateStore` is only ever unset when `providers.database` is unset, the log message remains accurate.

## [2026-04-17 06:02] — Phase 3 Task 3: skills_index IPC handler

**Task:** Phase 3 Task 3 of git-native skills rollout — add `skills_index` handler to `createSkillsHandlers` in `src/host/ipc-handlers/skills.ts`. Handler reads from a new optional `stateStore?: SkillStateStore` on `SkillsHandlerOptions` via `stateStore.getStates(ctx.agentId)` and returns `{skills: Array<{name, kind, description?, pendingReasons?}>}`. Falls back to `{skills: []}` when `stateStore` is not wired. Actual wire-up through `ipc-server.ts` + `server.ts` is Task 4 — out of scope here.
**What I did:** TDD: wrote `tests/host/ipc-handlers/skills-index.test.ts` with 4 cases (no-store → empty, scoped read, optional-field omission including not-leaking `error`, unknown-agent → empty). Confirmed all 4 failed with `handlers.skills_index is not a function`. Added `SkillStateStore` import + `stateStore?` field on `SkillsHandlerOptions`. Implemented `skills_index` between `skill_delete` and `audit_query`. Deliberately strips `s.error` from the response shape — prompt builder doesn't need raw parse errors, `kind: 'invalid'` is the signal. No audit log call since this runs every agent turn.
**Files touched:** `src/host/ipc-handlers/skills.ts` (add import, add `stateStore?` option, add handler), `tests/host/ipc-handlers/skills-index.test.ts` (new, 4 tests)
**Outcome:** Success — 4/4 new tests pass, `npm run build` clean, `tests/host/ipc-handlers/` suite 118/118 (10 files) with no regressions.
**Notes:** Used `_req: unknown` (request payload is empty per the Zod schema added in Task 2). Handler skips audit logging because index fetches happen every agent turn and would flood the audit log — read-only internal reads aren't interesting for audit. Building the output object conditionally (only attaching `description` / `pendingReasons` when truthy) preserves the same `'x' in row` semantics `getStates` uses, so downstream consumers can keep that style check working through the IPC boundary.

## [2026-04-17 05:53] — Phase 3 Task 1: SkillStateStore.getStates

**Task:** Phase 3 Task 1 of git-native skills rollout — add `getStates(agentId): Promise<SkillState[]>` to `SkillStateStore`. Phase 3's `skills_index` IPC action needs the full persisted rows (name, kind, description, pendingReasons, error), not just the `Map<name, kind>` that `getPriorStates` returns. TDD order: failing tests, implement, passing tests.
**What I did:** Added `getStates` to the `SkillStateStore` interface (placed next to `getPriorStates` for discoverability) and implemented it on the concrete store. Selects the five relevant columns from `skill_states`, filters by `agent_id`, orders by `skill_name asc`, then maps each row to a `SkillState` — only attaches `description` / `pendingReasons` / `error` when the column is a non-null non-empty string (and the parsed JSON array is non-empty for pending_reasons). Cast the row shape locally so we don't depend on a shared schema type. Tests cover the three required cases: empty agent, round-trip of enabled/pending/invalid preserving optional-field omission, and per-agent scoping.
**Files touched:** `src/host/skills/state-store.ts` (interface + impl), `tests/host/skills/state-store.test.ts` (+3 tests in a new `describe('getStates')` block)
**Outcome:** Success — 16/16 tests in `state-store.test.ts` pass, `npm run build` clean.
**Notes:** Using `expect(row).not.toHaveProperty('pendingReasons')` (vs `toBeUndefined()`) catches the difference between `{pendingReasons: undefined}` and simply not having the key at all — important here because prompt builder code may use `'x' in row` style checks. Kept the row type cast local to this method (same style as `getPriorStates`) rather than introducing a shared `SkillStatesRow` type — premature abstraction for two call sites.

## [2026-04-17 05:15] — PR #176 review-comment fixes: hostname validation, MCP self-conflict dedup, clean event payload

**Task:** Address actionable CodeRabbit comments on phase-1 PR #176 (`design/git-native-skills`) that apply to phase-1 files only (phase-2 file comments deferred to PR #177 branch). Three concrete issues: (1) `domains` accepted arbitrary strings via `z.string().min(1).max(253)` — anything flowing into `approvedDomains.has` / proxy allowlist needed real hostname validation; (2) `McpServerSchema` didn't enforce `mcpServers[].name` uniqueness, so a single skill declaring two entries with the same name hit `computeMcpDesired`'s `existing` branch and emitted a self-conflict event with `skillName` on both sides; (3) transition events for enabled skills carried `{reasons: undefined, error: undefined}` that structured consumers would treat as meaningful-but-empty.
**What I did:** Added a `Hostname` refined Zod type in `frontmatter-schema.ts` — lowercase+trim transform followed by RFC 1035-style regex (labels 1-63, total ≤253, no scheme/path). Added a per-entry `seen` set in `computeMcpDesired` to dedup duplicate names within one skill before the cross-skill merge loop. Rewrote the transition event data object to build conditionally — `{name}` always, `reasons` only when `pendingReasons !== undefined`, `error` only when `error !== undefined`. Also extracted `enabledNameSet(states)` to share the "enabled" predicate between `computeMcpDesired` and `computeProxyAllowlist` (they drifted trivially before), and added a comment clarifying `declaredUrl` (loser) vs `conflictingUrl` (winner) in the `McpConflict` interface.
**Files touched:** `src/host/skills/frontmatter-schema.ts`, `src/host/skills/reconciler.ts`, `tests/host/skills/frontmatter-schema.test.ts` (+3 tests), `tests/host/skills/reconciler-mcp.test.ts` (+1), `tests/host/skills/reconciler-events.test.ts` (+3)
**Outcome:** Success — all 49/49 tests in `tests/host/skills/` pass, `tsc --noEmit` clean, no pre-existing tests broken.
**Notes:** Skipped the larger refactors CodeRabbit flagged (`z.url()` vs `z.string().url()` deprecation, `computeSetupQueue` predicate sharing with `computeSkillStates`) — they're legitimate but touch more surface than warranted for review polish. `computeSetupQueue` refactor in particular would change the phase-1/phase-2 interface and is better done alongside phase-4 MCP wiring. ENV_NAME minimum-2-char was also punted — SCREAMING_SNAKE names are ≥2 by convention.

## [2026-04-16 22:55] — Phase 1 final review fixes: drop unsafe cast, test mcp_conflict event

**Task:** Address two issues from phase-1 final code review on `design/git-native-skills`: (1) unnecessary double-cast `c as unknown as Record<string, unknown>` in `reconcile()` when pushing `skill.mcp_conflict` events — `McpConflict` has only string fields and is trivially assignable; (2) missing integration test that `reconcile()` actually surfaces MCP name conflicts as `skill.mcp_conflict` events (the per-unit `reconciler-mcp.test.ts` only tested `computeMcpDesired`'s `conflicts` array).
**What I did:** Replaced the double-cast with `data: { ...c }` spread — same runtime shape, type-safe without escape hatches. Added a third `it()` to `tests/host/skills/reconcile.test.ts` that builds a two-skill snapshot with the same `mcpName: 'shared'` pointing at different URLs, asserts exactly one `skill.mcp_conflict` event is emitted with the expected `{skillName, mcpName, declaredUrl, conflictingUrl}` payload.
**Files touched:** `src/host/skills/reconciler.ts`, `tests/host/skills/reconcile.test.ts`
**Outcome:** Success — `npx tsc --noEmit` clean, `npx vitest run tests/host/skills/reconcile.test.ts` 3/3 pass, `npx vitest run tests/host/skills/` 42/42 across 8 files.
**Notes:** The spread pattern is the right idiom for object-to-`Record<string, unknown>` coercion when all fields are already primitive — no cast needed, structural typing handles it. The missing event-level test was a real gap: a refactor that forgot to push conflicts onto `events` would have slipped past the per-unit tests.

## [2026-04-16 22:52] — Git-native skills Phase 1 COMPLETE: reconcile() orchestration

**Task:** Phase 1 Task 9 (final) of git-native skills effort — append top-level `reconcile(input: ReconcilerInput): ReconcilerOutput` to `src/host/skills/reconciler.ts`. Composes the 5 named sub-exports (`computeSkillStates`, `computeMcpDesired`, `computeProxyAllowlist`, `computeSetupQueue`, `computeEvents`) and surfaces MCP name-conflicts as `skill.mcp_conflict` events on the event list. Pure function — all effects (actually registering MCP servers, updating the proxy allowlist, posting setup cards, emitting events on the bus) remain with the caller. TDD order: failing integration test, implementation, passing tests.
**What I did:** Merged `ReconcilerInput`/`ReconcilerOutput` into the existing `import type` block and appended `reconcile`. Sequentially invokes `computeSkillStates` → `computeMcpDesired` → `computeProxyAllowlist` → `computeSetupQueue` → `computeEvents`, then pushes `{type: 'skill.mcp_conflict', data: conflict}` for each conflict returned by `computeMcpDesired`. Returns `{skills, desired: {mcpServers, proxyAllowlist}, setupQueue, events}`.
**Files touched:** `src/host/skills/reconciler.ts` (appended `reconcile`), `tests/host/skills/reconcile.test.ts` (new — 2 integration tests)
**Outcome:** Success — 2 new integration tests pass, all 41 tests in `tests/host/skills/` pass across 8 files. Full `npm test` shows 33 pre-existing failures in `tests/host/server*.test.ts` and `tests/integration/*.test.ts` (Unix socket `EINVAL` due to long temp-dir paths + docker image pull failures in CI-adjacent integration tests) — unchanged by this commit.
**Notes:** Phase 1 complete — foundation ready for phase 2 git hook wiring. Phase 2+ callers will: (1) snapshot SKILL.md files under `skills/**/SKILL.md` in the workspace git repo after a push, (2) read current approvals/credentials/MCP state from host stores, (3) call `reconcile`, (4) diff `desired.mcpServers` against `current.registeredMcpServers` to drive registration/deregistration, (5) update the proxy allowlist, (6) surface setup cards for `setupQueue`, (7) emit `events` on the event bus. The reconciler itself has no I/O, no imports beyond types, no global state — fully deterministic and fully testable.

## [2026-04-16 22:47] — Git-native skills Phase 1 Task 8: computeEvents

**Task:** Phase 1 Task 8 of git-native skills effort — append `computeEvents(states, priorStates): Array<{type, data}>` to `src/host/skills/reconciler.ts`. Pure function that diffs freshly-computed skill states against the prior cycle's kind-map and emits dot-namespaced lifecycle events. `skill.installed` fires once on first appearance; `skill.enabled`/`skill.pending`/`skill.invalid` fire on transitions into that kind; `skill.removed` fires when a previously-known skill disappears. TDD order: failing test, implementation, passing test.
**What I did:** Merged `SkillStateKind` into the existing `import type` block and appended `computeEvents`. Walks `states[]` with a `seen` set — for each state, emits `skill.installed` when the name is absent from `priorStates`, and emits the kind-specific event (`skill.enabled`/`skill.pending`/`skill.invalid`) when the prior kind differs from the current kind. Each non-installed event carries `{name, reasons, error}` (reasons/error undefined when not applicable — caller is phase 2+ event bus). Second pass over `priorStates` emits `skill.removed` for any name not in `seen`. Unchanged states emit nothing.
**Files touched:** `src/host/skills/reconciler.ts` (appended), `tests/host/skills/reconciler-events.test.ts` (new)
**Outcome:** Success — 6 new tests pass, all 39 tests in `tests/host/skills/` pass (schema + parser + reconciler-states + reconciler-mcp + reconciler-allowlist + reconciler-setup + reconciler-events).
**Notes:** `skill.installed` is one-shot on first appearance, emitted alongside the kind event on the same cycle (two events: installed + enabled/pending/invalid). Transition detection uses `prior !== s.kind` which correctly fires on first-appearance too (prior is `undefined`). Caller (phase 2+ reconcile orchestration) feeds `priorStates` from last cycle and wires events to the event bus.

## [2026-04-16 22:44] — Git-native skills Phase 1 Task 7: computeSetupQueue

**Task:** Phase 1 Task 7 of git-native skills effort — append `computeSetupQueue(snapshot, current): SetupRequest[]` to `src/host/skills/reconciler.ts`. Pure function that emits one dashboard setup card per skill with missing credentials and/or unapproved domains. Independent notion of "pending" — works directly against the snapshot + current state, not `computeSkillStates` output. TDD order: failing test, implementation, passing test.
**What I did:** Merged `SetupRequest` into the existing `import type` block and appended `computeSetupQueue`. Walks the snapshot, skips invalid entries, filters credentials against `storedCredentials` (`${envName}@${scope}` key) and domains against `approvedDomains`. If both arrays are empty, the skill doesn't contribute an entry — matches the spec: "if nothing is missing, the skill simply doesn't appear on a setup card." OAuth block passes through verbatim on each missing credential. `mcpServers` carried for user visibility only (name + url).
**Files touched:** `src/host/skills/reconciler.ts` (appended), `tests/host/skills/reconciler-setup.test.ts` (new)
**Outcome:** Success — 4 new tests pass, all 33 tests in `tests/host/skills/` pass (schema + parser + reconciler-states + reconciler-mcp + reconciler-allowlist + reconciler-setup).
**Notes:** Setup queue is independent of enablement state — a user might see a card for a skill even if other skills are already enabled, and a fully-satisfied skill produces no card at all. Drives the dashboard setup cards in phase 5.

## [2026-04-16 22:41] — Git-native skills Phase 1 Task 6: computeProxyAllowlist

**Task:** Phase 1 Task 6 of git-native skills effort — append `computeProxyAllowlist(snapshot, states): Set<string>` to `src/host/skills/reconciler.ts`. Pure union of domains declared by enabled skills. Pending/invalid skills contribute nothing — that's the "defense in depth" gate from the design doc. TDD order: failing test, implementation, passing test.
**What I did:** Appended `computeProxyAllowlist` to `reconciler.ts`. Builds `enabledNames` from `states[]` (only `kind === 'enabled'`), walks the snapshot skipping non-ok or non-enabled entries, and inserts each declared domain into an output `Set<string>`. Set handles deduplication naturally when two enabled skills share a domain.
**Files touched:** `src/host/skills/reconciler.ts` (appended), `tests/host/skills/reconciler-allowlist.test.ts` (new)
**Outcome:** Success — 3 new tests pass, all 29 tests in `tests/host/skills/` pass (schema + parser + reconciler-states + reconciler-mcp + reconciler-allowlist).
**Notes:** No filtering against `approvedDomains` needed here — approval was already gated at `computeSkillStates` (unapproved domains keep a skill `pending`, which excludes it from the allowlist by definition). Keeps the function a trivial union and pushes policy into one place.

## [2026-04-16 22:38] — Git-native skills Phase 1 Task 5: computeMcpDesired

**Task:** Phase 1 Task 5 of git-native skills effort — append `computeMcpDesired(snapshot, states)` to `src/host/skills/reconciler.ts`. Pure function that folds enabled-skill MCP server declarations into a keyed `Map<string, { url, bearerCredential? }>` with "first occurrence wins" semantics and a conflict list when the same MCP name has different URLs across skills. TDD order: failing test, implementation, passing test.
**What I did:** Appended `McpConflict` interface and `computeMcpDesired` function to `reconciler.ts`. Builds `enabledNames` from the incoming `states[]` (only `kind === 'enabled'` counts), then walks the snapshot skipping invalid or non-enabled entries. Same-name-same-URL is a silent ref-count (no-op); same-name-different-URL appends to the conflicts array keyed by the later skill. `bearerCredential` passes through from `mcp.credential` verbatim.
**Files touched:** `src/host/skills/reconciler.ts` (appended), `tests/host/skills/reconciler-mcp.test.ts` (new)
**Outcome:** Success — 4 new tests pass, all 26 tests in `tests/host/skills/` pass (schema + parser + reconciler-states + reconciler-mcp).
**Notes:** Deterministic given snapshot iteration order; phase 4 is where pending skills get blocked at the enforcement gate. Conflict record captures `skillName` (the losing one), `mcpName`, `declaredUrl` (rejected), and `conflictingUrl` (kept).

## [2026-04-16 22:36] — Git-native skills Phase 1 Task 4: computeSkillStates

**Task:** Phase 1 Task 4 of git-native skills effort — add `computeSkillStates(snapshot, current)` to a new `reconciler.ts`. Pure function that classifies each snapshot entry as `enabled` / `pending` / `invalid` based on stored credentials (`${envName}@${scope}`) and approved domains. TDD order: failing test, implementation, passing test.
**What I did:** Created `src/host/skills/reconciler.ts` with a single named export `computeSkillStates`. Invalid entries (ok: false) pass through as `kind: 'invalid'` with the error string. Otherwise, walks credentials and domains, collecting human-readable reasons; no reasons means `enabled` with description, any reason means `pending` with `pendingReasons` + description. Signature takes `Pick<ReconcilerCurrentState, 'approvedDomains' | 'storedCredentials'>` so later tasks can share state without coupling.
**Files touched:** `src/host/skills/reconciler.ts` (new), `tests/host/skills/reconciler-states.test.ts` (new)
**Outcome:** Success — 6 new tests pass, all 22 tests in `tests/host/skills/` pass (schema + parser + reconciler-states).
**Notes:** Reason formats are stable substrings the tests check: `missing credential <ENV> (<scope>)` and `domain not approved: <host>`. File is deliberately structured as named exports so Tasks 5–9 can append more functions (`computeMcpDesired`, `computeProxyAllowlist`, `computeSetupQueue`, `computeEvents`, `reconcile`).

## [2026-04-16 22:35] — Git-native skills Phase 1 Task 3: Reconciler types

**Task:** Phase 1 Task 3 of git-native skills effort — declare the type surface used by the reconciler: `SkillSnapshotEntry`, `ReconcilerCurrentState`, `SkillStateKind`, `SkillState`, `SetupRequest`, `ReconcilerOutput`, `ReconcilerInput`. No test file — pure type declarations consumed by Tasks 4-9.
**What I did:** Created `src/host/skills/types.ts` with exactly the types specified in the plan. Imports `SkillFrontmatter` from `./frontmatter-schema.js` (Task 1 output). Used `ReadonlySet`/`ReadonlyMap` for current-state shapes to signal they are inputs, plain `Map`/`Set` for the desired output since callers will consume them.
**Files touched:** `src/host/skills/types.ts` (new)
**Outcome:** Success — `npx tsc --noEmit` clean, no new warnings.
**Notes:** Snapshot entry is a discriminated union on `ok` — same pattern as the parser's return. Storage credential key convention is `${envName}@${scope}`.

## [2026-04-16 22:29] — Git-native skills Phase 1 Task 2: SKILL.md parser

**Task:** Phase 1 Task 2 of git-native skills effort — create `parseSkillFile(content)` that splits YAML frontmatter from body, validates through Task 1's Zod schema, and returns a discriminated union `{ ok, frontmatter, body } | { ok: false, error }`. TDD order: failing test, implementation, passing test.
**What I did:** Created `src/host/skills/parser.ts` with `FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/` and `tests/host/skills/parser.test.ts` (6 cases: valid parse, missing frontmatter, unterminated, invalid YAML, schema violation, CRLF line endings). Parser wraps Zod issues as `path: message; path: message` strings. Pure logic — no filesystem.
**Files touched:** `src/host/skills/parser.ts` (new), `tests/host/skills/parser.test.ts` (new)
**Outcome:** Success — all 6 parser tests pass, all 16 tests in `tests/host/skills/` pass (parser + frontmatter-schema).
**Notes:** Regex uses non-greedy `[\s\S]*?` for the frontmatter section so a body containing `---` doesn't confuse the split. The `yaml` package was already a dependency (no install needed).

## [2026-04-16 22:26] — Git-native skills Phase 1 Task 1: Zod frontmatter schema

**Task:** Phase 1 Task 1 of git-native skills effort — create the `SkillFrontmatterSchema` Zod module that will be used by later tasks (parser, reconciler). TDD order: failing test, implementation, passing test.
**What I did:** Created `src/host/skills/frontmatter-schema.ts` and `tests/host/skills/frontmatter-schema.test.ts`. Schema uses Zod v4 with `.strict()` at every object level, SCREAMING_SNAKE_CASE env name regex (`/^[A-Z][A-Z0-9_]{1,63}$/`), https-only URLs for OAuth and MCP, and a `.refine()` that requires the `oauth` block when `authType === 'oauth'`. Credentials/mcpServers/domains default to `[]`; authType defaults to `api_key`; scope defaults to `user`.
**Files touched:** `src/host/skills/frontmatter-schema.ts` (new), `tests/host/skills/frontmatter-schema.test.ts` (new)
**Outcome:** Success — all 10 tests pass, tsc clean.
**Notes:** First module of the new `src/host/skills/` directory. Pure logic — no filesystem, no IPC. Zod v4.3.6 handles `z.string().url().startsWith('https://')` fine (verified before writing).

## [2026-03-22 16:30] — Fix GCS domain loading at startup — wrong user ID

**Task:** Debug why proxy blocks api.linear.app with 403 even though Linear skill is installed and persisted in GCS
**What I did:** Traced the startup domain scan in `server-init.ts`. Found it calls `downloadScope('user', agentName)` where `agentName='main'`, which queries GCS prefix `test/user/main/` — but skills are stored under actual user IDs (`test/user/chat-ui/`, `test/user/default/`). Added `listScopeIds()` method to workspace provider types and GCS implementation to enumerate all user IDs in a scope. Updated `server-init.ts` to iterate each user ID when scanning for skills.
**Files touched:** `src/providers/workspace/types.ts`, `src/providers/workspace/gcs.ts`, `src/host/server-init.ts`
**Outcome:** Success — host now logs `skill_domains_added` with `api.linear.app` at startup. Domain allowlist shows `api.linear.app` as allowed instead of pending.
**Notes:** The bug was subtle: the startup code mirrored the local filesystem scan pattern (iterate users dir), but the GCS equivalent used `agentName` as the ID for both scopes. The `listScopeIds` method enumerates unique first-level prefixes under `<prefix>/<scope>/` in GCS.

## [2026-03-22 10:30] — Fix skill install slug resolution and proxy domain allowlist

**Task:** Debug two bugs: (1) installing skill via ClawHub URL resolves wrong slug ("virtually-us" instead of "linear"), (2) installed skill can't reach api.linear.app (403 from proxy)
**What I did:**
- Bug 1: Added ClawHub URL parsing in `skill_install` handler — extracts `author/name` from `clawhub.ai/...` URLs in both `slug` and `query` fields. Updated prompt to instruct LLM to pass URLs as `slug` not `query`.
- Bug 2: Added `requires.domains` to `ParsedAgentSkill` type, parser, and manifest generator. Skill authors can now declare domains in SKILL.md frontmatter. Also added bare domain regex (`BARE_DOMAIN_RE`) to detect domains referenced without protocol prefix (e.g. `api.linear.app/graphql`). Updated e2e mock SKILL.md.
**Files touched:** `src/host/ipc-handlers/skills.ts`, `src/providers/skills/types.ts`, `src/utils/skill-format-parser.ts`, `src/utils/manifest-generator.ts`, `src/agent/prompt/modules/skills.ts`, `tests/e2e/mock-server/clawhub.ts`, `tests/host/skill-install.test.ts`, `tests/utils/skill-format-parser.test.ts`, `tests/utils/manifest-generator.test.ts`
**Outcome:** Success — all 2552 tests pass
**Notes:** Bug 2 had four layers: (1) no `requires.domains` frontmatter field, (2) body scanner only matched full URLs with protocol prefix — added `BARE_DOMAIN_RE` for `api.linear.app/graphql` style refs, (3) proxy received static `Set<string>` snapshot instead of live domain check — changed to `{ has() }` interface with live wrapper, (4) on restart, `server-init.ts` only read agent-level skills not user-level — added user skills dir scanning.

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
