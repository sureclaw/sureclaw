# Host — History Summarizer

## [2026-03-02 23:40] — Implement persistent chat history summarization for infinite-length conversations

**Task:** Enable infinite-length conversations by automatically summarizing older turns and persisting summaries back into the ConversationStore, replacing the raw turns they compress.

**What I did:**
- Added `conversations_002_add_is_summary` migration with `is_summary` and `summarized_up_to` columns
- Extended `ConversationStore` with `loadOlderTurns()` and `replaceTurnsWithSummary()` methods
- Created `src/host/history-summarizer.ts` — host-side module that calls the LLM (fast task type) to summarize old turns and atomically replaces them in the DB
- Added `summarize`, `summarize_threshold`, and `summarize_keep_recent` config fields to `history` section
- Integrated summarizer into `server-completions.ts` post-completion flow (fire-and-forget after turn persistence)
- Wrote 17 new tests across 2 test files; fixed 2 existing tests for new config/migration shape
- All 2037 tests pass

**Files touched:**
- `src/migrations/conversations.ts` — new migration `conversations_002_add_is_summary`
- `src/conversation-store.ts` — new `StoredTurn` fields, `loadOlderTurns()`, `replaceTurnsWithSummary()`
- `src/host/history-summarizer.ts` — new file: `maybeSummarizeHistory()`, `SummarizationConfig`
- `src/host/server-completions.ts` — import + call summarizer after turn persistence
- `src/config.ts` — new `summarize`, `summarize_threshold`, `summarize_keep_recent` fields
- `src/types.ts` — updated `Config.history` type
- `tests/conversation-store-summary.test.ts` — new: 8 tests for ConversationStore summary support
- `tests/host/history-summarizer.test.ts` — new: 9 tests for history summarizer
- `tests/config-history.test.ts` — updated default config assertion
- `tests/migrations/conversations.test.ts` — updated migration count + new column assertions

**Outcome:** Success. Feature complete with full test coverage.

**Notes:**
- The `replaceTurnsWithSummary` implementation deletes all session turns and re-inserts summary + remaining in correct order, because SQLite autoincrement IDs would otherwise put summary turns after remaining turns.
- Summarization uses `taskType: 'fast'` for cost efficiency.
- The existing `compactHistory()` in `runner.ts` is ephemeral (per-request). This new feature persists summaries so they accumulate and can be recursively summarized.
- Config is opt-in (`summarize: false` by default) to avoid surprising behavior.
