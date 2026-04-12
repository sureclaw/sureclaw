# Testing SQLite

### :memory: SQLite databases don't work with separate connections
**Date:** 2026-02-22
**Context:** Converting stores to use Kysely migrations. Kysely creates its own better-sqlite3 connection, runs migrations, then we destroy it and open a new connection via openDatabase(). For file paths this works since both connections see the same file. For :memory:, each connection is an independent in-memory database.
**Lesson:** When using createKyselyDb() + openDatabase() pattern (two separate connections), :memory: paths won't work because migrations run on one connection and queries on another. Tests must use temp file paths instead: `join(mkdtempSync(...), 'test.db')`. This is already the pattern in conversation-store and job-store tests.
**Tags:** sqlite, memory, testing, kysely, migrations, better-sqlite3

### Separate Kysely + openDatabase connections can't share :memory: databases
**Date:** 2026-02-22
**Context:** Migrating stores to use Kysely for migrations while keeping openDatabase() for queries
**Lesson:** When using `createKyselyDb` (which opens its own better-sqlite3 connection) alongside `openDatabase()`, `:memory:` databases won't work because each connection gets an independent in-memory database. Tests must use temp file paths instead. This applies whenever you have two separate SQLite connections to the same logical database.
**Tags:** sqlite, kysely, testing, memory-database, migrations

### ALTER TABLE ADD COLUMN has no IF NOT EXISTS in SQLite
**Date:** 2026-02-22
**Context:** Writing Kysely migration for memory store's agent_id column
**Lesson:** `ALTER TABLE ... ADD COLUMN` doesn't support `IF NOT EXISTS` in SQLite (or in Kysely's schema builder). For backwards-compatible migrations that add columns, wrap in try-catch to handle the "duplicate column" error. This is the correct pattern — Kysely's migration tracking prevents double-runs on fresh databases, and the try-catch handles pre-migration databases.
**Tags:** sqlite, kysely, migrations, alter-table, backwards-compatibility

### Always check runMigrations result.error in store factories
**Date:** 2026-02-22
**Context:** Code review caught that create() factories discarded the migration result
**Lesson:** `runMigrations()` returns `{ error }` instead of throwing. Always check `result.error` and throw it explicitly. Also wrap the Kysely lifecycle in try/finally to ensure `kyselyDb.destroy()` runs even on failure — otherwise you leak the connection.
**Tags:** kysely, migrations, error-handling, resource-cleanup

### SQLite autoincrement IDs don't respect logical ordering after delete+insert
**Date:** 2026-03-02
**Context:** Implementing replaceTurnsWithSummary — deleted old turns, inserted summary turns, but summary turns got higher IDs than remaining turns, breaking chronological ordering.
**Lesson:** When replacing a range of rows with new rows in SQLite and ordering matters (ORDER BY id ASC), you can't just delete the old rows and insert new ones — the new rows get higher autoincrement IDs. Instead, snapshot the remaining rows, delete ALL rows for the scope, then re-insert in the correct order: new rows first (get lower IDs), then remaining rows (get higher IDs).
**Tags:** sqlite, autoincrement, ordering, conversation-store, summarization

### Creating a MessageQueueStore in tests requires full storage provider setup
**Date:** 2026-03-05
**Context:** Migrating 5 test files from deleted `MessageQueue` class to `MessageQueueStore` interface
**Lesson:** To create a `MessageQueueStore` in tests, you must: (1) `createKyselyDb({ type: 'sqlite', path })`, (2) `runMigrations(db, storageMigrations('sqlite'))`, (3) `createStorage(config, undefined, { database: { db, type: 'sqlite', vectorsAvailable: false, close } })`, (4) use `storage.messages`. The `createMessageQueue()` internal function is not exported, so you must go through the full `createStorage()` path. For cleanup, call `kyselyDb.destroy()` not `db.close()` since `MessageQueueStore` has no close method. When `dispose()` must stay synchronous (e.g., called by many callers without `await`), use `void kyselyDb.destroy()`.
**Tags:** sqlite, kysely, testing, message-queue, storage-provider, migration

### SQLite DEFAULT expressions need outer parentheses for function calls
**Date:** 2026-04-06
**Context:** Making DatabaseAgentRegistry migrations work with SQLite. Used `sql\`datetime('now')\`` as a column default which caused "syntax error near ("
**Lesson:** In Kysely schema builder, SQLite DEFAULT expressions that call functions must be wrapped in outer parentheses: `sql\`(datetime('now'))\`` not `sql\`datetime('now')\``. This is a SQLite-specific requirement. PostgreSQL's `sql\`NOW()\`` works without outer parens. Follow the pattern in `src/providers/storage/migrations.ts`.
**Tags:** sqlite, kysely, migrations, datetime, default-value

### Structured content serialization — use JSON detection on load
**Date:** 2026-02-25
**Context:** Storing ContentBlock[] in SQLite TEXT columns alongside plain string content
**Lesson:** For backward-compatible structured content in SQLite TEXT columns: serialize arrays with JSON.stringify, leave strings as-is. On load, detect JSON arrays by checking if the string starts with `[` and parse accordingly. This avoids schema migrations and handles both old (plain text) and new (structured) data transparently.
**Tags:** sqlite, content-blocks, serialization, conversation-store, backward-compatibility
