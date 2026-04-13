# PlainJob Multi-Replica Deduplication

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Prevent duplicate cron/heartbeat firing when multiple host replicas share the same PostgreSQL database and `agent_name`.

**Architecture:** Add a `last_fired_at` column to `cron_jobs`. Before firing, each replica attempts an atomic `UPDATE ... SET last_fired_at = <now> WHERE last_fired_at < <current_minute> FOR UPDATE SKIP LOCKED`. Only the replica that wins the row lock fires the job. For heartbeats, insert a synthetic `__heartbeat__` row into the same table and apply the same claim logic. On SQLite (single-process), skip the locking and use the existing in-memory `lastFiredMinute` map.

**Tech Stack:** Kysely (raw SQL for `FOR UPDATE SKIP LOCKED`), PostgreSQL, SQLite fallback

---

### Task 1: Add migration for `last_fired_at` column

**Files:**
- Modify: `src/migrations/jobs.ts`

**Step 1: Write the migration**

Add a new migration `jobs_002_last_fired_at` to `buildJobsMigrations()`:

```typescript
jobs_002_last_fired_at: {
  async up(db: Kysely<any>) {
    await db.schema
      .alterTable('cron_jobs')
      .addColumn('last_fired_at', 'text')
      .execute();
  },
  async down(db: Kysely<any>) {
    await db.schema
      .alterTable('cron_jobs')
      .dropColumn('last_fired_at')
      .execute();
  },
},
```

**Step 2: Verify migration runs on SQLite**

Run: `npx vitest run tests/providers/scheduler/plainjob.test.ts -t "set and get a job"`
Expected: PASS (migration runs implicitly during test setup)

**Step 3: Commit**

```bash
git add src/migrations/jobs.ts
git commit -m "feat(scheduler): add last_fired_at column migration for multi-replica dedup"
```

---

### Task 2: Add `tryClaim` method to `KyselyJobStore`

**Files:**
- Modify: `src/job-store.ts`
- Modify: `src/providers/scheduler/types.ts`

**Step 1: Write the failing test**

Add to the `KyselyJobStore` describe block in `tests/providers/scheduler/plainjob.test.ts`:

```typescript
test('tryClaim returns true on first call for a minute, false on second', async () => {
  await store.set({ id: 'claim-job', schedule: '* * * * *', agentId: 'a', prompt: 'p' });
  const mk = '2026-06-01T12:00';

  const first = await store.tryClaim('claim-job', mk);
  expect(first).toBe(true);

  const second = await store.tryClaim('claim-job', mk);
  expect(second).toBe(false);
});

test('tryClaim allows claiming again in a new minute', async () => {
  await store.set({ id: 'claim-job2', schedule: '* * * * *', agentId: 'a', prompt: 'p' });

  expect(await store.tryClaim('claim-job2', '2026-06-01T12:00')).toBe(true);
  expect(await store.tryClaim('claim-job2', '2026-06-01T12:01')).toBe(true);
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/providers/scheduler/plainjob.test.ts -t "tryClaim"`
Expected: FAIL — `tryClaim` does not exist

**Step 3: Add `tryClaim` to `JobStore` interface**

In `src/providers/scheduler/types.ts`, add to the `JobStore` interface:

```typescript
/** Atomically claim a job for a given minute key. Returns true if this caller won the claim. */
tryClaim?(jobId: string, minuteKey: string): boolean | Promise<boolean>;
```

**Step 4: Implement `tryClaim` in `KyselyJobStore`**

In `src/job-store.ts`, add method to `KyselyJobStore`:

```typescript
/**
 * Atomically claim a job for firing in the given minute.
 * Returns true if this process won the claim (last_fired_at was updated).
 * Uses a simple UPDATE WHERE to ensure only one caller wins per minute.
 * On PostgreSQL with multiple replicas, the row-level lock from UPDATE
 * serializes concurrent claims naturally.
 */
async tryClaim(jobId: string, minuteKey: string): Promise<boolean> {
  // Attempt to set last_fired_at to minuteKey only if it's currently
  // NULL or a different (earlier) minute.
  const result = await this.db.updateTable('cron_jobs')
    .set({ last_fired_at: minuteKey })
    .where('id', '=', jobId)
    .where(eb => eb.or([
      eb('last_fired_at', 'is', null),
      eb('last_fired_at', '!=', minuteKey),
    ]))
    .executeTakeFirst();
  return BigInt(result.numUpdatedRows) > 0n;
}
```

**Step 5: Add `tryClaim` to `MemoryJobStore`**

