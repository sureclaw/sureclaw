# Host — Memory Recall

## [2026-03-02 19:40] — Add long-term memory recall injection into conversation history

**Task:** Automatically inject relevant long-term memory entries as the oldest messages in conversation history, before summarized turns and recent turns, so the agent has cross-session context without needing to proactively call the memory tool.

**What I did:**
- Created `src/host/memory-recall.ts` with `recallMemoryForMessage()` — queries the memory provider using FTS5 keyword search derived from the user's message
- Extracts meaningful query terms (filters stop words, deduplicates, caps at 10 terms joined with OR)
- Formats matching MemoryEntry results as a user/assistant turn pair prepended to history
- Added `memory_recall`, `memory_recall_limit`, `memory_recall_scope` config fields to history section
- Integrated into `server-completions.ts` — recall happens after history assembly, results are unshifted to the front
- Wrote 10 tests covering: disabled state, no matches, successful recall, error handling, limit enforcement, query term extraction, scope passthrough, date formatting, logging
- Updated config test for new default fields
- All 2048 tests pass

**Files touched:**
- `src/host/memory-recall.ts` — new file: `recallMemoryForMessage()`, `MemoryRecallConfig`, `extractQueryTerms()`, `formatMemoryTurns()`
- `src/host/server-completions.ts` — import + call memory recall before agent spawn
- `src/config.ts` — new `memory_recall`, `memory_recall_limit`, `memory_recall_scope` fields
- `src/types.ts` — updated `Config.history` type
- `tests/host/memory-recall.test.ts` — new: 10 tests
- `tests/config-history.test.ts` — updated default config assertion

**Outcome:** Success. History assembly order is now: [memory recall] → [summaries] → [recent turns] → [current message].

**Notes:**
- Uses existing FTS5-based `memory.query()` — no new embedding infrastructure needed
- The query term extraction filters stop words and joins with OR for broad matching
- When MemoryFS v2 lands with vector embeddings, the `recallMemoryForMessage` function can be swapped to use a `recall()` method with semantic search instead of keyword FTS5
- Config is opt-in (`memory_recall: false` by default)
