---
name: ax-provider-audit
description: Use when modifying audit logging providers — JSONL file logs, database-backed logs, or audit entry structure in src/providers/audit/
---

## Overview

The audit provider records every IPC action, LLM call, and security event. Two implementations: append-only JSONL for simplicity, database-backed (SQLite/PostgreSQL via shared DatabaseProvider) for indexed queries. The IPC dispatch wrapper calls `audit.log()` automatically after every handler.

## Interface

### AuditEntry

| Field        | Type                              | Required | Notes                                |
|--------------|-----------------------------------|----------|--------------------------------------|
| `timestamp`  | Date                              | yes      | When the action occurred             |
| `sessionId`  | string                            | yes      | Originating session                  |
| `action`     | string                            | yes      | IPC action name                      |
| `args`       | `Record<string, unknown>`         | yes      | Action parameters                    |
| `result`     | `'success' \| 'blocked' \| 'error'` | yes   | Outcome                              |
| `taint`      | TaintTag                          | no       | Taint tag if content was tainted     |
| `durationMs` | number                            | yes      | Execution time in milliseconds       |
| `tokenUsage` | `{ input, output }`              | no       | LLM token counts                     |

### AuditFilter

| Field       | Type   | Notes                              |
|-------------|--------|------------------------------------|
| `action`    | string | Filter by action name              |
| `sessionId` | string | Filter by session                  |
| `since`     | Date   | Inclusive lower bound on timestamp  |
| `until`     | Date   | Inclusive upper bound on timestamp  |
| `limit`     | number | Return last N matching entries     |

### AuditProvider

| Method          | Description                                      |
|-----------------|--------------------------------------------------|
| `log(entry)`    | Append a partial `AuditEntry` (timestamp auto-filled) |
| `query(filter)` | Return entries matching `AuditFilter`            |

## Implementations

| Provider   | File          | Storage           | Queryable | Notes                                  |
|------------|---------------|-------------------|-----------|----------------------------------------|
| `file`     | `file.ts`     | JSONL append      | yes (scan)| Reads entire file for queries          |
| `database` | `database.ts` | Shared DatabaseProvider (SQLite/PostgreSQL) | yes (SQL) | Uses injected `DatabaseProvider`; indexed on session_id and action |

## File Provider Details

- Writes to `dataFile('audit', 'audit.jsonl')` via `appendFileSync`.
- Auto-creates parent directory on `ENOENT`.
- `query()` reads and parses all lines, then filters in-memory. Not efficient for large logs.

## Database Provider Details

- Receives a shared `DatabaseProvider` via `create(config, name, { database })` — no standalone DB connection.
- Uses Kysely query builder against `audit_log` table with `id`, `timestamp`, `session_id`, `action`, `args` (JSON), `result`, `taint` (JSON), `duration_ms`, `token_input`, `token_output`.
- Indexes: `idx_audit_session` (session_id, timestamp), `idx_audit_action` (action, timestamp).
- Migrations in `migrations.ts` — applied by the database provider during startup.
- `limit` returns the last N entries (most recent), re-sorted ascending.

## Common Tasks

- **Add a new audit field**: add to `AuditEntry` type, add column via migration in `migrations.ts`, add to JSONL serialization, update `rowToEntry()` mapping.
- **Add a new filter dimension**: add to `AuditFilter`, add SQL `WHERE` clause in `database.ts`, add in-memory filter in `file.ts`.
- **Query audit in tests**: use `query({ action: 'your_action', limit: 10 })`.

## Gotchas

- **Audit mock must collect all calls**: the IPC dispatch wrapper calls `audit.log()` with empty args after the handler runs. When testing handler-specific audit entries, mock `audit.log` to push to an array and use `.find()` to locate the correct entry.
- **log() accepts Partial<AuditEntry>**: timestamp is auto-filled if missing. Callers can omit fields.
- **File provider scans everything**: `query()` on the file provider parses every line on every call. For large deployments, prefer SQLite.
- **SQLite limit ordering**: the SQLite provider's `limit` uses a nested subquery to get the last N rows, then re-sorts ascending. Adding new filter logic must account for this wrapping.
