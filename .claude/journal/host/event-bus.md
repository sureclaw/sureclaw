# Host: Event Bus

Streaming event bus for real-time completion observability, SSE endpoints, and LLM event streaming.

## [2026-02-28 00:42] — Streaming Event Bus

**Task:** Implement a streaming event bus for real-time completion observability
**What I did:**
- Created `src/host/event-bus.ts` — typed pub/sub bus with synchronous emit, global and per-request subscriptions, bounded listener lists (100 global, 50 per-request), error isolation per listener, automatic eviction of oldest on overflow.
- Integrated into `src/host/server-completions.ts` — emits `completion.start`, `completion.agent`, `completion.done`, `completion.error`, `scan.inbound`, `scan.outbound` events at each pipeline stage.
- Added SSE endpoint `GET /v1/events` in `src/host/server.ts` — supports `request_id` and `types` query param filters, 15s keepalive comments, auto-cleanup on disconnect.
- Wired `src/host/ipc-handlers/llm.ts` to emit `llm.start`, `llm.chunk`, `tool.call`, `llm.done` events per LLM call chunk.
- Threaded EventBus through `IPCHandlerOptions` → `createIPCHandler` → `createLLMHandlers`.
- Wrote 18 unit tests (`tests/host/event-bus.test.ts`) and 8 SSE integration tests (`tests/host/event-bus-sse.test.ts`).
- Created design plan `docs/plans/2026-02-27-streaming-event-bus.md`.
**Files touched:** `src/host/event-bus.ts` (new), `src/host/server.ts`, `src/host/server-completions.ts`, `src/host/ipc-server.ts`, `src/host/ipc-handlers/llm.ts`, `tests/host/event-bus.test.ts` (new), `tests/host/event-bus-sse.test.ts` (new), `docs/plans/2026-02-27-streaming-event-bus.md` (new)
**Outcome:** Success — all 26 new tests pass, all existing tests pass (65 server + 29 IPC handler + 20 router/completions)
**Notes:** EventBus is optional (`eventBus?`) everywhere — zero impact when not wired in. Synchronous emit means it can never block the completion pipeline. SSE endpoint reuses the same auth boundary as the rest of the API (Unix socket / TCP port).

## [2026-02-28 00:50] — Add thinking/reasoning event to streaming event bus

**Task:** Add llm.thinking event type for extended thinking / reasoning model support
**What I did:**
- Added `'thinking'` to `ChatChunk.type` union in `src/providers/llm/types.ts`
- Anthropic provider (`anthropic.ts`): yield `{ type: 'thinking' }` chunks from `thinking_delta` content block deltas
- OpenAI provider (`openai.ts`): yield `{ type: 'thinking' }` chunks from `reasoning_content`/`reasoning` delta fields (supports o-series, DeepSeek R1, etc.)
- LLM IPC handler (`ipc-handlers/llm.ts`): emit `llm.thinking` event with `contentLength` for thinking chunks
- Added 3 thinking-specific unit tests in `event-bus.test.ts`, 6 LLM handler event tests in `ipc-handlers/llm-events.test.ts`, 2 ChatChunk type tests in `providers/llm/thinking-chunk.test.ts`
**Files touched:** `src/providers/llm/types.ts`, `src/providers/llm/anthropic.ts`, `src/providers/llm/openai.ts`, `src/host/ipc-handlers/llm.ts`, `tests/host/event-bus.test.ts`, `tests/host/ipc-handlers/llm-events.test.ts` (new), `tests/providers/llm/thinking-chunk.test.ts` (new)
**Outcome:** Success — 29 new tests pass, all 431 existing tests pass (40 test files)
**Notes:** The thinking event only carries `contentLength` — we intentionally do NOT include thinking content in events (no credentials, no full content in events per the security design). Anthropic thinking deltas arrive as `{ thinking: "..." }` in the delta, while OpenAI-compatible providers use `reasoning_content` or `reasoning` as non-standard delta fields.

## [2026-02-27 22:26] — Stream llm.* event bus events as OpenAI SSE in chat completions

**Task:** When `stream=true` on `/v1/chat/completions`, convert `llm.*` event bus events into real-time OpenAI-compatible SSE chunks instead of faking streaming with the full response.
**What I did:**
- Passed HTTP `requestId` as the agent's `sessionId` in the stdin payload (instead of `queued.session_id` which canonicalized to the shared `http:dm:client`). This makes `ctx.sessionId` in IPC handlers equal the HTTP requestId, so event bus events naturally correlate.
- Updated image draining to use `requestId` instead of `queued.session_id` (images are stored under `ctx.sessionId` and must match).
- Added text content to `llm.chunk` events (previously only had `contentLength`)
- Restructured `handleCompletions` streaming path: subscribe to event bus before `processCompletion`, forward `llm.chunk` events as OpenAI SSE deltas in real-time, with fallback to full-response-as-single-chunk when no events are emitted
- Added debug logging to `event-bus.ts` emit()
**Files touched:** `src/host/server-completions.ts`, `src/host/ipc-handlers/llm.ts`, `src/host/server.ts`, `src/host/event-bus.ts`, `tests/host/ipc-handlers/llm-events.test.ts`, `tests/host/streaming-completions.test.ts` (new)
**Outcome:** Success — all 1808 tests pass across 176 test files
**Notes:** Initially tried threading a separate `_requestId` through the full pipeline (stdin → IPC client → IPC server → IPCContext), but simplified to just passing the HTTP requestId as the agent's sessionId. The key insight: `ctx.sessionId` is already threaded end-to-end, so reusing it avoids new plumbing. The old `queued.session_id` (`http:dm:client`) was shared across all HTTP requests, making correlation impossible.
