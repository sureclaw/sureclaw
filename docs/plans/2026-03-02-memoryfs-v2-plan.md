# Memory v2: Files-First, memU-Inspired Design

## Conversation Summary & Decisions

We evaluated how to track memory changes and landed on a series of decisions that reshape the memory architecture:

### What we rejected

| Approach | Why |
|----------|-----|
| **Git tracking** | Commit overhead per write, `.git` bloat, merge conflicts. Agents never read git history anyway. |
| **SQLite as source of truth** (v1 plan) | Reconciliation complexity, makes SQLite a hard dependency for basic read/write, two-phase write ceremony. |
| **Decayer / timer-based scoring** | Over-engineering. memU's reinforcement model (frequently accessed = important) is simpler and more accurate. |
| **Monitor / Anticipator / Git Worker** | Background processes that add complexity without proportional value. Everything should happen inline. |
| **Reconciler** | Eliminated by making files the sole source of truth. No two stores to keep in sync. |
| **Trigger files, state/monitor.md** | Artifacts of background processing we're removing. |

### What we chose

1. **Markdown files are the source of truth.** Not SQLite, not git.
2. **memU's inline processing model.** `memorize()` extracts + categorizes in one call. `retrieve()` searches + reinforces. No background jobs.
3. **memU's data model adapted for files.** Three conceptual layers: Resources (provenance) → Items (facts) → Categories (file groupings).
4. **Memory types.** fact, preference, procedure, context — assigned during extraction.
5. **Reinforcement instead of decay.** Access counts on items, updated on retrieval. No timer-based scoring.
6. **SQLite only for FTS5 + embeddings.** A derived search index, not a store. Blow it away and rebuild from files anytime.
7. **No reconciliation.** Full rebuild from files is the recovery strategy. Cheap because memory files are small.
8. **Path to (a).** Richer queryable history can be added later via append-only changelog or SQLite history table — but only when there's a real need.

---

## Design

### Data Model (memU-inspired, file-backed)

```
Categories (files)          Items (lines)              Source (inline metadata)
┌──────────────────┐       ┌─────────────────────┐    ┌──────────────────────┐
│ preferences.md   │──has──│ "Uses vim" [fact]    │──from──│ conv about editor │
│ project.md       │       │ "Prefers TS" [pref]  │    │ setup discussion     │
│ workflows.md     │       │ "Run tests" [proc]   │    └──────────────────────┘
│ context.md       │       └─────────────────────┘
└──────────────────┘
```

**Three layers, zero extra files:**

| Layer | What | Where it lives |
|-------|------|---------------|
| **Category** | A group of related items | Each `.md` file in `memory/` IS a category |
| **Item** | A single fact/preference/procedure/context | A line (or block) within a category file |
| **Source** | Provenance — where the item was extracted from | Inline metadata on the item. Full conversations live in the audit log, not in memory. |

### Memory Types

