# Scheduler Provider Journal

## [2026-04-13 09:55] — Fix "Command failed" false positive for zero-exit-code bash commands

**Task:** Gemini Flash LLM was looping through 44 bash calls in a single cron invocation, trying different approaches to create one file. Root cause: the sandbox bash tool returned "Command failed" for successful commands with no stdout/stderr output.
**What I did:** Fixed the empty-output fallback in `local-sandbox.ts` line 164: when exit code is 0 and both stdout/stderr are empty, now returns `"(no output)"` instead of `"Command failed"`. The old behavior told the LLM every silent command failed, causing it to retry with different approaches endlessly.
**Files touched:** `src/agent/local-sandbox.ts`, `tests/agent/local-sandbox.test.ts`
**Outcome:** Success — 17 sandbox tests pass including 2 new tests for the empty-output case. The LLM will now correctly see `{"output":"(no output)"}` instead of `{"output":"Command failed"}` for successful redirects like `echo hello > file.txt`.
**Notes:** Secondary issue: the "bash" tool actually uses `sh -c`, not `bash -c`. `$RANDOM` is a bash-ism that doesn't work in POSIX sh. This is a separate issue (tool name is misleading) but contributed to the problem since the cron prompt example used `$RANDOM`.

## [2026-04-13 09:30] — Add in-flight overlap protection for cron/heartbeat jobs

**Task:** Cron jobs that take >60s cause overlapping concurrent invocations because `tryClaim` only deduplicates within the same minute, not across minutes.
**What I did:** Added `inFlight` Set to track currently-executing job IDs. `checkCronJobs()` and `fireHeartbeat()` skip firing if the job is already in-flight. The in-flight flag is cleared via `.finally()` on the Promise returned by `onMessageHandler`. Also added a test that verifies a slow cron invocation blocks the next fire until it completes.
**Files touched:** `src/providers/scheduler/plainjob.ts`, `tests/providers/scheduler/plainjob.test.ts`
**Outcome:** Success — 47 tests pass (new in-flight test included).
**Notes:** Root cause was that a cron job ("create random file") took 68s due to Gemini Flash looping through 44 bash calls. The next minute's `checkCronJobs()` fired again because `minuteKey` had changed. The in-flight Set is a per-process guard (not distributed), which is correct — each replica should independently decide whether its own previous invocation is still running.

## [2026-04-13 01:00] — Multi-replica dedup for PlainJob scheduler

**Task:** Prevent duplicate cron/heartbeat/one-shot firing when multiple host replicas share the same database
**What I did:** Added `last_fired_at` column migration, `tryClaim` method to `JobStore`/`KyselyJobStore`/`MemoryJobStore`, wired `tryClaim` into `checkCronJobs`, `fireHeartbeat`, and `fireOnceJob`. Synthetic `__heartbeat__` row inserted for KyselyJobStore only. Added filtering to exclude synthetic rows from `listJobs()` and `checkCronJobs()`.
**Files touched:** `src/migrations/jobs.ts`, `src/providers/scheduler/types.ts`, `src/job-store.ts`, `src/providers/scheduler/plainjob.ts`, `tests/providers/scheduler/plainjob.test.ts`
**Outcome:** Success — 46 tests pass + 13 PG tests skipped (no PG_URL). 7 commits across 7 tasks.
**Notes:** Heartbeat synthetic row caused regressions in existing tests because it appeared in `listJobs()` and `checkCronJobs()`. Fixed by: (1) only inserting for KyselyJobStore (not MemoryJobStore), (2) filtering `__heartbeat__:` prefix from `listJobs()` and `checkCronJobs()`. Had to move `agentName` declaration earlier to avoid duplicate const.

## [2026-03-17 22:35] — Port scheduler startup to host-process.ts (k8s scheduler never ran)

**Task:** Debug why the scheduler was not working in the k8s cluster
**What I did:** Root-caused to `host-process.ts` never calling `scheduler.start()`. The scheduler was only started in `server.ts` (standalone mode). Ported the scheduler start/stop logic from `server.ts` to `host-process.ts`, including: delivery resolution, session store extraction, and cron/heartbeat message processing via `processCompletionWithNATS`. Also fixed model routing in `ipc-handlers/llm.ts` where `configModel` was used for logging but not the actual LLM call.
**Files touched:** `src/host/host-process.ts`, `src/host/ipc-handlers/llm.ts`
**Outcome:** Success — scheduler starts on host boot, existing cron jobs fire immediately, 2411/2411 tests pass. Deployed and verified in k8s cluster.
**Notes:** Channel providers are loaded by `loadProviders()` but not connected in `host-process.ts` — delivery to Slack/Discord will fail until channel connection is also ported. The model routing fix ensures `configModel` (from config.yaml `models.default[0]`) takes priority over the agent's default model.

