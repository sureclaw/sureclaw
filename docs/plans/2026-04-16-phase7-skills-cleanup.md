# Phase 7 — Cleanup

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove the old plugin/skill install code path, now fully superseded by the git-native flow.

---

## What goes away

- `src/plugins/` — entire directory.
- `src/cli/plugin.ts`, `src/cli/mcp.ts` — the install commands.
- `src/providers/storage/skills.ts` — DocumentStore-backed skill storage (reads moved in phase 3; writes retired).
- IPC actions `skill_install` and `skill_create` in `src/host/ipc-handlers/skills.ts` — retain `credential_request` (still used for ad-hoc credential paste).
- Tests under `tests/plugins/`, `tests/cli/plugin*`, `tests/cli/mcp*`, `tests/providers/storage/skills*`.
- Any README/doc/skill references to `/plugin install` or the old manifest JSON.

## What stays

- `src/host/credential-placeholders.ts` — unchanged; still the injection mechanism.
- `src/host/proxy-domain-list.ts` — signature now augmented by phase 4 appliers.
- `src/providers/credentials/*` — scoped storage still the system of record.
- `src/host/oauth*.ts` — extended in phase 6 but not removed.

---

## Constraints
- Remove in a single PR so test matrices don't churn. Run full `npm test` + `npm run build` before commit.
- Update every `.claude/skills/ax/*.md` that referenced the retired paths.
- Delete migrations only if they were never applied to production. Prefer leaving old tables empty and writing a new migration that drops them at the end of phase 7.

---

## Tasks (high-level)

1. **Grep-and-nuke:** list every import of removed modules; delete/retarget.
2. **IPC schema cleanup:** remove `skill_install` + `skill_create` schemas from `src/ipc-schemas.ts`; regenerate any consumers.
3. **CLI surface:** remove `plugin` and `mcp` commands; if there are users of them, add a deprecation shim that prints "Use the dashboard / author skill files in your workspace" and exits non-zero for one release, then remove entirely.
4. **Drop tables migration:** `DROP TABLE IF EXISTS plugin_manifests; DROP TABLE IF EXISTS skills_documents;` (verify names).
5. **Docs sweep:** README.md, `docs/web/`, `.claude/skills/ax/*.md`.
6. **Run `npm run build` + full test suite + acceptance tests.**

**Commit hints:** `refactor: remove legacy plugin/skill install path`, `chore(db): drop retired plugin/skill tables`, `docs: update skills workflow to git-native`.

---

## Exit criteria

- `rg "plugin_install|skill_install|skill_create|DocumentStore.*skill"` returns zero hits.
- `npm test` + `npm run build` green.
- `.claude/skills/ax/*.md` reflects reality.
- README's "Install a skill" section shows the git workflow with the dashboard handling approvals.