Assigned during extraction (matches memU's implicit typing):

| Type | Description | Example |
|------|-------------|---------|
| `fact` | Explicit knowledge assertion | "The API uses REST" |
| `preference` | User/project preference | "Prefers tabs over spaces" |
| `procedure` | How-to / workflow step | "Always run tests before committing" |
| `context` | Ambient project/environment knowledge | "Using PostgreSQL 15 in production" |

### File Format

Each category file is a markdown document. Items include inline metadata:

```markdown
# Preferences

- Prefers TypeScript over JavaScript [2026-02-15] [pref] [×3]
- Uses vim keybindings [2026-02-28] [pref] [×12]
- Likes short commit messages [2026-03-01] [fact] [×1]

# Project Context

- Main API is REST, considering GraphQL migration [2026-03-01] [context] [×2]
- Uses PostgreSQL 15 in production [2026-02-20] [fact] [×5]
```

Format per line:
```
- {content} [{date}] [{type}] [×{access_count}]
```

- `{date}` — ISO date of extraction (or last update)
- `{type}` — one of: `fact`, `pref`, `proc`, `context`
- `[×N]` — reinforcement count, incremented on retrieval

Why this format:
- Human-readable (open the file, scan it, done)
- Agent-readable (inject into prompt context directly)
- Parseable with a simple regex, no YAML/frontmatter dependency
- Reinforcement data lives in the file, survives index rebuilds

### Processing Model (inline, like memU)

**`memorize(conversation)` — one pipeline, no background jobs:**

```
conversation turns
       │
       ▼
  ┌─────────┐
  │ Extract  │  LLM or regex extracts items with types + confidence
  └────┬─────┘
       │
       ▼
  ┌─────────┐
  │ Dedup   │  Content hash check against existing items
  └────┬─────┘
       │
       ▼
  ┌──────────────┐
  │ Categorize   │  Assign to category (file) — LLM picks or creates category
  └────┬─────────┘
       │
       ▼
  ┌─────────┐
  │ Write   │  Append to category .md file + update search index
  └─────────┘
```

All four steps happen in one `memorize()` call. No separate categorizer job, no queue, no cron.

**`retrieve(query)` — search + reinforce:**

```
query
  │
  ▼
┌──────────┐
│ Search   │  FTS5 / embeddings index (or grep for small stores)
└────┬─────┘
     │
     ▼
┌──────────┐
│ Read     │  Load matching items from .md files
└────┬─────┘
     │
     ▼
┌───────────┐
│ Reinforce │  Increment [×N] on accessed items, write back
└────┬──────┘
     │
     ▼
  results
```

Reinforcement is the entire "importance" signal. No decay timers, no scoring formulas. Items that get retrieved a lot are important. Items that never get retrieved don't matter. Simple.

### Scoping

Follows memU's simple approach — metadata on items, filter at query time:

- **`scope`** — namespace for the memory store (e.g., `'default'`, `'project-x'`)
- **`agentId`** — optional, for multi-agent isolation
- **`userId`** — optional, for multi-user isolation (add to existing interface)

No tenant abstraction, no complex hierarchy. Where-clause filtering.

### Search Index (SQLite — derived, not primary)

SQLite stores only derived data for search:

| Table | Purpose | Rebuilt from |
|-------|---------|-------------|
| `memory_fts` (FTS5) | Keyword search across all items | All `.md` files |
| `memory_vec` (sqlite-vec) | Similarity search via embeddings | All `.md` files |

Rules:
- **No content column in a primary table.** The `.md` files are the content.
- **Rebuild is the recovery strategy.** `rebuildIndex()` reads all `.md` files, parses items, populates FTS5 + embeddings.
- **Index can be deleted and rebuilt at any time with zero data loss.**
- **Index DB named `memoryfs-index.db`** — signals "this is an index, not a store."

### Deduplication

- Content hash (SHA-256 of normalized text) checked before writing
- Check against FTS5 index (fast lookup) or scan the target file (small files, still fast)
- On hash collision with different content: append as new item (hashes are for exact dedup, not similarity)
- No separate fingerprint table

---

## Implementation Plan

### Phase 1: Core Memory (implement now — zero SQLite)

**Task 1: Types**
- `MemoryItem`: `{ id, content, type, category, timestamp, accessCount, confidence, source?, agentId?, userId?, taint? }`
- `MemoryType`: `'fact' | 'preference' | 'procedure' | 'context'`
- `MemoryConfig`: `{ memoryDir: string }`
- Extend existing `MemoryProvider` interface — add `memorize()` as required (not optional)
- Files: `src/providers/memory/memoryfs/types.ts`

**Task 2: File I/O**
- `appendItem(memoryDir, category, item)` — appends formatted line to `memory/{category}.md`
- `readCategory(memoryDir, category)` — parses a category file into `MemoryItem[]`
- `readAll(memoryDir)` — reads all category files
- `removeItem(memoryDir, category, contentHash)` — removes matching line
- `updateAccessCount(memoryDir, category, contentHash, newCount)` — updates `[×N]` inline
- `listCategories(memoryDir)` — glob `memory/*.md`
- Uses `safePath()` for all path construction
- Atomic writes (temp → rename) for safety
- Parse regex: `/^- (.+?) \[(\d{4}-\d{2}-\d{2})\] \[(fact|pref|proc|context)\] \[×(\d+)\]$/`
- Files: `src/providers/memory/memoryfs/file-io.ts`

**Task 3: Extractor**
- Two modes: regex (fast, like memU's current impl) and LLM (richer, for complex conversations)
- Regex mode extracts from conversation turns:
  - Explicit: "remember that...", "note that..." → `fact`, confidence 0.95
  - Preferences: "I prefer...", "I like..." → `preference`, confidence 0.7
  - Action items: "TODO:", "I need to..." → `procedure`, confidence 0.8
  - Context: ambient statements → `context`, confidence 0.5
- LLM mode: structured prompt asking for items with type + category + confidence
- Returns `MemoryItem[]` (not yet written to files)
- Files: `src/providers/memory/memoryfs/extractor.ts`

**Task 4: Categorizer**
- Auto-assigns items to categories during `memorize()` (not a separate background job)
- Simple heuristic: memory type → default category mapping:
  - `preference` → `preferences.md`
  - `procedure` → `workflows.md`
  - `context` → `project.md`
  - `fact` → infer from content, or `general.md`
- LLM mode (optional): ask LLM to pick from existing categories or suggest new one
- Files: `src/providers/memory/memoryfs/categorizer.ts`

**Task 5: Provider Wiring (memoryfs)**
- Implements `MemoryProvider` interface
- `memorize(conversation)` → extract → dedup → categorize → appendItem (the full inline pipeline)
- `write(entry)` → direct write (bypass extraction, for explicit memory commands)
- `read(id)` → scan files for matching item
- `query(q)` → grep across files (no index yet, fine for small stores), filter by scope/agent/user
- `delete(id)` → removeItem
- `list(scope, limit)` → readAll with filters
- Reinforcement: on `query()` and `read()`, increment `[×N]` on accessed items
- Add `memoryfs` to `PROVIDER_MAP` in `src/host/provider-map.ts`
- Files: `src/providers/memory/memoryfs/provider.ts`, `src/host/provider-map.ts`

**Task 6: Tests**
- File I/O: write items, read back, verify format/timestamps/types/access counts
- Extractor: regex patterns match expected items from sample conversations
- Categorizer: items get assigned to correct categories
- Dedup: writing same fact twice doesn't create duplicate
- Reinforcement: query increments access count in file
- Delete: item removed from file
- Provider integration: full memorize → retrieve round-trip
- Files: `tests/providers/memory/memoryfs/`

### Phase 2: Search Index (when file count makes grep slow)

**Task 7: FTS5 Index**
- Build FTS5 virtual table from all memory files
- `rebuildIndex(memoryDir)` — full rebuild, idempotent
- `searchFTS(query)` → returns `{ category, content, type, timestamp }[]`
- Index stored in `memoryfs-index.db`
- Files: `src/providers/memory/memoryfs/search-index.ts`

**Task 8: Embeddings Index**
- sqlite-vec table populated from all memory files
- Graceful degradation if sqlite-vec not available
- Same rebuild strategy as FTS5
- Files: `src/providers/memory/memoryfs/embeddings.ts`

**Task 9: Wire Search into Provider**
- `query()` routes to FTS5 when index exists, falls back to grep
- Embeddings used as reranker (search FTS5 first, rerank with embeddings)
- Incremental index update on write/delete (or batch rebuild on startup)

### Phase 3: Path to (a) — Richer History (build when needed)

These are options, not commitments. Build the first one that solves a real problem:

**Option A: Append-only Changelog**
- `memory/_changelog.md` — one line per write/update/delete
- Format: `[2026-03-01 14:30] WRITE preferences: "Likes short commits" [fact]`
- Zero infrastructure, human-readable, greppable
- Answers "what changed recently?" without any database

**Option B: LLM Reranker**
- For complex queries, use LLM to rerank search results using category context
- Reads category file headers/summaries to understand groupings
- Only makes sense after Phase 2 (needs search index to generate candidates)

**Option C: SQLite History Table (only if changelog isn't enough)**
- `memory_history` table: `(timestamp, action, category, old_content, new_content)`
- Enables "what changed this week" or "show deleted facts" queries
- Still not source of truth — just an audit trail derived from changelog

---

## What Changed vs v1 Plan

### Removed entirely (8 modules → 0)
| Module | Why |
|--------|-----|
| Reconciler | No two stores to reconcile |
| Decayer | Reinforcement replaces timer-based decay |
| Monitor | No background activity tracking |
| Anticipator | No trigger system / proactive scheduling |
| Git Worker | No git tracking of memory files |
| Two-phase writes | No consistency ceremony needed |
| Trigger files | No proactive scheduling system |
| state/monitor.md | No monitor state |

### Changed significantly
| Module | v1 | v2 |
|--------|----|----|
| Storage | SQLite primary, markdown export | Markdown primary, SQLite index only |
| Categorizer | Separate background job | Inline during `memorize()` |
| Item importance | Decay tier scoring formula | Simple access count `[×N]` |
| Processing model | Multiple background processes | Everything inline in `memorize()`/`retrieve()` |

### Kept (adapted for files)
| Module | Notes |
|--------|-------|
| LLM Extractor | Same concept, writes to files instead of DB |
| Embedding search | Phase 2, derived index |
| Content hash dedup | Same algorithm, checks files instead of DB |
| Provider contract | Same `MemoryProvider` interface |
| FTS5 search | Phase 2, derived index |

---

## Files to Create/Modify

| File | Change |
|------|--------|
| `src/providers/memory/memoryfs/types.ts` | New — item types, memory types enum, config |
| `src/providers/memory/memoryfs/file-io.ts` | New — markdown read/write/delete/update |
| `src/providers/memory/memoryfs/extractor.ts` | New — fact extraction (regex + LLM modes) |
| `src/providers/memory/memoryfs/categorizer.ts` | New — auto-categorization (inline) |
| `src/providers/memory/memoryfs/provider.ts` | New — MemoryProvider implementation |
| `src/providers/memory/memoryfs/search-index.ts` | New (Phase 2) — FTS5 index builder |
| `src/providers/memory/memoryfs/embeddings.ts` | New (Phase 2) — embeddings index |
| `src/host/provider-map.ts` | Add `memoryfs` entry |
| `tests/providers/memory/memoryfs/*.test.ts` | New — tests for each module |

## Dependencies

- **Phase 1: No new dependencies.** Filesystem ops + existing utils only.
- **Phase 2:** `sqlite-vec` (already in project), `better-sqlite3` (already in project)
- **Removed vs v1:** `gray-matter` (no YAML parsing)

## Reuse from Existing Codebase

- `src/utils/safe-path.ts` — `safePath()` for all file paths
- `src/providers/memory/types.ts` — `MemoryProvider` interface, `MemoryEntry`, `ConversationTurn`
- `src/providers/memory/memu.ts` — extraction regex patterns (reuse/adapt)
- `src/utils/sqlite.ts` — `openDatabase()` (Phase 2 only)
- `src/paths.ts` — `dataFile()` for index DB location
- `src/host/provider-map.ts` — provider registration pattern

## Verification

1. `memorize()` end-to-end: conversation → extracted items in correct category files
2. `retrieve()` round-trip: query finds items, access counts increment
3. Dedup: same fact extracted twice → only one item in file
4. Reinforcement: frequently queried items have higher `[×N]`
5. Delete: item removed from file, absent from subsequent queries
6. (Phase 2) Rebuild index from files, verify search returns correct results
7. (Phase 2) Delete `memoryfs-index.db`, rebuild, verify no data loss
8. `npm run build` — no type errors
9. `npm test` — all tests pass
