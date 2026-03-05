import { mkdirSync } from 'node:fs';
import type { Kysely } from 'kysely';
import type { DatabaseProvider } from './providers/database/types.js';
import { createKyselyDb } from './utils/database.js';
import { runMigrations } from './utils/migrator.js';
import { filesMigrations } from './migrations/files.js';
import { dataDir, dataFile } from './paths.js';

export interface FileEntry {
  fileId: string;
  agentName: string;
  userId: string;
  mimeType: string;
  createdAt: string;
}

export class FileStore {
  private db: Kysely<any>;

  constructor(db: Kysely<any>) {
    this.db = db;
  }

  static async create(database?: DatabaseProvider): Promise<FileStore> {
    let db: Kysely<any>;
    if (database) {
      db = database.db;
    } else {
      mkdirSync(dataDir(), { recursive: true });
      db = createKyselyDb({ type: 'sqlite', path: dataFile('files.db') });
    }
    const result = await runMigrations(db, filesMigrations);
    if (result.error) throw result.error;
    return new FileStore(db);
  }

  /** Register a file mapping: fileId -> (agentName, userId, mimeType). */
  async register(fileId: string, agentName: string, userId: string, mimeType: string): Promise<void> {
    await this.db.insertInto('files')
      .values({ file_id: fileId, agent_name: agentName, user_id: userId, mime_type: mimeType })
      .onConflict(oc => oc.column('file_id').doUpdateSet({
        agent_name: agentName,
        user_id: userId,
        mime_type: mimeType,
      }))
      .execute();
  }

  /** Look up a file by its globally unique fileId. */
  async lookup(fileId: string): Promise<FileEntry | undefined> {
    const row = await this.db.selectFrom('files')
      .select(['file_id', 'agent_name', 'user_id', 'mime_type', 'created_at'])
      .where('file_id', '=', fileId)
      .executeTakeFirst();
    if (!row) return undefined;
    return {
      fileId: row.file_id as string,
      agentName: row.agent_name as string,
      userId: row.user_id as string,
      mimeType: row.mime_type as string,
      createdAt: row.created_at as string,
    };
  }

  async close(): Promise<void> {
    // No-op: the shared DatabaseProvider owns the connection.
  }
}
