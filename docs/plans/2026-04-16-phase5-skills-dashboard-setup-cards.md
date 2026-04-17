# Phase 5 — Dashboard Setup Cards (API-Key Path Only)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** New "Skills" page in the admin dashboard that lists pending-skill setup cards (from phase 2's `setup_queue`) and ad-hoc credential request cards (from the existing `request_credential` flow). Atomic approval: one click approves all domains + stores all credentials + re-triggers reconcile so the skill transitions enabled.

**Scope:** API-key path only. OAuth is phase 6. Bundled approval endpoint is the core primitive.

**Architecture:** admin dashboard React page ↔ new HTTP endpoints:
- `GET /v1/admin/skills/setup` → pending setup cards for the current user's agents.
- `POST /v1/admin/skills/setup/approve` → atomic: writes domain approvals, stores credentials at correct scope, triggers reconcile, returns new state.
- `DELETE /v1/admin/skills/setup/:agentId/:skillName` → dismiss without approving (skill stays pending, files remain).
- `GET /v1/admin/credentials/requests` → standalone request cards (from `request_credential` IPC).

---

## Constraints
- No credentials ever touch the browser console or logs. POST bodies over HTTPS, redacted logs.
- Atomic means "validate-all, then apply-all" — no half-applied state.
- Replace the `ConnectorsPage` React component entirely; the new `SkillsPage` is the primary credentials UX.
- TDD on the backend endpoints; component tests for the React page using the existing vitest+React config.

---

## Tasks (high-level)

1. **`GET /v1/admin/skills/setup`:** reads `skill_setup_queue` joined with `skill_states` (kind=pending) for agents the user owns.
2. **`POST .../approve`:** Zod schema `{agentId, skillName, credentials: {envName,value}[], approveDomains: string[]}`. Validate → write credentials via `credentials.set(envName, value, scope)` at the scope specified in the SetupRequest → `proxyDomainList.approvePending(domain)` for each — or direct add to `adminApproved` — → invoke the phase-2 orchestrator → return new skill state.
3. **`DELETE .../setup/:agentId/:skillName`:** remove setup-queue row; does NOT delete the SKILL.md from the repo (that's the agent's job).
4. **`GET /v1/admin/credentials/requests`:** adapts the existing in-memory request queue to HTTP.
5. **React page:** replace `ConnectorsPage` with `SkillsPage`. Render card per skill, grouped by agent. Form per card with domain checkboxes, credential paste fields, MCP URL info. One submit button → `/approve`.
6. **Wire into admin sidebar.**

**Files touched:** `src/host/server-admin.ts` (new routes), `src/host/server-admin-helpers.ts` (atomic-approve helper), `ui/admin/src/components/pages/skills-page.tsx` (new), remove/redirect `connectors-page.tsx`, tests under `tests/host/`, `ui/admin/src/components/pages/__tests__/`.

**Commit hints:** `feat(admin): skills setup endpoints with atomic approve`, `feat(admin): SkillsPage replaces ConnectorsPage`, `refactor(admin): drop ConnectorsPage`.
