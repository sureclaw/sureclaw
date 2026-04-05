# Auth Provider Journal

## [2026-04-05 19:00] — Chat UI auth gating with BetterAuth sessions

**Task:** Gate the chat UI behind BetterAuth session authentication (Task 11 of 13)
**What I did:** Created `ui/chat/src/lib/auth.ts` with plain fetch utilities for BetterAuth REST API (getSession, signInWithGoogle, signOut). Updated `App.tsx` with auth state machine: loading -> checks /api/auth/get-session -> if 404, allows unauthenticated access (backward compat) -> if no session, shows login page -> if session, sets user and shows chat. Added user parameter passthrough: App passes user.id to useAxChatRuntime, which passes it to AxChatTransport as the user option. Added sign-out button in sidebar when user is authenticated.
**Files touched:** `ui/chat/src/lib/auth.ts` (created), `ui/chat/src/App.tsx` (rewritten), `ui/chat/src/lib/useAxChatRuntime.tsx` (modified)
**Outcome:** Success — Vite build passes cleanly
**Notes:** Key backward compatibility: when /api/auth/get-session returns 404 (BetterAuth not configured), the chat works exactly as before with no login required. Uses plain fetch, NOT @better-auth/react dependency.

## [2026-04-05 18:00] — Admin UI session-based auth flow

**Task:** Update admin UI to support BetterAuth session cookies alongside existing bearer token auth (Task 10 of 13)
**What I did:** Added `credentials: 'include'` to apiFetch in api.ts so session cookies are sent. Rewrote App.tsx auth flow to check BetterAuth session via `/api/auth/get-session` with soft fallback to token auth. Updated LoginPage to show Google sign-in button when session auth is available, or the existing token instructions when it is not. Added AccessDenied component for authenticated non-admin users.
**Files touched:** `ui/admin/src/lib/api.ts` (modified), `ui/admin/src/App.tsx` (rewritten), `ui/admin/src/components/pages/login-page.tsx` (modified)
**Outcome:** Success — Vite build passes cleanly
**Notes:** Auth flow is a soft check: if `/api/auth/get-session` fails or returns 404, falls back to token-based behavior. This preserves backward compatibility when BetterAuth is not configured.

## [2026-04-05 17:00] — First-user admin bootstrap on signup

**Task:** Add auto-promotion of the first user to admin role for zero-config bootstrap (Task 8 of 13)
**What I did:** Added `databaseHooks.user.create.after` hook to the BetterAuth config that counts total users after creation and promotes user #1 to admin. Added 2 new tests: a source-level check that databaseHooks/countTotalUsers are configured, and a full integration test using in-memory SQLite that creates two users via `auth.api.signUpEmail` and verifies the first gets admin role while the second stays as user.
**Files touched:** `src/providers/auth/better-auth.ts` (modified), `tests/providers/auth/better-auth.test.ts` (modified)
**Outcome:** Success — 5 tests pass in the auth test file, full suite passes (2885 tests)
**Notes:** Used `databaseHooks.user.create.after` with `ctx.context.internalAdapter.countTotalUsers()` and `updateUser()`. The `after` hook approach requires a separate update call but avoids the complexity of the `before` hook needing to access the database. The hook is wrapped in try/catch so it's non-fatal if counting fails.

## [2026-04-05 16:45] — Add BetterAuth provider with Google OAuth

**Task:** Implement the BetterAuth auth provider (Task 7 of 13) with Google OAuth support
**What I did:** Created `src/providers/auth/better-auth.ts` implementing the AuthProvider contract using BetterAuth library. Creates SQLite or PostgreSQL database connection based on DATABASE_URL env var. Uses `fromNodeHeaders()` from `better-auth/node` for header conversion. Handles session validation via `auth.api.getSession()`, domain restriction via `allowed_domains`, and route handling for `/api/auth/*`. Created 3 tests covering missing config, no-cookie auth, and non-auth route handling.
**Files touched:** `src/providers/auth/better-auth.ts` (created), `tests/providers/auth/better-auth.test.ts` (created)
**Outcome:** Success — 3 new tests pass, full suite passes (2883 tests)
**Notes:** BetterAuth v1.5.6 database option does NOT accept `{url, type}` -- it requires raw database instances (SqliteDatabase from better-sqlite3, or PostgresPool from pg). Adapted the implementation accordingly. Also used `fromNodeHeaders()` utility from `better-auth/node` instead of manual Headers construction.

## [2026-04-05 16:35] — Wire auth provider into provider-map and Config types

**Task:** Add auth provider to static allowlist and Config/ProviderRegistry types (Task 3 of 13)
**What I did:** Added `auth` entry to `_PROVIDER_MAP` in `src/host/provider-map.ts` with admin-token and better-auth paths. Added `AuthProviderName` typed export. Updated `src/types.ts` with AuthProviderName import, `auth?: AuthProviderName[]` in Config.providers, `auth?` config block with better_auth settings, and `auth?: AuthProvider[]` in ProviderRegistry.
**Files touched:** `src/host/provider-map.ts` (modified), `src/types.ts` (modified)
**Outcome:** Success — tsc compiles cleanly, all 2876 tests pass
**Notes:** Auth is an array in both Config.providers and ProviderRegistry because multiple auth providers can be chained (admin-token + better-auth).

## [2026-04-05 16:33] — Add admin-token auth provider

**Task:** Implement the admin-token auth provider as the first concrete AuthProvider implementation (Task 2 of 13)
**What I did:** Created `src/providers/auth/admin-token.ts` with timing-safe token comparison, Bearer header and X-Ax-Token header support. Created tests in `tests/providers/auth/admin-token.test.ts` with 6 tests covering valid/invalid/missing tokens and unconfigured token scenarios. TDD approach: tests written first, verified failing, then implementation written.
**Files touched:** `src/providers/auth/admin-token.ts` (created), `tests/providers/auth/admin-token.test.ts` (created)
**Outcome:** Success — all 6 tests pass
**Notes:** Reimplements extractToken/safeEqual from `src/host/server-admin.ts` in the provider pattern so it can be used independently of the admin server.

## [2026-04-05 10:00] — Add AuthProvider contract types

**Task:** Create the AuthProvider contract types as the first step of the pluggable auth provider category
**What I did:** Created `src/providers/auth/types.ts` with AuthRole, AuthUser, AuthResult, and AuthProvider interface. Follows the co-located types pattern used by all other provider categories.
**Files touched:** `src/providers/auth/types.ts` (created)
**Outcome:** Success — compiles cleanly with `npx tsc --noEmit`
**Notes:** The three-way return from authenticate() (null / {authenticated:false} / {authenticated:true, user}) is the key design choice — null means "not my request, try next provider" which enables provider chaining.