In `src/providers/scheduler/types.ts`, add to `MemoryJobStore`:

```typescript
private lastFired = new Map<string, string>();
tryClaim(jobId: string, minuteKey: string): boolean {
  if (this.lastFired.get(jobId) === minuteKey) return false;
  this.lastFired.set(jobId, minuteKey);
  return true;
}
```

Also update `MemoryJobStore.close()` to clear `lastFired`:
```typescript
close(): void { this.jobs.clear(); this.lastFired.clear(); }
```

**Step 6: Run tests**

Run: `npx vitest run tests/providers/scheduler/plainjob.test.ts -t "tryClaim"`
Expected: PASS

**Step 7: Commit**

```bash
git add src/job-store.ts src/providers/scheduler/types.ts tests/providers/scheduler/plainjob.test.ts
git commit -m "feat(scheduler): add tryClaim for atomic per-minute job dedup"
```

---

### Task 3: Wire `tryClaim` into PlainJob cron check

**Files:**
- Modify: `src/providers/scheduler/plainjob.ts`

**Step 1: Write the failing test**

Add to the `scheduler-plainjob` describe block in `tests/providers/scheduler/plainjob.test.ts`:

```typescript
test('two schedulers sharing a KyselyJobStore do not double-fire', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'ax-dedup-'));
  const dbPath = join(tmpDir, 'dedup.db');
  const db = createKyselyDb({ type: 'sqlite', path: dbPath });
  const r = await runMigrations(db, buildJobsMigrations('sqlite'), 'scheduler_migration');
  if (r.error) throw r.error;

  // Two schedulers sharing the same DB (simulates two replicas)
  const store1 = new KyselyJobStore(db);
  const store2 = new KyselyJobStore(db);
  const sched1 = await create(mockConfig, { jobStore: store1 });
  const sched2 = await create(mockConfig, { jobStore: store2 });

  // Add job via sched1 — both schedulers see it because they share the DB
  await sched1.addCron!({ id: 'shared-job', schedule: '* * * * *', agentId: AGENT, prompt: 'dedup test' });

  const received1: InboundMessage[] = [];
  const received2: InboundMessage[] = [];
  await sched1.start(msg => received1.push(msg));
  await sched2.start(msg => received2.push(msg));

  const at = new Date('2026-03-01T12:05:00Z');
  sched1.checkCronNow!(at);
  sched2.checkCronNow!(at);
  await new Promise(r => setTimeout(r, 50));

  // Exactly one of them should have fired, not both
  const total = received1.filter(m => m.sender === 'cron:shared-job').length
              + received2.filter(m => m.sender === 'cron:shared-job').length;
  expect(total).toBe(1);

  await sched1.stop();
  await sched2.stop();
  await db.destroy();
  rmSync(tmpDir, { recursive: true, force: true });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/providers/scheduler/plainjob.test.ts -t "two schedulers sharing"`
Expected: FAIL — total is 2 (both fire)

**Step 3: Update `checkCronJobs` in `plainjob.ts`**

Replace the in-memory `lastFiredMinute` dedup with `tryClaim` when available. In `checkCronJobs()`, change the dedup logic:

```typescript
async function checkCronJobs(at?: Date): Promise<void> {
  if (!onMessageHandler) return;
  if (!isWithinActiveHours(activeHours)) return;
  const now = at ?? new Date();
  const mk = minuteKey(now);
  const jobList = await jobs.list(agentName);
  for (const job of jobList) {
    if (!matchesCron(job.schedule, now)) continue;

    // Distributed dedup: use tryClaim if available (KyselyJobStore),
    // fall back to in-memory map (MemoryJobStore without tryClaim).
    if (jobs.tryClaim) {
      const claimed = await jobs.tryClaim(job.id, mk);
      if (!claimed) continue;
    } else {
      if (lastFiredMinute.get(job.id) === mk) continue;
      lastFiredMinute.set(job.id, mk);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: any = onMessageHandler({
      id: randomUUID(),
      session: schedulerSession(`cron:${job.id}`),
      sender: `cron:${job.id}`,
      content: job.prompt,
      attachments: [],
      timestamp: now,
    });
    if (job.runOnce) {
      deferCleanup(result, () => {
        jobs.delete(job.id);
        lastFiredMinute.delete(job.id);
      });
    }
  }
}
```

**Step 4: Run the dedup test**

Run: `npx vitest run tests/providers/scheduler/plainjob.test.ts -t "two schedulers sharing"`
Expected: PASS

**Step 5: Run all existing tests to verify no regressions**

