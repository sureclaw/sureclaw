import { describe, it, expect } from 'vitest';
import { sql } from 'kysely';
import { createKyselyDb } from '../../src/utils/database.js';

describe('createKyselyDb', () => {
  it('creates a SQLite Kysely instance for a given path', async () => {
    const db = createKyselyDb({ type: 'sqlite', path: ':memory:' });
    const result = await sql`SELECT 1 as val`.execute(db);
    expect((result.rows[0] as any).val).toBe(1);
    await db.destroy();
  });

  it('throws for unsupported type', () => {
    expect(() => createKyselyDb({ type: 'mysql' as any })).toThrow('Unsupported');
  });
});
