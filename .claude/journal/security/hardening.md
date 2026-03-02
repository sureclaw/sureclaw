# Security: Hardening

Security hardening: provider path resolution, cross-provider dependencies, vulnerability fixes.

## [2026-02-28 01:20] — Harden import.meta.resolve + fix cross-provider dependencies (Step 2b)

**Task:** Add post-resolution URL protocol validation to provider-map.ts, extract parseCompoundId out of llm/router into shared router-utils, and break scheduler's direct imports from channel/memory/audit types via shared-types.ts
**What I did:**
1. Added `assertFileUrl()` guard in provider-map.ts — every resolved URL must be `file://` protocol (rejects `data:`, `http:`, `node:` schemes). Defense-in-depth for SC-SEC-002.
2. Created `src/providers/router-utils.ts` with `parseCompoundId` + `ModelCandidate`. Updated both `llm/router.ts` and `image/router.ts` to import from shared utils. Added backwards-compat re-export from `llm/router.ts`.
3. Created `src/providers/shared-types.ts` as a cross-provider type re-export hub. Updated all 4 scheduler files (`types.ts`, `utils.ts`, `cron.ts`, `full.ts`) to import from `shared-types.ts` instead of directly from `../channel/types.js`, `../memory/types.js`, `../audit/types.js`.
4. Added structural test (`shared-types.test.ts`) that reads source files to enforce no direct sibling provider imports.
**Files touched:** Modified: src/host/provider-map.ts, src/providers/llm/router.ts, src/providers/image/router.ts, src/providers/scheduler/types.ts, src/providers/scheduler/utils.ts, src/providers/scheduler/cron.ts, src/providers/scheduler/full.ts, tests/host/provider-map.test.ts, tests/providers/llm/router.test.ts, tests/providers/image/router.test.ts. Created: src/providers/router-utils.ts, src/providers/shared-types.ts, tests/providers/router-utils.test.ts, tests/providers/shared-types.test.ts
**Outcome:** Success — 171/171 test files pass, 1749/1750 tests pass (1 skipped), clean TypeScript build
**Notes:** The re-export from llm/router.ts is marked for removal in Phase 3. The shared-types.ts pattern keeps canonical type definitions in their home provider — it's purely a re-export hub to prevent import graph coupling.

## [2026-02-28 10:00] — Harden resolveProviderPath against CWD module hijacking