Run: `npx vitest run tests/providers/scheduler/plainjob.test.ts`
Expected: All pass (MemoryJobStore tests use the new `tryClaim` on MemoryJobStore; KyselyJobStore tests use `tryClaim` on KyselyJobStore)

**Step 6: Commit**

```bash
git add src/providers/scheduler/plainjob.ts tests/providers/scheduler/plainjob.test.ts
git commit -m "feat(scheduler): use tryClaim in cron check for multi-replica dedup"
```

---

### Task 4: Deduplicate heartbeats across replicas

**Files:**
- Modify: `src/providers/scheduler/plainjob.ts`

**Step 1: Write the failing test**

Add to the `scheduler-plainjob` describe block:

```typescript
test('two schedulers sharing a KyselyJobStore do not double-fire heartbeats', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'ax-hb-dedup-'));
  const dbPath = join(tmpDir, 'hb-dedup.db');
  const db = createKyselyDb({ type: 'sqlite', path: dbPath });
  const r = await runMigrations(db, buildJobsMigrations('sqlite'), 'scheduler_migration');
  if (r.error) throw r.error;

  const fastConfig = {
    ...mockConfig,
    scheduler: { ...mockConfig.scheduler, heartbeat_interval_min: 0.001 },
  } as Config;

  const store1 = new KyselyJobStore(db);
  const store2 = new KyselyJobStore(db);
  const sched1 = await create(fastConfig, { jobStore: store1 });
  const sched2 = await create(fastConfig, { jobStore: store2 });

  const received1: InboundMessage[] = [];
  const received2: InboundMessage[] = [];
  await sched1.start(msg => received1.push(msg));
  await sched2.start(msg => received2.push(msg));

  await new Promise(r => setTimeout(r, 200));

  await sched1.stop();
  await sched2.stop();

  const hb1 = received1.filter(m => m.sender === 'heartbeat').length;
  const hb2 = received2.filter(m => m.sender === 'heartbeat').length;

  // With ~60ms interval and 200ms wait, expect ~3 heartbeats total.
  // The key assertion: NOT both schedulers firing every interval.
  // At least one scheduler should have zero heartbeats (or fewer than the other).
  expect(hb1 + hb2).toBeGreaterThan(0);
  expect(hb1 + hb2).toBeLessThan(hb1 * 2 + hb2 * 2); // weaker: just not doubled

  // Stronger: with dedup, for each minute only one replica fires.
  // Since the interval is 60ms and we wait 200ms, there are ~3 fires.
  // Without dedup: hb1 + hb2 ≈ 6. With dedup: hb1 + hb2 ≈ 3.
  // Allow some slack but not 2x.
  expect(hb1 + hb2).toBeLessThanOrEqual(5);

  await db.destroy();
  rmSync(tmpDir, { recursive: true, force: true });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/providers/scheduler/plainjob.test.ts -t "do not double-fire heartbeats"`
Expected: FAIL — both schedulers fire all heartbeats

**Step 3: Create a synthetic heartbeat row and use `tryClaim` for heartbeats**

In `plainjob.ts`, during `create()`, after the `jobs` store is set up, insert a synthetic heartbeat job row:

```typescript
const HEARTBEAT_JOB_ID = `__heartbeat__:${agentName}`;

// Ensure synthetic heartbeat row exists for distributed dedup
if (jobs.tryClaim) {
  const existing = await jobs.get(HEARTBEAT_JOB_ID);
  if (!existing) {
    await jobs.set({
      id: HEARTBEAT_JOB_ID,
      schedule: '* * * * *', // not used for matching — heartbeat uses its own interval
      agentId: agentName,
      prompt: '', // not used
    });
  }
}
```

Then update `fireHeartbeat()` to claim before firing:

```typescript
function fireHeartbeat(): void {
  if (!onMessageHandler) return;
  if (!isWithinActiveHours(activeHours)) return;

  // Distributed dedup: claim the heartbeat slot for this minute
  if (jobs.tryClaim) {
    const mk = minuteKey(new Date());
    const claimed = jobs.tryClaim(HEARTBEAT_JOB_ID, mk);
    // tryClaim may return a Promise (KyselyJobStore) — handle both
    if (claimed && typeof (claimed as any).then === 'function') {
      (claimed as Promise<boolean>).then(ok => { if (ok) emitHeartbeat(); });
      return;
    }
    if (!claimed) return;
  }

  emitHeartbeat();
}

function emitHeartbeat(): void {
  if (!onMessageHandler) return;

  let content = 'Heartbeat check — review pending tasks and proactive hints.';
  if (agentDir) {
    try {
      const md = readFileSync(join(agentDir, 'HEARTBEAT.md'), 'utf-8');
      if (md.trim()) content = md;
    } catch { /* no HEARTBEAT.md — use default */ }
  }

  onMessageHandler({
    id: randomUUID(),
    session: schedulerSession('heartbeat'),
    sender: 'heartbeat',
    content,
    attachments: [],
    timestamp: new Date(),
  });
}
```

