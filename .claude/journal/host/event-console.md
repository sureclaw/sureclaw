# Host: Event Console

Color-coded event console output, unified console formatting, context metrics display.

## [2026-03-01 16:11] — Add context metrics to event console logs

**Task:** Show context usage metrics in logs: context % remaining, estimated input tokens per LLM turn
**What I did:** Created pricing.ts with model context window tables, added context metrics (contextWindow, estimatedInputTokens, contextRemaining) to llm.start event, enhanced event-console with color-coded context % display (green >50%, yellow >20%, red <=20%), enriched PromptMetadata with contextWindow/historyTokens/percentRemaining, added tests
**Files touched:** src/providers/llm/pricing.ts (new), src/host/ipc-handlers/llm.ts, src/host/event-console.ts, src/agent/prompt/builder.ts, tests/providers/llm/pricing.test.ts (new), tests/host/event-console.test.ts, tests/host/ipc-handlers/llm-events.test.ts
**Outcome:** Success — 2014 tests pass, clean build
**Notes:** The effectiveModel defaulting was needed because existing tests don't pass a model to createLLMHandlers. Cost/pricing features were initially implemented but removed per user request.

## [2026-03-01 10:23] — Improve agent event console output

**Task:** Make agent lifecycle events (agent.registered, agent.state, agent.completed, etc.) show useful info instead of generic "event"
**What I did:** Added explicit cases in `formatEvent()` in event-console.ts for agent.registered, agent.state, agent.completed, agent.failed, agent.canceled, and agent.interrupt. Each now shows the agentId and relevant context (type, state transition, result, error, reason). Added 6 new tests.
**Files touched:** `src/host/event-console.ts`, `tests/host/event-console.test.ts`
**Outcome:** Success — build clean, all 24 event-console tests pass
**Notes:** The default case in formatEvent was a catch-all that just showed dim("event"). Agent events have rich data (agentId, agentType, oldState/newState, result, error, reason) that was being thrown away.

## [2026-02-28 19:40] — Beautiful event console output

**Task:** Add beautiful color-coded event console output at default verbosity, showing event hub events in a clean format
**What I did:** Created `src/host/event-console.ts` with an `attachEventConsole()` function that subscribes to the EventBus and prints compact, color-coded lines: `HH:MM:SS  event.type  status`. Wired it up in `server.ts` (TTY-only). Each event type maps to a meaningful status with appropriate colors (green=ok, yellow=flagged, red=blocked/error).
**Files touched:** src/host/event-console.ts (new), src/host/server.ts (import + wiring), tests/host/event-console.test.ts (new, 12 tests)
**Outcome:** Success — clean build, all 1822 tests pass
**Notes:** Errors DO flow through the event hub as `completion.error`. The `llm.chunk` events are intentionally skipped (too noisy). Scanner verdicts are PASS/FLAG/BLOCK.

## [2026-02-28 20:30] — Unified console output: all through event bus + matching pino formatter

**Task:** Unify all console output so pino logs and event bus events share the same visual format
**What I did:**
- Replaced pino-pretty with custom Writable stream using prettyFormat() + pino.multistream() in logger.ts
- Updated prettyFormat() to match event console style (no brackets, no INFO: prefix, level suffix only for warn/error)
- Added --json flag to CLI for JSONL output
- Set pino console level by mode: warn (default TTY), debug (--verbose), info (--json/non-TTY)
- Moved eventBus creation before loadProviders in server.ts; emit server.config/providers/ready events
- Added attachJsonEventConsole() for --json and non-TTY output
- Added server.config/providers/ready formatters to event-console.ts
- Downgraded duplicate info logs to debug in server-completions, server, llm/router, image/router
- Suppressed Slack SDK noise with LogLevel.ERROR on SocketModeReceiver
- Replaced console.error in browser/container.ts with logger.warn
- Updated smoke test to look for 'server.ready' instead of 'server_listening'
- Added LogLevel to Slack test mock
**Files touched:** src/logger.ts, src/host/server.ts, src/host/event-console.ts, src/cli/index.ts, src/host/server-completions.ts, src/providers/llm/router.ts, src/providers/image/router.ts, src/providers/channel/slack.ts, src/providers/browser/container.ts, tests/host/event-console.test.ts, tests/logger.test.ts, tests/providers/channel/slack.test.ts, tests/integration/smoke.test.ts, tests/integration/history-smoke.test.ts
**Outcome:** Success — clean build, all tests pass (1829 passed, 3 skipped)
**Notes:** Key architectural decision: default TTY mode uses event console (pretty) + pino at warn level (pretty), --verbose uses pino at debug (pretty, no event console), --json uses JSON event console + pino at info (JSON). Both smoke tests (smoke.test.ts, history-smoke.test.ts) needed updating because they were matching on 'server_listening' pino log which is now at debug level — changed to look for 'server.ready' event bus event instead.
