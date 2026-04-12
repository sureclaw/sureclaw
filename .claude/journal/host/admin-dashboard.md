# Admin Dashboard

Journal entries for the admin dashboard implementation.

## [2026-04-06 10:12] — PVC cleanup on agent deletion (Phase 3 PVC lifecycle)

**Task:** Wire up PVC deletion when an agent is deleted via the admin API DELETE endpoint.
**What I did:** Added PVC cleanup call in the DELETE /admin/api/agents/:id handler in server-admin.ts. After archiving the agent, the handler checks if `providers.sandbox.deletePvc` exists (only k8s provider has it) and calls it with `ax-workspace-{agentId}` in a fire-and-forget pattern (errors are logged but don't fail the response). Added 4 tests: deletePvc called with correct name, graceful when sandbox lacks deletePvc, succeeds even when deletePvc rejects, and 404 for unknown agent.
**Files touched:** src/host/server-admin.ts, tests/host/server-admin.test.ts
**Outcome:** Success — build passes, all 37 server-admin tests pass.
**Notes:** The deletePvc method is optional on SandboxProvider (only k8s.ts implements it). Fire-and-forget with .catch() prevents PVC cleanup failures from breaking the admin API response.

## [2026-03-04 03:45] — Implement admin dashboard (18-task plan)

**Task:** Execute the full admin dashboard implementation plan from docs/plans/2026-03-03-admin-dashboard.md — remove CLI chat, add admin API, build dashboard SPA, wire first-run setup wizard.

**What I did:**
- Task 1: Removed CLI chat (chat.ts, 7 component files, 7 test files), cleaned up ink/react deps from package.json
- Task 2: Added `admin: { enabled, token?, port }` to Config interface and Zod schema with defaults (enabled: true, port: 8080)
- Tasks 3-6: Created `src/host/server-admin.ts` — bearer token auth with timing-safe comparison, rate limiting, admin API endpoints (status, agents, audit, config, events SSE), static file serving, setup endpoints
- Task 7: Wired admin handler into server.ts, shared AgentRegistry between IPC and admin, auto-TCP bind for admin dashboard with graceful EADDRINUSE fallback
- Tasks 8-15: Created full dashboard SPA in `dashboard/` — React 19 + Vite 6 + Tailwind 4, API client, 7 pages (Overview, Agents, Security, Logs, Settings, Login, Setup), builds to `src/admin-ui/`
- Tasks 16-17: Created `src/cli/setup-server.ts` for first-run web-based setup wizard, replaced CLI `runConfigure` with web setup on first run
- Task 18: Updated test configs, event console, .gitignore, package.json scripts

**Files touched:**
- Deleted: `src/cli/chat.ts`, `src/cli/components/*.tsx`, `tests/cli/chat.test.ts`, `tests/cli/components/*.test.tsx`
- Modified: `src/cli/index.ts`, `src/cli/bootstrap.ts`, `src/types.ts`, `src/config.ts`, `src/host/server.ts`, `src/host/event-console.ts`, `package.json`, `.gitignore`, `ax.yaml`, `tests/cli/index.test.ts`, `tests/config.test.ts`, `tests/integration/ax-test.yaml`
- Created: `src/host/server-admin.ts`, `src/cli/setup-server.ts`, `tests/host/server-admin.test.ts`, `dashboard/` (full SPA)

**Outcome:** Success — 199 test files pass (up from 198), 2258 tests pass, 14 new admin API tests, 2 new config tests. Dashboard builds successfully (252KB JS + 22KB CSS). Only 3 pre-existing failures remain (strip-ansi dep issue).

**Notes:** The plan assumed a pre-existing dashboard SPA in `dashboard/` but it didn't exist. Built it from scratch with API integration from the start rather than creating mock data first. Made admin TCP port gracefully handle EADDRINUSE to avoid breaking integration tests.
