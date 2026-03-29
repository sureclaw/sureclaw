---
name: ax-provider-eventbus
description: Use when modifying the event bus — in-process pub/sub, NATS pub/sub, or streaming event routing in src/providers/eventbus/
---

## Overview

The event bus provides real-time typed pub/sub for completion observability. Abstracts between in-process (Phase 1) and NATS (Phase 2 for k8s). Components emit `StreamEvent`s; listeners subscribe globally or per-request.

## Interface (`src/providers/eventbus/types.ts`)

### EventBusProvider

| Method                                          | Description                                      |
|-------------------------------------------------|--------------------------------------------------|
| `emit(event: StreamEvent)`                      | Publish an event to all matching listeners        |
| `subscribe(listener: EventListener)`            | Global subscription; returns unsubscribe function |
| `subscribeRequest(requestId, listener)`          | Per-request subscription; returns unsubscribe     |
| `listenerCount()`                                | Number of active listeners                        |
| `close()`                                        | Tear down the bus and all subscriptions           |

## Implementations

| Provider    | File            | Transport      | Notes                                       |
|-------------|-----------------|----------------|---------------------------------------------|
| `inprocess` | `inprocess.ts`  | In-memory      | Wraps existing `createEventBus()`; no-op close() |
| `nats`      | `nats.ts`       | NATS pub/sub   | Dual-subject routing; listener eviction at capacity |
| `postgres`  | `postgres.ts`   | PostgreSQL `LISTEN/NOTIFY` | Persistent pub/sub via PostgreSQL; no NATS dependency |

Provider map entries in `src/host/provider-map.ts`:
```
eventbus: {
  inprocess: '../providers/eventbus/inprocess.js',
  nats:      '../providers/eventbus/nats.js',
  postgres:  '../providers/eventbus/postgres.js',
}
```

## In-Process Details

- Wraps the existing `createEventBus()` utility function.
- Synchronous event delivery within the process.
- `close()` is a no-op (listeners are garbage-collected with the process).

## NATS Details

- Uses core NATS pub/sub with dual-subject routing: `events.global` + `events.{requestId}`.
- Connection options use `natsConnectOptions('eventbus')` from `src/utils/nats.ts` for consistent server URL, auth, and reconnect behavior across all NATS callers.
- Listener eviction when hitting capacity — oldest listener removed first (warn log only).
- `create()` is async (connects to NATS); in-process is sync — caller must handle both.
- Connection failures throw hard (no graceful degradation).
- In k8s deployments, the NATS event bus also participates in the IPC routing context — NATS carries not just events but also IPC request/reply and LLM proxy traffic. All these connections share the same `natsConnectOptions()` utility for server/auth configuration.

## PostgreSQL Details

- Uses PostgreSQL `LISTEN`/`NOTIFY` for event routing with dual-channel pattern: `events_global` + `events_{requestId}`.
- Requires injected `DatabaseProvider` (PostgreSQL instance).
- Events serialized as JSON in NOTIFY payload.
- Suitable for k8s deployments that don't want a NATS dependency.
- `create()` is async (connects to database).

## Common Tasks

**Adding a new event bus implementation:**
1. Create `src/providers/eventbus/<name>.ts` implementing `EventBusProvider`.
2. Export `create(config: Config)`.
3. Add entry to `PROVIDER_MAP` in `src/host/provider-map.ts`.
4. Add tests in `tests/providers/eventbus/<name>.test.ts`.

## Gotchas

- **NATS create is async, in-process is sync**: Caller code must handle both patterns.
- **Listener eviction is silent**: When NATS hits capacity, the oldest listener is removed with only a warn log. No error thrown.
- **Event listener errors are swallowed**: Errors in listeners are logged at warn level but don't stop event processing.
- **NATS connection failures are fatal**: Unlike listener errors, connection failures throw immediately.
- **EventBus should be optional and synchronous**: Design principle — never block the hot path with bus operations.
- **Always use `natsConnectOptions()`**: Never construct NATS connection options by hand. The `src/utils/nats.ts` helper centralizes server URL, auth (NATS_USER/NATS_PASS), and reconnect settings. All NATS callers (eventbus, IPC handler, LLM proxy, runner, bridge) use it.

## Key Files

- `src/providers/eventbus/types.ts` — Interface definitions
- `src/providers/eventbus/inprocess.ts` — In-process implementation
- `src/providers/eventbus/nats.ts` — NATS pub/sub implementation
- `src/providers/eventbus/postgres.ts` — PostgreSQL LISTEN/NOTIFY implementation
- `src/utils/nats.ts` — Shared `natsConnectOptions()` helper (server URL, auth, reconnect)
- `tests/providers/eventbus/inprocess.test.ts`