**Task:** Add import.meta.resolve() mitigation for package-name entries in provider-map.ts
**What I did:** Changed resolveProviderPath() to use import.meta.resolve() instead of returning bare package names. This pins resolution to the AX installation's node_modules, not the CWD — preventing an attacker from planting a malicious node_modules/@ax/ in the working directory. Updated the implementation plan (Step 2a) with the security rationale. Added a test documenting the security invariant. Relaxed the naming convention test to accept both relative paths and @ax/provider-* package names (forward-compatible with Phase 2).
**Files touched:** Modified: src/host/provider-map.ts, tests/host/provider-map.test.ts, docs/plans/2026-02-27-monorepo-split-implementation.md
**Outcome:** Success — 23/23 provider-related tests pass, security property validated
**Notes:** Node.js import.meta.resolve() is stable since Node 20.6 (we're on 22.22.0). The key insight: new URL(path, import.meta.url) for relative paths and import.meta.resolve(pkg) for package names both resolve from the module's location, not CWD. This makes them security-equivalent.

## [2026-02-27 02:47] — Fix minimatch ReDoS vulnerability

**Task:** Resolve npm audit high-severity vulnerability in minimatch 10.0.0-10.2.2 (ReDoS via GLOBSTAR and nested extglobs)
**What I did:** Ran `npm audit fix` which updated minimatch and 76 related packages. Remaining 19 low-severity vulns are in fast-xml-parser deep inside @aws-sdk → @mariozechner/pi-ai transitive chain — fixing those requires a breaking dep downgrade.
**Files touched:** package-lock.json
**Outcome:** Success — high-severity minimatch vuln resolved, all 1721 tests pass
**Notes:** The 19 remaining low-severity vulns need upstream @mariozechner/pi-ai to update their @aws-sdk dependency. Not actionable on our end without a breaking change.

## [2026-02-22 04:00] — Fix npm audit CI failure

**Task:** npm audit --audit-level=moderate was failing in CI with 9 vulnerabilities
**What I did:** Ran `npm audit fix` to resolve 5 direct-fixable vulns (ajv, fast-xml-parser, hono, qs). Remaining 4 were transitive minimatch@9.0.6 via gaxios→rimraf→glob chain. Added npm overrides in package.json to force minimatch>=10.2.1 and glob>=11.0.0.
**Files touched:** package.json, package-lock.json
**Outcome:** Success — 0 vulnerabilities, all 1214 tests still pass
**Notes:** The minimatch vuln was deep transitive (@mariozechner/pi-ai → @google/genai → google-auth-library → gaxios → rimraf → glob → minimatch). npm overrides are the right approach for transitive deps that upstream hasn't patched yet.

## [2026-02-22 05:00] — Add comprehensive fault tolerance

**Task:** Make AX tolerant to all kinds of external and internal failures (LLM provider failures/timeouts, host/container crashes, agent crashes, process hangs, etc.)
**What I did:** Added 8 fault tolerance mechanisms across the codebase:
1. **Retry utility** (`src/utils/retry.ts`): Reusable `withRetry()` with exponential backoff, jitter, AbortSignal, and configurable error classification
2. **Circuit breaker** (`src/utils/circuit-breaker.ts`): Three-state (closed/open/half_open) circuit breaker with configurable threshold, reset timeout, and failure predicates
3. **IPC client reconnection** (`src/agent/ipc-client.ts`): Auto-reconnect with exponential backoff on connection-level errors (EPIPE, ECONNRESET, etc.), retry-after-reconnect for transient failures, no retry for timeouts
4. **Agent crash recovery** (`src/host/server-completions.ts`): Retry loop (up to 2 retries) for transient agent crashes (OOM kills, segfaults, connection errors), with `isTransientAgentFailure()` classifier distinguishing permanent (auth, timeout, bad config) from transient failures
5. **Graceful shutdown with request draining** (`src/host/server.ts`): In-flight request tracking, 503 rejection of new requests during shutdown, drain timeout (30s), health endpoint reports draining status
6. **Graceful process termination** (`src/providers/sandbox/utils.ts`): `enforceTimeout` now sends SIGTERM first, waits grace period (default 5s), then SIGKILL — tracked via 'exit' event instead of `child.killed`
7. **Channel reconnection** (`src/host/server-channels.ts`): `connectChannelWithRetry()` wraps channel.connect() with retry/backoff, classifies auth errors as permanent
8. **IPC handler timeout** (`src/host/ipc-server.ts`): 15-minute safety-net timeout via `Promise.race()` prevents hung handlers from blocking the IPC server
**Files touched:**
- New: src/utils/retry.ts, src/utils/circuit-breaker.ts
- New tests: tests/utils/retry.test.ts, tests/utils/circuit-breaker.test.ts, tests/host/fault-tolerance.test.ts, tests/agent/ipc-client-reconnect.test.ts, tests/host/channel-reconnect.test.ts
- Modified: src/agent/ipc-client.ts, src/host/server.ts, src/host/server-completions.ts, src/host/server-channels.ts, src/host/ipc-server.ts, src/providers/sandbox/utils.ts
- Modified tests: tests/providers/sandbox/utils.test.ts, tests/sandbox-isolation.test.ts
**Outcome:** Success — 1267/1268 tests pass (1 pre-existing skip)
**Notes:** Key design decisions: (1) retry utility is generic and composable for future use, (2) circuit breaker is standalone for wrapping any provider, (3) agent crash retry is conservative (max 2 retries) to avoid infinite loops, (4) timeout-killed agents are NOT retried since they already spent their full time budget, (5) IPC client doesn't retry timeouts since the call may have been received server-side.
