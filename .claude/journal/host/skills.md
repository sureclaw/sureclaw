# Host / Skills

Git-native skills rollout: snapshot builder, state store, reconcile orchestrator, hooks — all host-side pieces that walk `.ax/skills/**/SKILL.md` from a bare repo ref and reconcile them into desired MCP/allowlist/state.

## Entries

## [2026-04-16 23:18] — Phase 2 Task 2: skill state store + migration

**Task:** Build sqlite-backed persistence for per-agent skill states (name+kind+description+reasons/error) and per-agent setup queue (one `SetupRequest` per pending skill). Both keyed by `(agent_id, skill_name)`. A reconcile for an agent must atomically replace all its rows (no stale rows for removed skills).
**What I did:** TDD. Wrote 10 tests covering: empty-agent read, two-skill roundtrip with different kinds, authoritative replace, empty-list clears rows, other-agent isolation, pendingReasons JSON round-trip via raw row, setup-queue empty read, full SetupRequest (nested creds/oauth/domains/mcpServers) roundtrip, empty-queue clears only that agent, queue replace. Verified failing (module missing). Implemented `src/migrations/skills.ts` (two tables + composite PKs + `idx_skill_states_agent`, `sqlEpoch` default) mirroring `src/migrations/jobs.ts` shape. Implemented `src/host/skills/state-store.ts` — `createSkillStateStore(db)` factory returning `{getPriorStates, putStates, putSetupQueue, getSetupQueue}`. Both put-methods run delete-then-insert in ONE `db.transaction().execute(async trx => …)` for atomicity. YAGNI: no full-row read of SkillState, no cross-agent listing, no hooks into host startup (that's task 6).
**Files touched:** `src/migrations/skills.ts` (new), `src/host/skills/state-store.ts` (new), `tests/host/skills/state-store.test.ts` (new), `.claude/journal/host/skills.md`.
**Outcome:** Success — 10/10 new tests pass; full skills suite 56/56 passes; `tsc --noEmit` clean.
**Notes:** `updated_at`/`created_at` omitted on insert so the `sqlEpoch(dbType)` default fires. `pendingReasons` persists as JSON text — `getPriorStates` only returns kind (it's all the reconciler needs), so we don't deserialize reasons on the read path. `getSetupQueue` orders by `skill_name` asc for deterministic output, even though callers typically don't care. Consumers: `src/host/skills/current-state.ts` (task 3) reads `getPriorStates`; `src/host/skills/reconcile-orchestrator.ts` (task 4) writes both tables.

## [2026-04-16 23:12] — Phase 2 Task 1: snapshot builder

**Task:** Build a pure snapshot builder that walks `.ax/skills/**/SKILL.md` in a given bare-repo ref and returns a `SkillSnapshotEntry[]` for the phase-1 reconciler to consume.
**What I did:** TDD. Wrote failing test (valid+invalid pair sorted, no-`.ax/skills`, empty repo, orphan skill dir). Implemented `buildSnapshotFromBareRepo(bareRepoPath, ref)` using `execFile` (no shell) with `git ls-tree -r --name-only <ref> -- .ax/skills/`, regex `^\.ax/skills/([^/]+)/SKILL\.md$`, then `git show <ref>:<path>` + `parseSkillFile`. Sort by name ascending. No try/catch swallowing; empty stdout naturally yields `[]` when no skills tree exists.
**Files touched:** `src/host/skills/snapshot.ts` (new), `tests/host/skills/snapshot.test.ts` (new), `.claude/journal/host/skills.md` (new).
**Outcome:** Success — 4/4 new tests pass, full skills suite 46/46 passes, `tsc` clean.
**Notes:** Kept it minimal (YAGNI): no caching, no parallel exec, sequential awaits. `encoding: 'buffer'` + `Buffer.toString('utf-8')` to be robust with non-ASCII skill content. `maxBuffer: 16 MiB` on `git show` to defensively allow large SKILL.md files without surprising truncation. Tests exercise real git subprocesses on real bare repos — not mocked.
