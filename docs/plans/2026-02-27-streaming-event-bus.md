# Streaming Event Bus

**Date:** 2026-02-27
**Status:** Implementing

## Problem

AX currently has no way to observe what's happening inside a completion in real time. The HTTP API waits for the entire agent process to finish before returning a response. For long-running completions (multi-tool chains, delegations, image generation), callers get no feedback until the very end. The SSE "streaming" mode in `server.ts` is fake — it just sends the complete response as a single chunk after the fact.

We need a streaming event bus that:
1. Lets internal components publish lifecycle events (completion started, LLM call started, tool use, scan results, etc.)
2. Lets HTTP clients subscribe to real-time events via SSE
3. Keeps the architecture clean — EventEmitter-style pub/sub, not polling

## Design

### Core: `EventBus` (src/host/event-bus.ts)

A typed, synchronous pub/sub bus. No async — emit is fire-and-forget so it never blocks the hot path.

```typescript
interface StreamEvent {
  type: string;           // e.g. 'completion.start', 'llm.call', 'tool.use'
  requestId: string;      // ties events to a specific completion
  timestamp: number;      // Date.now()
  data: Record<string, unknown>;
}

interface EventBus {
  emit(event: StreamEvent): void;
  subscribe(listener: (event: StreamEvent) => void): () => void;  // returns unsubscribe fn
  /** Subscribe with requestId filter — only receives events for that request. */
  subscribeRequest(requestId: string, listener: (event: StreamEvent) => void): () => void;
}
```

Design choices:
- **Synchronous emit**: Never blocks callers. Listeners that need async can queue internally.
- **No persistence**: Events are ephemeral. If nobody's listening, they evaporate. Audit logging is a separate concern (handled by the audit provider).
- **Bounded listener list**: Max 100 subscribers to prevent leaks. Oldest gets evicted with a warning.
- **Request-scoped subscriptions**: Most SSE clients only care about their own request.

### Event Types

```
completion.start    — New completion begins processing
completion.scan     — Inbound scan result (pass/block)
completion.agent    — Agent process spawned
completion.done     — Completion finished (includes response summary)
completion.error    — Completion failed

llm.start           — LLM call initiated (via IPC)
llm.chunk           — LLM streaming chunk received
llm.done            — LLM call completed (with usage stats)

tool.call           — Tool invocation started
tool.result         — Tool invocation completed

scan.inbound        — Inbound content scanned
scan.outbound       — Outbound content scanned
```

### SSE Endpoint: `GET /v1/events`

Query params:
- `request_id` — Filter events to a specific request (recommended)
- `types` — Comma-separated event type filter (e.g. `completion.start,llm.done`)

Response: Standard SSE stream with `data: {json}\n\n` framing. Sends a `:keepalive\n\n` comment every 15s.

### Integration Points

1. **server-completions.ts**: Emit `completion.*` events at each pipeline stage
2. **ipc-handlers/llm.ts**: Emit `llm.*` events as chunks arrive
3. **router.ts**: Emit `scan.*` events on inbound/outbound scan
4. **server.ts**: Wire EventBus into CompletionDeps, expose `/v1/events` endpoint

## Files

| File | Action |
|------|--------|
| `src/host/event-bus.ts` | **Create** — EventBus implementation |
| `src/host/server.ts` | **Modify** — Create EventBus, wire into deps, add SSE endpoint |
| `src/host/server-completions.ts` | **Modify** — Emit completion lifecycle events |
| `src/host/ipc-handlers/llm.ts` | **Modify** — Emit LLM call events |
| `tests/host/event-bus.test.ts` | **Create** — Unit tests for EventBus |
| `tests/host/event-bus-sse.test.ts` | **Create** — SSE endpoint integration tests |

## Security

- No credentials or full message content in events. Only metadata (lengths, types, timing).
- Canary tokens are never included in events.
- The SSE endpoint is on the same Unix socket / TCP port as the rest of the API — same auth boundary.
