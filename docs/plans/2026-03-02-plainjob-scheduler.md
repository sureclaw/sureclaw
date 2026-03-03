# PlainJob Scheduler Implementation Plan

**Goal:** Add a `plainjob` scheduler tier that persists cron jobs and one-shot jobs to SQLite, providing durability across process restarts without requiring external infrastructure like PostgreSQL.

**Architecture:** New `src/providers/scheduler/plainjob.ts` implements `SchedulerProvider` using the existing SQLite adapter (`src/utils/sqlite.ts`). Jobs are stored in a `scheduler_jobs` table. Cron matching, heartbeats, active hours, and one-shot scheduling all reuse existing utilities from `utils.ts`. A `SQLiteJobStore` implements the `JobStore` interface backed by SQLite.

**Position in tier hierarchy:**
- `none` — disabled
- `cron` — in-memory cron + heartbeat (jobs lost on restart)
- **`plainjob`** — SQLite-persisted cron + heartbeat (jobs survive restarts)
- `full` — in-memory cron + heartbeat + proactive hints + token budget

**Tech Stack:** Existing SQLite adapter (`src/utils/sqlite.ts`), no new dependencies.

---

## Prerequisites

None beyond what the project already provides. SQLite is available via the runtime-agnostic adapter.

---

### Task 1: Add SQLiteJobStore to scheduler types

**Files:**
- Modify: `src/providers/scheduler/types.ts`

Add a `SQLiteJobStore` class that implements `JobStore` backed by SQLite. This keeps the job store reusable if other future schedulers want SQLite persistence.

---

### Task 2: Create the plainjob scheduler provider

**Files:**
- Create: `src/providers/scheduler/plainjob.ts`

The provider:
1. Opens (or creates) `scheduler.db` under `dataDir()`
2. Creates a `scheduler_jobs` table if it doesn't exist
3. Loads existing jobs from SQLite on `create()`
4. Delegates cron matching, heartbeat, active hours to shared `utils.ts`
5. Persists addCron/removeCron to SQLite
6. Supports `scheduleOnce()` with setTimeout + SQLite persistence
7. On restart, reloads persisted jobs and re-schedules any pending one-shot jobs

---

### Task 3: Register plainjob in provider map

**Files:**
- Modify: `src/host/provider-map.ts`

Add `plainjob: '../providers/scheduler/plainjob.js'` to the scheduler allowlist.

---

### Task 4: Write tests

**Files:**
- Create: `tests/providers/scheduler/plainjob.test.ts`

Tests cover:
- Lifecycle (start/stop)
- Job CRUD (addCron, listJobs, removeCron)
- SQLite persistence (jobs survive create() calls)
- Cron firing via checkCronNow()
- runOnce auto-deletion
- Dedup (one fire per minute)
- scheduleOnce with setTimeout
- Heartbeat firing
- Job store cleanup on close

---

### Task 5: Full suite validation

Run `npm test` to ensure zero regressions.

---

## Summary

After implementation:
- `src/providers/scheduler/plainjob.ts` — SQLite-persisted scheduler
- `tests/providers/scheduler/plainjob.test.ts` — comprehensive tests
- `src/host/provider-map.ts` — `plainjob` in allowlist

To use: set `providers.scheduler: plainjob` in `ax.yaml`. Jobs persist in `~/.ax/data/scheduler.db`.