## [2026-03-17 20:50] — Fix async mismatch in plainjob scheduler (k8s job scheduling broken)

**Task:** Scheduler not scheduling jobs in k8s
**What I did:** Root-caused to async mismatch in plainjob.ts — `addCron`, `removeCron`, `listJobs`, and `scheduleOnce` were not awaiting `KyselyJobStore` async operations. `listJobs()` always returned `[]` because it checked `Array.isArray(Promise)`. Made all four methods async with proper `await`. Updated 41 tests to match.
**Files touched:** `src/providers/scheduler/plainjob.ts`, `tests/providers/scheduler/plainjob.test.ts`
**Outcome:** Success — 2409/2409 tests pass. Build clean.
**Notes:** The `MemoryJobStore` (sync) masked the bug in tests. Only `KyselyJobStore` (async, used with PostgreSQL in k8s) was affected. The internal `checkCronJobs` function already awaited correctly, so jobs that DID get persisted would fire — but `addCron` was fire-and-forget meaning DB write failures were silently swallowed.

## [2026-03-03 15:23] — Execute plainjob scheduler acceptance tests

**Task:** Run all 12 acceptance tests from `tests/acceptance/plainjob-scheduler/test-plan.md`
**What I did:** Executed 8 structural tests (source file reads), 2 behavioral tests (live server + chat), 2 integration tests (server restart persistence). All unit tests (35) also confirmed passing via vitest.
**Files touched:** `tests/acceptance/plainjob-scheduler/results.md` (created)
**Outcome:** Success — 12/12 tests passed. No failures, no fixes needed.
**Notes:** PlainJob scheduler implementation is fully compliant with its plan document. SQLiteJobStore, provider wiring, shared utility reuse, tier boundary enforcement, persistence, and rehydration all verified.

## [2026-03-03 09:30] — Design acceptance tests for plainjob scheduler

**Task:** Design acceptance tests for the plainjob scheduler feature against its plan document
**What I did:** Read the plan, explored the full implementation (plainjob.ts, types.ts, utils.ts, provider-map.ts, existing unit tests), and designed 12 acceptance tests: 8 structural, 2 behavioral, 2 integration
**Files touched:** `tests/acceptance/plainjob-scheduler/test-plan.md` (created)
**Outcome:** Success — test plan written but not yet executed (per user request)
**Notes:** Heavy emphasis on structural tests since the scheduler is infrastructure. Behavioral tests verify server startup with plainjob config. Integration tests verify SQLite persistence across server restarts using direct DB injection.

## [2026-03-03 01:10] — Implement plainjob scheduler: SQLite-persisted cron tier

**Task:** Implement `docs/plans/2026-03-02-plainjob-scheduler.md` — add a new `plainjob` scheduler tier that persists jobs to SQLite
**What I did:**
- Created plan document since it didn't exist yet
- Added `SQLiteJobStore` class to `src/providers/scheduler/types.ts` implementing the existing `JobStore` interface backed by SQLite
- Created `src/providers/scheduler/plainjob.ts` — full scheduler provider with SQLite persistence, cron matching, heartbeats, active hours, one-shot scheduling, and all standard SchedulerProvider methods
- Registered `plainjob` in `src/host/provider-map.ts` static allowlist
- Created comprehensive test suite (24 tests) covering: SQLiteJobStore CRUD, persistence across reopens, scheduler lifecycle, cron matching, dedup, runOnce, scheduleOnce, heartbeat, and persistence integration tests
**Files touched:**
- Created: `docs/plans/2026-03-02-plainjob-scheduler.md`
- Created: `src/providers/scheduler/plainjob.ts`
- Created: `tests/providers/scheduler/plainjob.test.ts`
- Modified: `src/providers/scheduler/types.ts` (added SQLiteJobStore)
- Modified: `src/host/provider-map.ts` (added plainjob to allowlist)
**Outcome:** Success — 24/24 tests pass, no regressions in full suite (2 pre-existing failures from memoryfs index.js path pattern)
**Notes:** The plainjob scheduler follows the exact same pattern as cron.ts but with SQLiteJobStore instead of MemoryJobStore. Jobs survive process restarts. No new dependencies needed — uses existing `src/utils/sqlite.ts` adapter.
