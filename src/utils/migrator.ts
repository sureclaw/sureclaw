// src/utils/migrator.ts — DB-agnostic migration runner built on Kysely
import { Migrator, type Kysely, type Migration } from 'kysely';

/** A named set of migrations. Keys determine execution order (alphanumeric sort). */
export type MigrationSet = Record<string, Migration>;

export interface MigrationResult {
  /** Undefined on success, the error on failure. */
  error?: unknown;
  /** Number of newly applied migrations. */
  applied: number;
  /** Names of migrations that were applied. */
  names: string[];
}

/**
 * Run all pending migrations against the given Kysely instance.
 *
 * Migrations are executed in alphanumeric key order. Already-applied
 * migrations (tracked in `kysely_migration` table) are skipped.
 * Uses database-level locking so concurrent calls are safe.
 */
export async function runMigrations(
  db: Kysely<any>,
  migrations: MigrationSet,
): Promise<MigrationResult> {
  const migrator = new Migrator({
    db,
    provider: { getMigrations: async () => migrations },
  });

  const { error, results } = await migrator.migrateToLatest();

  const applied = (results ?? []).filter(r => r.status === 'Success');

  return {
    error,
    applied: applied.length,
    names: applied.map(r => r.migrationName),
  };
}
