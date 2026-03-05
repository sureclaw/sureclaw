# Acceptance Test Results: PlainJob Scheduler

**Date run:** 2026-03-05 13:44
**Server version:** 2526aad
**LLM provider:** openrouter/google/gemini-3-flash-preview

## Summary

| Test | Category | Result | Notes |
|------|----------|--------|-------|
| ST-1 | Structural | PASS | SQLiteJobStore exported, implements all JobStore methods + setRunAt/listWithRunAt |
| ST-2 | Structural | PASS | plainjob.ts exports create(config), returns full SchedulerProvider |
| ST-3 | Structural | PASS | `plainjob: '../providers/scheduler/plainjob.js'` in provider-map scheduler section |
| ST-4 | Structural | PASS | scheduler_jobs table with correct schema incl. run_at, run_once, agent_id |
| ST-5 | Structural | PASS | Imports matchesCron, isWithinActiveHours, minuteKey, parseTime from ./utils.js |
| ST-6 | Structural | PASS | No proactive hint logic, no token budget tracking — only cron/heartbeat/scheduleOnce |
| ST-7 | Structural | PASS | addCron → jobs.set() (INSERT OR REPLACE), removeCron → jobs.delete() (DELETE) |
| ST-8 | Structural | PASS | 32 unit tests covering lifecycle, CRUD, persistence, cron, runOnce, dedup, scheduleOnce, heartbeat, async cleanup, rehydration |
| BT-1 | Behavioral | PASS | Server starts, health returns 200, agent responds normally, no scheduler errors in logs |
| BT-2 | Behavioral | PASS | scheduler.db created under data/, scheduler_jobs table matches plan schema, WAL mode enabled |
| IT-1 | Integration | PASS | Cron job inserted into SQLite survived full server restart with all fields intact, no duplicates |
| IT-2 | Integration | PASS | One-shot job with run_at timestamp survived restart, run_once=1 and run_at preserved |

**Overall: 12/12 passed**

## Detailed Results

### ST-1: SQLiteJobStore exists in scheduler types
**Result:** PASS
**Evidence:**
- `src/providers/scheduler/types.ts:42` — `export class SQLiteJobStore implements JobStore`
- Constructor at line 46 accepts `db: SQLiteDatabase`
- Implements: `get` (line 64), `set` (line 69), `delete` (line 84), `list` (line 90), `close` (line 113)
- Additional methods: `setRunAt` (line 98), `listWithRunAt` (line 104)

### ST-2: plainjob provider exports create()
**Result:** PASS
**Evidence:**
- File exists at `src/providers/scheduler/plainjob.ts`
- `export async function create(config: Config, deps: PlainJobSchedulerDeps = {}): Promise<SchedulerProvider>` at line 19
- Returns object with: `start` (142), `stop` (165), `addCron` (185), `removeCron` (189), `listJobs` (198), `scheduleOnce` (202), `checkCronNow` (213)

### ST-3: plainjob registered in provider-map
**Result:** PASS
**Evidence:**
- `src/host/provider-map.ts:84` — `plainjob: '../providers/scheduler/plainjob.js'`

### ST-4: scheduler_jobs table schema matches plan
**Result:** PASS
**Evidence:**
```sql
CREATE TABLE scheduler_jobs (
    id          TEXT PRIMARY KEY,
    schedule    TEXT NOT NULL,
    agent_id    TEXT NOT NULL,
    prompt      TEXT NOT NULL,
    max_token_budget INTEGER,
    delivery    TEXT,
    run_once    INTEGER NOT NULL DEFAULT 0,
    run_at      TEXT
)
```
All required columns present with correct types.

### ST-5: plainjob reuses shared utilities
**Result:** PASS
**Evidence:**
- `plainjob.ts:10-13` imports: `ActiveHours`, `schedulerSession`, `parseTime`, `isWithinActiveHours`, `matchesCron`, `minuteKey` from `./utils.js`
- No local reimplementation of cron matching, active hours, or minute key logic

