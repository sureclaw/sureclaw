# Database-Backed Credential Provider Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a `database` credential provider that stores user/agent-provided skill credentials in PostgreSQL/SQLite, replacing the ephemeral `credentials.yaml` file that gets lost on k8s pod restarts.

**Architecture:** New `src/providers/credentials/database.ts` implementation of the existing `CredentialProvider` interface. Uses the shared `DatabaseProvider` (Kysely) with its own migration table. Falls back to `process.env` for `get()` so shell-exported and K8s Secret-injected vars still work. The registry loading order changes: when `credentials === 'database'`, the database provider is loaded first, then credentials.

**Tech Stack:** Kysely (shared DB), vitest (tests), existing `runMigrations` utility.

---

### Task 1: Create the migration file

**Files:**
- Create: `src/providers/credentials/migrations.ts`

**Step 1: Write the migration file**

Create `src/providers/credentials/migrations.ts` following the audit migrations pattern:

```typescript
// src/providers/credentials/migrations.ts — Dialect-aware credential store migrations
import { sql, type Kysely } from 'kysely';
import type { MigrationSet } from '../../utils/migrator.js';

export function credentialDbMigrations(dbType: 'sqlite' | 'postgresql'): MigrationSet {
  const isSqlite = dbType === 'sqlite';

  return {
    cred_001_initial: {
      async up(db: Kysely<any>) {
        if (isSqlite) {
          await db.schema
            .createTable('credential_store')
            .ifNotExists()
            .addColumn('id', 'integer', col => col.primaryKey().autoIncrement())
            .addColumn('scope', 'text', col => col.notNull().defaultTo('global'))
            .addColumn('env_name', 'text', col => col.notNull())
            .addColumn('value', 'text', col => col.notNull())
            .addColumn('created_at', 'text', col =>
              col.notNull().defaultTo(sql`(datetime('now'))`))
            .addColumn('updated_at', 'text', col =>
              col.notNull().defaultTo(sql`(datetime('now'))`))
            .execute();
        } else {
          await sql`
            CREATE TABLE IF NOT EXISTS credential_store (
              id SERIAL PRIMARY KEY,
              scope TEXT NOT NULL DEFAULT 'global',
              env_name TEXT NOT NULL,
              value TEXT NOT NULL,
              created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
              updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
          `.execute(db);
        }

        await db.schema
          .createIndex('idx_credential_scope_env')
          .ifNotExists()
          .on('credential_store')
          .columns(['scope', 'env_name'])
          .unique()
          .execute();
      },
      async down(db: Kysely<any>) {
        await db.schema.dropTable('credential_store').ifExists().execute();
      },
    },
  };
}
```

**Step 2: Verify the file compiles**

Run: `npx tsc --noEmit src/providers/credentials/migrations.ts`
Expected: No errors

**Step 3: Commit**

```bash
git add src/providers/credentials/migrations.ts
git commit -m "feat(credentials): add database migration for credential_store table"
```

---

### Task 2: Write failing tests for the database credential provider

**Files:**
- Create: `tests/providers/credentials/database.test.ts`

**Step 1: Write the test file**

Create `tests/providers/credentials/database.test.ts`:

```typescript
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { create as createSqliteDb } from '../../../src/providers/database/sqlite.js';
import { create } from '../../../src/providers/credentials/database.js';
import type { CredentialProvider } from '../../../src/providers/credentials/types.js';
import type { DatabaseProvider } from '../../../src/providers/database/types.js';
import type { Config } from '../../../src/types.js';

const config = {} as Config;

describe('credentials/database', () => {
  let provider: CredentialProvider;
  let database: DatabaseProvider;
  let testHome: string;

  beforeEach(async () => {
    testHome = join(tmpdir(), `ax-creds-db-test-${randomUUID()}`);
    mkdirSync(testHome, { recursive: true });
    process.env.AX_HOME = testHome;
    database = await createSqliteDb(config);
    provider = await create(config, 'database', { database });
  });

  afterEach(async () => {
    try { await database.close(); } catch {}
    try { rmSync(testHome, { recursive: true, force: true }); } catch {}
    delete process.env.AX_HOME;
    delete process.env.DB_CREDS_TEST_KEY;
  });

  test('throws when no database provider given', async () => {
    await expect(create(config, 'database'))
      .rejects.toThrow('credentials/database requires a database provider');
  });

  test('set and get a credential', async () => {
    await provider.set('MY_API_KEY', 'sk-test-123');
    const value = await provider.get('MY_API_KEY');
    expect(value).toBe('sk-test-123');
  });

  test('returns null for non-existent key', async () => {
    expect(await provider.get('NONEXISTENT_KEY_XYZ')).toBeNull();
  });

  test('falls back to process.env on get', async () => {
    process.env.DB_CREDS_TEST_KEY = 'from-env';
    const value = await provider.get('DB_CREDS_TEST_KEY');
    expect(value).toBe('from-env');
  });

  test('falls back to process.env with uppercase lookup', async () => {
    process.env.DB_CREDS_TEST_KEY = 'from-env-upper';
    const value = await provider.get('db_creds_test_key');
    expect(value).toBe('from-env-upper');
  });

  test('credential store value takes precedence over process.env', async () => {
    process.env.DB_CREDS_TEST_KEY = 'from-env';
    await provider.set('DB_CREDS_TEST_KEY', 'from-store');
    const value = await provider.get('DB_CREDS_TEST_KEY');
    expect(value).toBe('from-store');
  });

  test('set overwrites existing value (upsert)', async () => {
    await provider.set('KEY', 'v1');
    await provider.set('KEY', 'v2');
    expect(await provider.get('KEY')).toBe('v2');
  });

  test('delete removes a credential', async () => {
    await provider.set('TO_DELETE', 'value');
    await provider.delete('TO_DELETE');
    expect(await provider.get('TO_DELETE')).toBeNull();
  });

  test('delete of non-existent key does not throw', async () => {
    await expect(provider.delete('NOPE')).resolves.toBeUndefined();
  });

  test('list returns all stored keys', async () => {
    await provider.set('KEY_A', 'a');
    await provider.set('KEY_B', 'b');
    const keys = await provider.list();
    expect(keys).toContain('KEY_A');
    expect(keys).toContain('KEY_B');
  });

  test('list returns empty array when no credentials stored', async () => {
    expect(await provider.list()).toEqual([]);
  });

  test('set also updates process.env', async () => {
    await provider.set('DB_CREDS_TEST_KEY', 'via-set');
    expect(process.env.DB_CREDS_TEST_KEY).toBe('via-set');
  });

  test('persists across provider instances', async () => {
    await provider.set('CROSS_INSTANCE', 'value-123');
    const provider2 = await create(config, 'database', { database });
    expect(await provider2.get('CROSS_INSTANCE')).toBe('value-123');
  });
});
```

**Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/providers/credentials/database.test.ts`
Expected: FAIL — module `../../../src/providers/credentials/database.js` does not exist

**Step 3: Commit**

```bash
git add tests/providers/credentials/database.test.ts
git commit -m "test(credentials): add failing tests for database credential provider"
```

---

### Task 3: Implement the database credential provider

**Files:**
- Create: `src/providers/credentials/database.ts`

**Step 1: Write the implementation**

Create `src/providers/credentials/database.ts`:

```typescript
// src/providers/credentials/database.ts — Database-backed CredentialProvider
//
// Uses the shared DatabaseProvider (SQLite or PostgreSQL).
// Runs its own migrations against the shared Kysely instance.
// Falls back to process.env for get() — shell-exported and K8s Secret-injected
// vars still work without being stored in the DB.

import { runMigrations } from '../../utils/migrator.js';
import { credentialDbMigrations } from './migrations.js';
import type { CredentialProvider } from './types.js';
import type { Config } from '../../types.js';
import type { DatabaseProvider } from '../database/types.js';
import type { Kysely } from 'kysely';

const DEFAULT_SCOPE = 'global';

export interface CreateOptions {
  database?: DatabaseProvider;
}

export async function create(
  _config: Config,
  _name?: string,
  opts?: CreateOptions,
): Promise<CredentialProvider> {
  const database = opts?.database;
  if (!database) {
    throw new Error(
      'credentials/database requires a database provider. Set providers.database in ax.yaml.',
    );
  }

  const result = await runMigrations(
    database.db,
    credentialDbMigrations(database.type),
    'credential_migration',
  );
  if (result.error) throw result.error;

  const db: Kysely<any> = database.db;
  const scope = DEFAULT_SCOPE;

  return {
    async get(service: string): Promise<string | null> {
      const row = await db.selectFrom('credential_store')
        .select('value')
        .where('scope', '=', scope)
        .where('env_name', '=', service)
        .executeTakeFirst();

      if (row) return row.value as string;

      // Fall back to process.env (case-insensitive: try exact, then UPPER)
      return process.env[service] ?? process.env[service.toUpperCase()] ?? null;
    },

    async set(service: string, value: string): Promise<void> {
      const existing = await db.selectFrom('credential_store')
        .select('id')
        .where('scope', '=', scope)
        .where('env_name', '=', service)
        .executeTakeFirst();

      if (existing) {
        await db.updateTable('credential_store')
          .set({
            value,
            updated_at: new Date().toISOString(),
          })
          .where('scope', '=', scope)
          .where('env_name', '=', service)
          .execute();
      } else {
        await db.insertInto('credential_store')
          .values({
            scope,
            env_name: service,
            value,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .execute();
      }

      // Also update process.env so the value is immediately available
      process.env[service] = value;
    },

    async delete(service: string): Promise<void> {
      await db.deleteFrom('credential_store')
        .where('scope', '=', scope)
        .where('env_name', '=', service)
        .execute();
      delete process.env[service];
    },

    async list(): Promise<string[]> {
      const rows = await db.selectFrom('credential_store')
        .select('env_name')
        .where('scope', '=', scope)
        .execute();
      return rows.map(r => r.env_name as string);
    },
  };
}
```

**Step 2: Run the tests to verify they pass**

Run: `npx vitest run tests/providers/credentials/database.test.ts`
Expected: All 13 tests PASS

**Step 3: Commit**

```bash
git add src/providers/credentials/database.ts
git commit -m "feat(credentials): implement database-backed credential provider"
```

---

### Task 4: Register in provider map and update config

**Files:**
- Modify: `src/host/provider-map.ts:53-56` — add `database` entry
- Modify: `src/config.ts:49-57` — add `'database'` to credentials union (alongside the `'env'` compat)

**Step 1: Add to provider map**

In `src/host/provider-map.ts`, add `database` to the `credentials` entry:

```typescript
  credentials: {
    plaintext: '../providers/credentials/plaintext.js',
    keychain:  '../providers/credentials/keychain.js',
    database:  '../providers/credentials/database.js',
  },
```

**Step 2: Update the config schema**

In `src/config.ts`, the credentials field already uses `providerEnum('credentials')` which auto-derives valid names from the provider map. The `z.literal('env')` compat union handles the deprecated name. Since `providerEnum` reads from `PROVIDER_MAP`, adding `database` to the map is sufficient — no config.ts change needed.

Verify by checking that `providerEnum('credentials')` generates enum values from `PROVIDER_MAP.credentials` keys.

**Step 3: Run type check**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 4: Commit**

```bash
git add src/host/provider-map.ts
git commit -m "feat(credentials): register database provider in static allowlist"
```

---

### Task 5: Update registry loading order

**Files:**
- Modify: `src/host/registry.ts:22-35` — load database before credentials when `credentials === 'database'`

**Step 1: Write a test for registry loading with database credentials**

This is integration-level — verify in the existing test suite or manually. The key behavioral change: when `config.providers.credentials === 'database'`, the database must be created before the credential provider and passed as an option.

**Step 2: Modify the registry**

In `src/host/registry.ts`, restructure the loading:

```typescript
export async function loadProviders(config: Config, opts?: LoadProvidersOptions): Promise<ProviderRegistry> {
  if (opts?.pluginHost) {
    await opts.pluginHost.startAll();
  }

  // When using database credentials, we need the DB connection first.
  // For other credential providers (plaintext, keychain), keep original order.
  let database: DatabaseProvider | undefined;
  const needsDbForCreds = config.providers.credentials === 'database';

  if (needsDbForCreds && config.providers.database) {
    const dbModPath = resolveProviderPath('database', config.providers.database);
    const dbMod = await import(dbModPath);
    database = await dbMod.create(config);
  }

  // Load credential provider (with database if needed)
  let credentials;
  if (needsDbForCreds) {
    const credModPath = resolveProviderPath('credentials', 'database');
    const credMod = await import(credModPath);
    credentials = await credMod.create(config, 'database', { database });
  } else {
    credentials = await loadProvider('credentials', config.providers.credentials, config);
  }

  const { loadCredentials } = await import('../dotenv.js');
  await loadCredentials(credentials);

  // Load database if not already loaded above
  if (!database && config.providers.database) {
    const dbModPath = resolveProviderPath('database', config.providers.database);
    const dbMod = await import(dbModPath);
    database = await dbMod.create(config);
  }

  // ... rest unchanged ...
```

**Step 3: Run tests**

Run: `npm test`
Expected: All existing tests still pass

**Step 4: Commit**

```bash
git add src/host/registry.ts
git commit -m "feat(credentials): load database before credentials when credentials=database"
```

---

### Task 6: Update Helm chart default

**Files:**
- Modify: `charts/ax/values.yaml:39` — change `credentials: env` to `credentials: database`

**Step 1: Update the values file**

In `charts/ax/values.yaml`, change:

```yaml
    credentials: database
```

This replaces the deprecated `env` value. The `database` provider persists credentials across pod restarts using the already-configured PostgreSQL instance.

**Step 2: Commit**

```bash
git add charts/ax/values.yaml
git commit -m "feat(k8s): use database credential provider in Helm chart defaults"
```

---

### Task 7: Run full test suite and verify

**Step 1: Run full test suite**

Run: `npm test`
Expected: All tests pass

**Step 2: Run type check**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Run the new credential tests specifically**

Run: `npx vitest run tests/providers/credentials/database.test.ts`
Expected: All 13 tests PASS

---

### Task 8: Update journal and lessons

**Files:**
- Modify: `.claude/journal/providers/index.md`
- Create or modify: `.claude/journal/providers/credentials.md`
- Modify: `.claude/lessons/providers/index.md` (if new lesson discovered)

**Step 1: Add journal entry**

Append to `.claude/journal/providers/credentials.md` (create if needed):

```markdown
## [2026-03-19 HH:MM] — Database-backed credential provider

**Task:** Implement a database-backed credential provider for k8s durability
**What I did:** Created `src/providers/credentials/database.ts` with migrations, registered in provider map, updated registry loading order to handle the DB-before-credentials dependency, updated Helm chart default
**Files touched:** src/providers/credentials/database.ts, src/providers/credentials/migrations.ts, src/host/provider-map.ts, src/host/registry.ts, charts/ax/values.yaml, tests/providers/credentials/database.test.ts
**Outcome:** Success — credentials now survive k8s pod restarts via PostgreSQL
**Notes:** The `scope` column (default: 'global') is future-proofing for per-user/per-agent credential isolation. Current implementation uses global scope only.
```

**Step 2: Commit everything**

Final commit with journal updates.
