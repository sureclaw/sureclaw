# Orchestration Enhancements

**Date:** 2026-02-28
**Status:** Implementation

## Problem

AX's server-side orchestration has several gaps that limit reliability under load:

1. **No server-level concurrency control.** Every HTTP request directly calls `processCompletion()` and spawns an agent process. Under load, this means unbounded process creation — each agent gets its own sandbox, IPC socket, and taint budget. Ten simultaneous Slack messages = ten concurrent agent processes.

2. **No request cancellation.** If a client disconnects mid-request, the agent keeps running until it finishes or times out. For long-running completions (coding tasks, multi-tool chains), this wastes compute on results nobody will see.

3. **Delegation rejects immediately at capacity.** When `activeDelegations >= maxConcurrent`, the delegation handler returns an error. The agent has no option but to retry or give up. A short wait queue would be far more useful — agent delegation patterns are bursty, and slots free up quickly.

4. **No request lifecycle tracking.** There's no way to query the state of an in-flight request. The event bus emits events, but there's no queryable state for "is this request still processing?" or "how many requests are queued?"

## Design

### 1. CompletionQueue

A bounded queue that controls how many `processCompletion()` calls run concurrently.

```
HTTP Request → queue.enqueue() → wait for slot → processCompletion() → done
                    ↓ (if full)
               429 Too Many Requests
```

- **`max_concurrent`** (default 5): Max parallel completions.
- **`max_queue_depth`** (default 50): Max pending requests before 429.
- FIFO ordering with callback-based slot release.
- Events: `queue.enqueued`, `queue.started`, `queue.done`, `queue.rejected`.

### 2. Request Cancellation

Propagate `AbortSignal` through the completion pipeline:

- Create `AbortController` per HTTP request.
- On client disconnect (`req.on('close')`), call `abort()`.
- `processCompletion()` checks signal before spawning agent and after.
- Emit `completion.cancelled` event.

### 3. Delegation Wait Queue

Replace immediate rejection with a bounded wait:

- **`queue_timeout_ms`** (default 30000): Max time to wait for a slot.
- When at capacity, delegation requests wait in a FIFO queue.
- When a slot frees up, the next waiter is resolved.
- If timeout expires before a slot opens, return error.

### 4. Request Tracker

Queryable request lifecycle state:

- States: `queued` → `processing` → `done` | `error` | `cancelled`.
- Exposed via `GET /v1/requests/:id` endpoint.
- Auto-cleanup of completed entries after 5 minutes.
- Summary stats via `GET /v1/requests` (counts by state).

## Config

```yaml
orchestration:
  max_concurrent: 5
  max_queue_depth: 50
  request_timeout_ms: 600000

delegation:
  max_concurrent: 3
  max_depth: 2
  queue_timeout_ms: 30000
```

## Files

| File | Change |
|------|--------|
| `src/host/completion-queue.ts` | New: bounded concurrent execution queue |
| `src/host/request-tracker.ts` | New: request lifecycle tracking |
| `src/host/ipc-handlers/delegation.ts` | Add wait-with-timeout queue |
| `src/host/server.ts` | Wire queue, tracker, cancellation, new endpoints |
| `src/host/server-completions.ts` | Accept AbortSignal |
| `src/types.ts` | Add orchestration config fields |
| `src/config.ts` | Add orchestration schema |
| `tests/host/completion-queue.test.ts` | New tests |
| `tests/host/request-tracker.test.ts` | New tests |
| `tests/host/delegation-hardening.test.ts` | Update for queue behavior |

## Security Notes

- Queue depth limit prevents memory exhaustion from request floods.
- AbortSignal propagation prevents wasted compute.
- Delegation queue timeout prevents indefinite waiting.
- All new events go through the existing event bus (no new trust boundaries).