### ST-6: Tier boundary — no proactive hints or token budget
**Result:** PASS
**Evidence:**
- Grep for `proactive|hint|token_budget|confidence_threshold` in plainjob.ts: only match is default heartbeat message text "review pending tasks and proactive hints" (a string constant, not logic)
- `full.ts` has extensive proactive hint logic: `handleProactiveHint()`, confidence thresholds, cooldown, `recordTokenUsage()`, `listPendingHints()`
- plainjob.ts does NOT export `recordTokenUsage` or `listPendingHints`

### ST-7: SQLite persistence on addCron / removeCron
**Result:** PASS
**Evidence:**
- `addCron()` at line 185: `jobs.set(job)` → `SQLiteJobStore.set()` at line 69 uses `INSERT OR REPLACE INTO scheduler_jobs`
- `removeCron()` at line 189: `jobs.delete(jobId)` → `SQLiteJobStore.delete()` at line 84 uses `DELETE FROM scheduler_jobs WHERE id = ?`

### ST-8: Comprehensive tests exist
**Result:** PASS
**Evidence:**
- `tests/providers/scheduler/plainjob.test.ts` — 32 tests (10 SQLiteJobStore unit + 22 scheduler provider)
- Lifecycle: "starts and stops without error", "stop clears all timers"
- CRUD: "addCron and listJobs", "removeCron removes a job"
- Agent filtering: "listJobs only returns jobs for this agent", "checkCronNow only fires jobs for this agent", "agent_name config overrides"
- SQLite persistence: "jobs persist across provider recreates", "persists across database reopens", "removed jobs do not reappear after restart"
- Cron matching: "cron job fires on matching minute via checkCronNow"
- Dedup: "cron job fires only once per matching minute (dedup)"
- runOnce: "runOnce job fires once and is auto-deleted"
- scheduleOnce: "scheduleOnce fires job via setTimeout and auto-deletes", "job is still in store when async handler runs", "job can be cancelled via removeCron"
- Heartbeat: "fires within active hours", "uses default content", "includes HEARTBEAT.md content"
- Async cleanup: "stop waits for in-flight async cleanup before closing DB"
- Rehydration: "scheduleOnce persists run_at", "one-shot jobs are rehydrated on start", "past-due jobs fire immediately", "rehydration skips jobs belonging to other agents"

### BT-1: Server starts with plainjob scheduler
**Result:** PASS
**Evidence:**
- Server started with `providers.scheduler: plainjob` in ax.yaml
- `ax.sock` exists
- `GET /health` returned `{"status":"ok"}`
- Sent `hello` via `ax send` — agent responded: "Hello. How can I help you?"
- No scheduler errors in `ax.log`

### BT-2: Scheduler database created on startup
**Result:** PASS
**Evidence:**
- `$TEST_HOME/data/scheduler.db` exists after server startup (12288 bytes)
- `sqlite3 .schema scheduler_jobs` shows correct table with all planned columns
- `PRAGMA journal_mode` returns `wal`

### IT-1: Cron jobs persist across server restart
**Result:** PASS
**Evidence:**
- Inserted test job: `INSERT INTO scheduler_jobs ... VALUES ('test-persist-1', '0 9 * * *', 'main', 'Good morning check', 0)`
- Stopped server (SIGTERM), restarted with same TEST_HOME
- Queried: `SELECT ... WHERE id = 'test-persist-1'` — returned `test-persist-1|0 9 * * *|main|Good morning check`
- Count check: exactly 1 row (no duplicates)

### IT-2: One-shot job run_at persists for rehydration
**Result:** PASS
**Evidence:**
- Inserted one-shot job with future run_at: `'oneshot-persist-1', '* * * * *', 'main', 'One-shot reminder', 1, '2026-03-05T18:56:03.000Z'`
- Stopped server, restarted
- Queried: `SELECT id, run_once, run_at ... WHERE id = 'oneshot-persist-1'` — returned `oneshot-persist-1|1|2026-03-05T18:56:03.000Z`
- `run_once` = 1 and `run_at` preserved

### Failures

None — all 12 tests passed.
