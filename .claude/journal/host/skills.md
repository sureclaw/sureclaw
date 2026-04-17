# Host / Skills

Git-native skills rollout: snapshot builder, state store, reconcile orchestrator, hooks — all host-side pieces that walk `.ax/skills/**/SKILL.md` from a bare repo ref and reconcile them into desired MCP/allowlist/state.

## Entries

## [2026-04-16 23:12] — Phase 2 Task 1: snapshot builder

**Task:** Build a pure snapshot builder that walks `.ax/skills/**/SKILL.md` in a given bare-repo ref and returns a `SkillSnapshotEntry[]` for the phase-1 reconciler to consume.
**What I did:** TDD. Wrote failing test (valid+invalid pair sorted, no-`.ax/skills`, empty repo, orphan skill dir). Implemented `buildSnapshotFromBareRepo(bareRepoPath, ref)` using `execFile` (no shell) with `git ls-tree -r --name-only <ref> -- .ax/skills/`, regex `^\.ax/skills/([^/]+)/SKILL\.md$`, then `git show <ref>:<path>` + `parseSkillFile`. Sort by name ascending. No try/catch swallowing; empty stdout naturally yields `[]` when no skills tree exists.
**Files touched:** `src/host/skills/snapshot.ts` (new), `tests/host/skills/snapshot.test.ts` (new), `.claude/journal/host/skills.md` (new).
**Outcome:** Success — 4/4 new tests pass, full skills suite 46/46 passes, `tsc` clean.
**Notes:** Kept it minimal (YAGNI): no caching, no parallel exec, sequential awaits. `encoding: 'buffer'` + `Buffer.toString('utf-8')` to be robust with non-ASCII skill content. `maxBuffer: 16 MiB` on `git show` to defensively allow large SKILL.md files without surprising truncation. Tests exercise real git subprocesses on real bare repos — not mocked.