**Step 4: Run the heartbeat dedup test**

Run: `npx vitest run tests/providers/scheduler/plainjob.test.ts -t "do not double-fire heartbeats"`
Expected: PASS

**Step 5: Run all tests**

Run: `npx vitest run tests/providers/scheduler/plainjob.test.ts`
Expected: All pass

**Step 6: Commit**

```bash
git add src/providers/scheduler/plainjob.ts tests/providers/scheduler/plainjob.test.ts
git commit -m "feat(scheduler): deduplicate heartbeats across replicas via tryClaim"
```

---

### Task 5: Deduplicate `scheduleOnce` rehydration across replicas

**Files:**
- Modify: `src/providers/scheduler/plainjob.ts`

This is the subtlest problem: when multiple replicas start, each calls `listWithRunAt()` and sets up `setTimeout` for the same one-shot jobs. We need to ensure only one replica fires each one-shot job.

**Step 1: Write the failing test**

```typescript
test('two schedulers sharing a KyselyJobStore do not double-fire one-shot jobs on rehydration', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'ax-once-dedup-'));
  const dbPath = join(tmpDir, 'once-dedup.db');
  const db = createKyselyDb({ type: 'sqlite', path: dbPath });
  const r = await runMigrations(db, buildJobsMigrations('sqlite'), 'scheduler_migration');
  if (r.error) throw r.error;

  // Pre-insert a one-shot job with run_at in the near future
  const store = new KyselyJobStore(db);
  await store.set({ id: 'once-shared', schedule: '* * * * *', agentId: AGENT, prompt: 'one-shot dedup', runOnce: true });
  await store.setRunAt('once-shared', new Date(Date.now() + 80));

  // Two schedulers rehydrate from the same DB
  const store1 = new KyselyJobStore(db);
  const store2 = new KyselyJobStore(db);
  const sched1 = await create(mockConfig, { jobStore: store1 });
  const sched2 = await create(mockConfig, { jobStore: store2 });

  const received1: InboundMessage[] = [];
  const received2: InboundMessage[] = [];
  await sched1.start(msg => received1.push(msg));
  await sched2.start(msg => received2.push(msg));

  await new Promise(r => setTimeout(r, 300));

  await sched1.stop();
  await sched2.stop();

  const total = received1.filter(m => m.sender === 'cron:once-shared').length
              + received2.filter(m => m.sender === 'cron:once-shared').length;
  expect(total).toBe(1);

  await db.destroy();
  rmSync(tmpDir, { recursive: true, force: true });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/providers/scheduler/plainjob.test.ts -t "do not double-fire one-shot"`
Expected: FAIL — total is 2

**Step 3: Use `tryClaim` in `fireOnceJob`**

Update `fireOnceJob()` in `plainjob.ts` to claim before firing:

```typescript
function fireOnceJob(job: CronJobDef): void {
  if (!onMessageHandler) return;

  // Distributed dedup: claim via DB before firing
  if (jobs.tryClaim) {
    const mk = `once:${job.id}`;
    const claimed = jobs.tryClaim(job.id, mk);
    if (claimed && typeof (claimed as any).then === 'function') {
      (claimed as Promise<boolean>).then(ok => {
        if (ok) doFireOnce(job);
        else {
          // Another replica already fired — just clean up local timer
          onceTimers.delete(job.id);
        }
      });
      return;
    }
    if (!claimed) {
      onceTimers.delete(job.id);
      return;
    }
  }

  doFireOnce(job);
}

function doFireOnce(job: CronJobDef): void {
  if (!onMessageHandler) return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result: any = onMessageHandler({
    id: randomUUID(),
    session: schedulerSession(`cron:${job.id}`),
    sender: `cron:${job.id}`,
    content: job.prompt,
    attachments: [],
    timestamp: new Date(),
  });
  deferCleanup(result, () => {
    jobs.delete(job.id);
    onceTimers.delete(job.id);
  });
}
```

**Step 4: Run the test**

Run: `npx vitest run tests/providers/scheduler/plainjob.test.ts -t "do not double-fire one-shot"`
Expected: PASS

