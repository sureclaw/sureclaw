# Provider Lessons: Scheduler

### Scheduler must be started in BOTH server.ts AND host-process.ts
**Date:** 2026-03-17
**Context:** The scheduler was never started in k8s because `host-process.ts` (the k8s host entry point) didn't call `scheduler.start()`. Only `server.ts` (standalone mode) had the scheduler lifecycle. IPC handlers worked (list/add/remove jobs) but heartbeat and cron timers never ran.
**Lesson:** Every feature wired in `server.ts` must also be wired in `host-process.ts`. The two files share providers via `loadProviders()` but have separate lifecycle management. After adding any provider lifecycle call (`.start()`, `.stop()`, `.connect()`) to `server.ts`, immediately check if `host-process.ts` needs the same. Keyword: check both entry points.
**Tags:** scheduler, host-process, server, k8s, lifecycle, feature-parity

### LLM IPC handler must use configModel for actual calls, not just logging
**Date:** 2026-03-17
**Context:** `ipc-handlers/llm.ts` computed `effectiveModel = configModel ?? req.model` for logging and context estimation, but the actual `providers.llm.chat()` call used `req.model` directly — ignoring the user's configured model. The agent always sends a default model (e.g., `claude-sonnet-4-5-20250929`), so the configured model was silently unused.
**Lesson:** In `createLLMHandlers`, use `effectiveModel` for the actual LLM call, not just for logging. The `configModel` (from `config.models.default[0]`) is the user's intended model and should take priority over the agent's default.
**Tags:** llm, ipc, model-routing, config

### Scheduler provider methods must await async JobStore operations
**Date:** 2026-03-17
**Context:** `addCron`, `removeCron`, `listJobs`, and `scheduleOnce` in plainjob.ts were sync wrappers around `KyselyJobStore` async methods. In-memory tests passed because `MemoryJobStore` is sync, but PostgreSQL (k8s) broke silently — `listJobs()` always returned `[]` since `Array.isArray(Promise)` is false, and `addCron` fire-and-forgot the DB write.
**Lesson:** When a provider method wraps a `JobStore` (or any store with `T | Promise<T>` return types), always declare the method `async` and `await` the store call. The `SchedulerProvider` interface already allows `void | Promise<void>` returns. Sync-only test fixtures (MemoryJobStore) will NOT catch this — add at least one KyselyJobStore integration test per CRUD method.
**Tags:** scheduler, async, kysely, k8s, postgresql, plainjob

### SQLiteJobStore belongs in types.ts alongside MemoryJobStore
**Date:** 2026-03-03
**Context:** Adding a SQLite-backed JobStore for the plainjob scheduler tier
**Lesson:** The `JobStore` interface and its implementations (MemoryJobStore, SQLiteJobStore) live in `src/providers/scheduler/types.ts`. New JobStore implementations should be added there to keep them reusable across scheduler tiers. The SQLiteJobStore uses INSERT OR REPLACE for upsert and COUNT query for delete return value.
**Tags:** scheduler, sqlite, job-store, types

### Synthetic DB rows for distributed dedup pollute job listings
**Date:** 2026-04-13
**Context:** Inserting a `__heartbeat__:agentName` synthetic row into `cron_jobs` for heartbeat dedup caused the row to appear in `listJobs()` and `checkCronJobs()`, breaking 12 existing tests.
**Lesson:** When inserting synthetic/internal rows into a shared table for distributed coordination, filter them out in ALL query paths that surface data to callers. Use a consistent prefix convention (e.g., `__heartbeat__:`) and check `instanceof KyselyJobStore` rather than `jobs.tryClaim` to avoid inserting synthetic rows for in-memory stores that don't need them.
**Tags:** scheduler, multi-replica, dedup, synthetic-rows, heartbeat

### tryClaim minuteKey dedup is insufficient — need in-flight tracking for long-running jobs
**Date:** 2026-04-13
**Context:** A "create random file" cron job took 68 seconds (LLM looped through 44 bash calls). The next minute's `checkCronJobs()` fired a second concurrent invocation because `minuteKey` had changed, doubling LLM calls and costs.
**Lesson:** `tryClaim(jobId, minuteKey)` only prevents duplicate fires within the *same* minute. For long-running jobs (>60s), you also need per-process in-flight tracking: `if (inFlight.has(job.id)) continue` before firing, `inFlight.add(job.id)` before calling `onMessageHandler`, and `.finally(() => inFlight.delete(job.id))` on the returned Promise. This is a per-process guard (not distributed), which is correct — each replica independently decides whether its own previous invocation is still running.
**Tags:** scheduler, cron, overlap, in-flight, dedup, plainjob

### Pre-existing provider-map path regex failures
**Date:** 2026-03-03
**Context:** Running full test suite after adding plainjob to provider-map
**Lesson:** Two tests (`provider-map.test.ts` and `phase2.test.ts`) have pre-existing failures because the memoryfs provider path `../providers/memory/memoryfs/index.js` doesn't match the regex `[a-z-]+\.js$`. These are NOT caused by new provider entries. Always verify if test failures are pre-existing before investigating.
**Tags:** testing, provider-map, pre-existing-failures
