# EventBus Provider Journal

## [2026-03-25 17:18] -- Postgres LISTEN/NOTIFY EventBusProvider implementation

**Task:** Create Postgres LISTEN/NOTIFY EventBusProvider as Task 1 of K8s simplification plan.
**What I did:** Created src/providers/eventbus/postgres.ts using Postgres LISTEN/NOTIFY for real-time event distribution. Each event published to two channels: events_global and events_{requestId}. Uses two dedicated pg.Client connections (one for LISTEN, one for NOTIFY). Includes payload size guard (7900 bytes). Added postgres entry to provider-map. Created integration test that skips without POSTGRESQL_URL.
**Files touched:**
  - Created: src/providers/eventbus/postgres.ts, tests/providers/eventbus/postgres.test.ts
  - Modified: src/host/provider-map.ts
**Outcome:** Success. Test file loads and skips correctly without POSTGRESQL_URL. No TypeScript errors introduced. Existing eventbus tests all pass.
**Notes:** Follows same createRequire pattern as database/postgres.ts for pg import. Uses sanitizeChannel() to make requestIds safe for Postgres channel names.

## [2026-03-04 21:05] -- NATS EventBusProvider implementation

**Task:** Implement NATS EventBusProvider (Phase 2 Task 5).
**What I did:** Created src/providers/eventbus/nats.ts using NATS pub/sub. Subject mapping: emit() publishes to events.{requestId} AND events.global. Subscribes to events.global for global listeners and events.* wildcard for per-request routing. Lazy-imports nats module.
**Files touched:**
  - Created: src/providers/eventbus/nats.ts
  - Modified: src/host/provider-map.ts
**Outcome:** Success. Added to provider-map. Full test suite unchanged.
**Notes:** Used `Awaited<ReturnType<typeof connect>>` for NATS connection type since `type` keyword can't be used in dynamic import destructuring.

## [2026-03-04 18:45] -- Implement EventBusProvider interface + InProcess implementation

**Task:** Create the EventBusProvider abstraction with an InProcess implementation that wraps the existing createEventBus() function. Phase 1 Task 2 of K8s agent compute architecture.
**What I did:** Defined EventBusProvider interface in types.ts that matches the existing EventBus interface plus close(). Created inprocess implementation that delegates to createEventBus(). Updated provider-map, registry, config, types, and server.ts. Refactored server.ts to use providers.eventbus instead of direct createEventBus() call (moved eventBus creation after loadProviders).
**Files touched:**
  - Created: src/providers/eventbus/types.ts, src/providers/eventbus/inprocess.ts, tests/providers/eventbus/inprocess.test.ts
  - Modified: src/host/provider-map.ts, src/host/registry.ts, src/types.ts, src/config.ts, src/host/server.ts
**Outcome:** Success. Build passes, all 9 new tests pass, full test suite passes (2326/2329; 3 pre-existing failures in skills-install unrelated).
**Notes:** Moved eventBus creation after loadProviders() in server.ts. The server.config and server.providers events are now emitted slightly later (after provider loading) but this only affects display ordering and has no functional impact.