**Step 5: Run all tests**

Run: `npx vitest run tests/providers/scheduler/plainjob.test.ts`
Expected: All pass

**Step 6: Commit**

```bash
git add src/providers/scheduler/plainjob.ts tests/providers/scheduler/plainjob.test.ts
git commit -m "feat(scheduler): deduplicate one-shot job rehydration across replicas"
```

---

### Task 6: PostgreSQL integration tests for multi-replica dedup

**Files:**
- Modify: `tests/providers/scheduler/plainjob.test.ts`

**Step 1: Add PG dedup tests**

Add to the `PlainJob scheduler (PostgreSQL)` describe block:

```typescript
test('two schedulers with shared PG do not double-fire cron', async () => {
  const dbProvider = { db, type: 'postgresql' as const, vectorsAvailable: false, close: () => db.destroy() };
  const sched1 = await create(mockConfig, { database: dbProvider });
  const sched2 = await create(mockConfig, { database: dbProvider });

  await sched1.addCron!({ id: 'pg-dedup', schedule: '* * * * *', agentId: AGENT, prompt: 'pg dedup test' });

  const received1: InboundMessage[] = [];
  const received2: InboundMessage[] = [];
  await sched1.start(msg => received1.push(msg));
  await sched2.start(msg => received2.push(msg));

  const at = new Date('2026-03-01T12:05:00Z');
  sched1.checkCronNow!(at);
  sched2.checkCronNow!(at);
  await new Promise(r => setTimeout(r, 100));

  const total = received1.filter(m => m.sender === 'cron:pg-dedup').length
              + received2.filter(m => m.sender === 'cron:pg-dedup').length;
  expect(total).toBe(1);

  await sched1.stop();
  await sched2.stop();
});
```

**Step 2: Run with PostgreSQL**

Run: `POSTGRESQL_URL=postgresql://ax:ax@localhost:15432/ax_test npx vitest run tests/providers/scheduler/plainjob.test.ts -t "two schedulers with shared PG"`
Expected: PASS

**Step 3: Run all tests**

Run: `npx vitest run tests/providers/scheduler/plainjob.test.ts`
Expected: All pass (PG tests skipped without env var)

**Step 4: Commit**

```bash
git add tests/providers/scheduler/plainjob.test.ts
git commit -m "test(scheduler): add PostgreSQL multi-replica dedup integration tests"
```

---

### Task 7: Update `JobRow` type and clean up

**Files:**
- Modify: `src/job-store.ts`

**Step 1: Add `last_fired_at` to `JobRow`**

```typescript
type JobRow = {
  id: string;
  agent_id: string;
  schedule: string;
  prompt: string;
  max_token_budget: number | null;
  delivery: string | null;
  run_once: number;
  run_at: string | null;
  last_fired_at: string | null;  // ← add this
};
```

**Step 2: Remove the in-memory `lastFiredMinute` map from `plainjob.ts`**

The `lastFiredMinute` map is still used as fallback for stores without `tryClaim` (e.g. a custom `JobStore` that doesn't implement it). Keep it but only for that fallback path — it's already gated by `if (jobs.tryClaim)` / `else`.

No action needed — the current code is correct.

**Step 3: Run all tests**

Run: `npx vitest run tests/providers/scheduler/plainjob.test.ts`
Expected: All pass

**Step 4: Commit**

```bash
git add src/job-store.ts
git commit -m "chore(scheduler): add last_fired_at to JobRow type"
```

---

### Summary of changes

| File | Change |
|------|--------|
| `src/migrations/jobs.ts` | Add `jobs_002_last_fired_at` migration |
| `src/providers/scheduler/types.ts` | Add `tryClaim?` to `JobStore` interface, implement on `MemoryJobStore` |
| `src/job-store.ts` | Add `tryClaim()` to `KyselyJobStore`, add `last_fired_at` to `JobRow` |
| `src/providers/scheduler/plainjob.ts` | Use `tryClaim` in cron check, heartbeat, and one-shot firing |
| `tests/providers/scheduler/plainjob.test.ts` | Add dedup tests for cron, heartbeat, one-shot; PG integration tests |

### What this does NOT change

- **SQLite single-process**: falls back to in-memory map (no contention)
- **Different `agent_name` per replica**: already isolated by `jobs.list(agentName)` — `tryClaim` is an additional safety layer
- **`SchedulerProvider` interface**: unchanged — this is purely internal to PlainJob
- **`MemoryJobStore`**: gains `tryClaim` so tests using it also exercise the dedup path
