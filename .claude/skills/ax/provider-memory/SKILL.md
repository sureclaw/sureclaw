---
name: provider-memory
description: Use when modifying memory/knowledge storage — the Cortex provider (embedding-based, SQLite/PostgreSQL) with SummaryStore, salience scoring, and LLM extraction in src/providers/memory/
---

## Overview

Memory providers store and retrieve scoped knowledge entries with semantic search, salience scoring, and conversation-level memorization via the `memorize()` hook. The only implementation is **Cortex** — an embedding-based system supporting both SQLite (local dev) and PostgreSQL (k8s).

## Interface

Defined in `src/providers/memory/types.ts`:

| Type | Purpose |
|------|---------|
| `MemoryEntry` | Core record: `id`, `scope`, `content`, `tags`, `taint`, `createdAt`, `agentId?`, `userId?` |
| `MemoryQuery` | Search params: `scope`, `query`, `limit`, `tags`, `agentId?`, `userId?`, `embedding?` (pre-computed vector) |
| `ConversationTurn` | `role` (user/assistant), `content`, optional `sender` |
| `ProactiveHint` | Emitted hint: `source`, `kind`, `reason`, `suggestedPrompt`, `confidence`, `scope` |
| `MemoryProvider` | Contract: `write`, `query`, `read`, `delete`, `list`, optional `memorize`, `onProactiveHint` |

## Cortex Provider

Advanced embedding-based memory system in `src/providers/memory/cortex/`:

| File | Responsibility |
|------|----------------|
| `provider.ts` | Main provider wiring, `create(config, name?, opts?)` factory. Accepts `CreateOptions { llm?, database? }`. |
| `items-store.ts` | SQLite/PostgreSQL-backed item storage with CRUD operations, reinforcement counting |
| `embedding-store.ts` | Vector DB using sqlite-vec (local) or pgvector (k8s) for semantic search; graceful degradation when unavailable |
| `summary-store.ts` | Category summary management — `SummaryStore` interface with `FileSummaryStore` and `DbSummaryStore` implementations |
| `extractor.ts` | LLM-powered content extraction from conversations |
| `llm-helpers.ts` | LLM prompt execution utilities |
| `salience.ts` | Salience scoring using memU formula (reinforcement count, recency, relevance) |
| `content-hash.ts` | Content hashing for deduplication |
| `prompts.ts` | LLM prompt templates for extraction and summarization |
| `migrations.ts` | Database migrations for cortex tables (items, embeddings, summaries) |
| `types.ts` | Cortex-specific types (DEFAULT_CATEGORIES, etc.) |
| `index.ts` | Re-exports `create` from `provider.ts` |

### Key Features

- **Semantic search:** Queries use vector embeddings (via `src/utils/embedding-client.ts`) for similarity matching. Falls back to keyword search when embeddings unavailable.
- **LLM extraction:** Conversations analyzed by LLM to extract structured knowledge items via `memorize()`.
- **Deduplication:** Content hashing (SEMANTIC_DEDUP_THRESHOLD = 0.8) prevents storing duplicate entries.
- **Salience scoring:** Items ranked by reinforcement count, recency, and query relevance.
- **Reinforcement counting:** Read and query operations increment reinforcement counts on accessed items, improving salience over time.
- **Graceful degradation:** Falls back when sqlite-vec/pgvector or embedding API is unavailable.
- **Embedding backfill:** Background process fills embeddings for items that don't have them yet. PostgreSQL uses advisory locks for backfill coordination across processes.

### SummaryStore

Abstract interface for reading/writing category summary content:

| Method | Description |
|--------|-------------|
| `read(category, userId?)` | Read summary content for a category |
| `write(category, content, userId?)` | Write/update summary content |
| `list(userId?)` | List all summary categories |
| `readAll(userId?)` | Read all summaries as a Map |
| `initDefaults()` | Create default category scaffolding |

Two implementations:
- **`FileSummaryStore`** — File-based, stores `.md` files per category in the memory directory. Used for local SQLite dev.
- **`DbSummaryStore`** — Database-backed via Kysely. Uses `cortex_summaries` table with `(category, user_id)` composite unique. Used for PostgreSQL/k8s deployments.

Summaries are wired into `query()` as trailing results with synthetic IDs prefixed by `summary:`.

### Database Support

Cortex provider uses the shared `DatabaseProvider` (injected via `CreateOptions.database`):
- **SQLite**: Uses sqlite-vec for vector search, `openDatabase()` for items DB.
- **PostgreSQL**: Uses pgvector extension, shared Kysely instance for all tables.
- Migrations are per-subsystem: `runMigrations(db, memoryMigrations(), 'cortex_migration')`.

Provider map entry in `src/host/provider-map.ts`:
```
memory: {
  cortex: '../providers/memory/cortex/index.js',
}
```

## Common Tasks

**Modifying cortex memory logic:**
1. Core CRUD: `items-store.ts` (write/query/read/delete/list)
2. Embedding search: `embedding-store.ts` (upsert/search/remove)
3. LLM extraction: `extractor.ts` + `prompts.ts`
4. Summary management: `summary-store.ts`
5. Scoring: `salience.ts`

**Adding a new memory provider:**
1. Create `src/providers/memory/<name>.ts` exporting `create(config: Config): Promise<MemoryProvider>`
2. Implement all 5 required methods: `write`, `query`, `read`, `delete`, `list`
3. Optionally implement `memorize` and `onProactiveHint`
4. Register in `src/host/provider-map.ts` static allowlist (SC-SEC-002)
5. Add tests at `tests/providers/memory/<name>.test.ts`
6. Use `safePath()` for any file path construction from input

## Gotchas

- **Only cortex remains:** The file, sqlite, and memu providers were removed. All memory goes through cortex.
- **Reinforcement on read/query:** Accessing items increments their reinforcement count, which affects salience scoring. Tests must account for this.
- **Salience formula produces 0 at zero reinforcement:** Test ratios need nonzero counts.
- **Summary query results:** `query()` appends summary entries with IDs prefixed by `SUMMARY_ID_PREFIX` ('summary:'). Don't treat these as regular items.
- **DbSummaryStore shared user sentinel:** Uses `'__shared__'` (not NULL) for non-user-scoped summaries so the composite unique index works with ON CONFLICT.
- **Embedding backfill advisory lock:** PostgreSQL uses advisory lock key `0x41585F4246` for cross-process coordination.
- **Per-subsystem migration tables:** Cortex uses `'cortex_migration'` as its migration table name to avoid collisions with storage migrations.
- **pi-agent-core only supports text:** Image blocks must bypass it for LLM extraction.
- **DatabaseProvider injection:** Cortex accepts optional `database` in CreateOptions. When present, uses shared Kysely instance; when absent, falls back to local SQLite.
- **initDefaults must run after migrations:** `DbSummaryStore.initDefaults()` inserts default categories — call only after `runMigrations()` succeeds.

## Key Files

- `src/providers/memory/types.ts` — MemoryProvider interface, MemoryEntry, MemoryQuery
- `src/providers/memory/cortex/` — All cortex implementation files
- `src/providers/memory/cortex/provider.ts` — Main entry point and factory
- `src/providers/memory/cortex/summary-store.ts` — SummaryStore interface + FileSummaryStore + DbSummaryStore
- `src/providers/memory/cortex/items-store.ts` — Item CRUD with reinforcement
- `src/providers/memory/cortex/embedding-store.ts` — Vector storage and search
- `src/providers/memory/cortex/migrations.ts` — Database schema migrations
- `src/utils/embedding-client.ts` — Embedding generation client
- `tests/providers/memory/cortex/` — Cortex provider tests
