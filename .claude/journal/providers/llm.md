# Providers: LLM

LLM provider implementations, pricing/context window tables, OpenTelemetry tracing.

## [2026-02-22 20:50] — OpenTelemetry LLM tracing

**Task:** Add OpenTelemetry instrumentation for LLM calls with Langfuse-compatible OTLP export
**What I did:**
- Installed `@opentelemetry/api`, `@opentelemetry/sdk-node`, `@opentelemetry/exporter-trace-otlp-http`
- Created `src/utils/tracing.ts` — lazy-loaded OTel SDK init, `getTracer()`, `isTracingEnabled()`
- Created `src/providers/llm/traced.ts` — `TracedLLMProvider` wrapper creating `gen_ai.chat` spans with message events, tool call events, usage attributes, error handling
- Created `tests/providers/llm/traced.test.ts` — 11 tests covering passthrough, span creation, message events, tool calls, usage, errors, no-op tracer, models delegation, name exposure, content block serialization
- Modified `src/host/registry.ts` to conditionally wrap LLM provider with `TracedLLMProvider` when `OTEL_EXPORTER_OTLP_ENDPOINT` is set
- Modified `src/host/server.ts` to call `initTracing()` before `loadProviders()`
**Files touched:** src/utils/tracing.ts (new), src/providers/llm/traced.ts (new), tests/providers/llm/traced.test.ts (new), src/host/registry.ts (modified), src/host/server.ts (modified), package.json (modified)
**Outcome:** Success — 11/11 traced tests pass, clean tsc build, all directly affected test suites (server, router, traced) pass
**Notes:** Zero-overhead design: when `OTEL_EXPORTER_OTLP_ENDPOINT` is unset, no heavy OTel SDK packages are imported (lazy `await import()`), and the no-op tracer from `@opentelemetry/api` produces stub spans that discard all data. The wrapper uses `gen_ai.*` semantic conventions for compatibility with Langfuse and other OTel backends.

## [2026-02-27 12:00] — Analyze pi-package-strategy vs latest MRs

**Task:** Explain what changed in the latest MR relative to the pi-package-strategy.md plan
**What I did:** Traced the full git history of pi-session.ts, examined all 39 merged PRs, read the plan document, and compared current runner state against the plan's Stage 0-1 and Stage 2+ milestones.
**Files touched:** None (research-only task)
**Outcome:** Success — identified that pi-session.ts adopted the pi-coding-agent API from the initial commit (Stage 2+ shape) but uses Stage 0-1 feature levels (inMemory sessions, no compaction, dummy auth). Latest MR (#39) adds plugin framework (extension system concept from the plan). Prior MRs #15 (decompose) and #37 (tool filtering) were the most structurally relevant to the plan.
**Notes:** The plan was never executed as discrete Stage 0 → Stage 2 PRs. Instead, the codebase was born at Stage 2+ API level with the initial commit, and features are being incrementally wired up through unrelated PRs.
