# Provider Lessons: Scheduler

### SQLiteJobStore belongs in types.ts alongside MemoryJobStore
**Date:** 2026-03-03
**Context:** Adding a SQLite-backed JobStore for the plainjob scheduler tier
**Lesson:** The `JobStore` interface and its implementations (MemoryJobStore, SQLiteJobStore) live in `src/providers/scheduler/types.ts`. New JobStore implementations should be added there to keep them reusable across scheduler tiers. The SQLiteJobStore uses INSERT OR REPLACE for upsert and COUNT query for delete return value.
**Tags:** scheduler, sqlite, job-store, types

### Pre-existing provider-map path regex failures
**Date:** 2026-03-03
**Context:** Running full test suite after adding plainjob to provider-map
**Lesson:** Two tests (`provider-map.test.ts` and `phase2.test.ts`) have pre-existing failures because the memoryfs provider path `../providers/memory/memoryfs/index.js` doesn't match the regex `[a-z-]+\.js$`. These are NOT caused by new provider entries. Always verify if test failures are pre-existing before investigating.
**Tags:** testing, provider-map, pre-existing-failures
