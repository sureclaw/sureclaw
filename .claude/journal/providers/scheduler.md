# Scheduler Provider Journal

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
