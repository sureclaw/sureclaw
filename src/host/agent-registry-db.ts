/**
 * Database-backed Agent Registry — PostgreSQL implementation.
 *
 * Uses the shared Kysely instance from DatabaseProvider.
 * Runs its own migration (registry_001_agent_registry) on creation.
 */

import { sql, type Kysely } from 'kysely';
import type { DatabaseProvider } from '../providers/database/types.js';
import type { AgentRegistry, AgentRegistryEntry, AgentRegisterInput, AgentStatus, AgentKind } from './agent-registry.js';
import { runMigrations } from '../utils/migrator.js';
import { createKyselyDb } from '../utils/database.js';
import { getLogger } from '../logger.js';

const logger = getLogger().child({ component: 'agent-registry-db' });

type DbDialect = 'sqlite' | 'postgresql';

// ── Migration ──

function registryMigrations(dbType: DbDialect) {
  const isSqlite = dbType === 'sqlite';
  const timestampCol = isSqlite ? 'text' as const : 'timestamptz' as const;
  const nowDefault = isSqlite ? sql`(datetime('now'))` : sql`NOW()`;

  return {
    registry_001_agent_registry: {
      async up(db: Kysely<any>) {
        await db.schema
          .createTable('agent_registry')
          .ifNotExists()
          .addColumn('id', 'text', col => col.primaryKey())
          .addColumn('name', 'text', col => col.notNull())
          .addColumn('description', 'text')
          .addColumn('status', 'text', col => col.notNull().defaultTo('active'))
          .addColumn('parent_id', 'text')
          .addColumn('agent_type', 'text', col => col.notNull())
          .addColumn('capabilities', 'text', col => col.notNull().defaultTo('[]'))
          .addColumn('created_at', timestampCol, col => col.notNull().defaultTo(nowDefault))
          .addColumn('updated_at', timestampCol, col => col.notNull().defaultTo(nowDefault))
          .addColumn('created_by', 'text', col => col.notNull())
          .execute();

        await db.schema
          .createIndex('idx_agent_registry_status')
          .ifNotExists()
          .on('agent_registry')
          .column('status')
          .execute();

        await db.schema
          .createIndex('idx_agent_registry_parent')
          .ifNotExists()
          .on('agent_registry')
          .column('parent_id')
          .execute();
      },
      async down(db: Kysely<any>) {
        await db.schema.dropTable('agent_registry').ifExists().execute();
      },
    },
    registry_002_agent_admins: {
      async up(db: Kysely<any>) {
        await db.schema.alterTable('agent_registry')
          .addColumn('admins', 'text', col => col.notNull().defaultTo('[]'))
          .execute();
      },
      async down(db: Kysely<any>) {
        await db.schema.alterTable('agent_registry')
          .dropColumn('admins')
          .execute();
      },
    },
    registry_003_display_name_agent_kind: {
      async up(db: Kysely<any>) {
        await db.schema.alterTable('agent_registry')
          .addColumn('display_name', 'text')
          .execute();
        await db.schema.alterTable('agent_registry')
          .addColumn('agent_kind', 'text', col => col.notNull().defaultTo('personal'))
          .execute();
        // Backfill display_name from name for existing rows
        await sql`UPDATE agent_registry SET display_name = name WHERE display_name IS NULL`.execute(db);
      },
      async down(db: Kysely<any>) {
        await db.schema.alterTable('agent_registry')
          .dropColumn('display_name')
          .execute();
        await db.schema.alterTable('agent_registry')
          .dropColumn('agent_kind')
          .execute();
      },
    },
  };
}

// ── Row ↔ Entry mapping ──

interface AgentRow {
  id: string;
  name: string;
  description: string | null;
  status: string;
  parent_id: string | null;
  agent_type: string;
  capabilities: string;
  created_at: string;
  updated_at: string;
  created_by: string;
  admins: string;
  display_name: string | null;
  agent_kind: string;
}

function rowToEntry(row: AgentRow): AgentRegistryEntry {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    status: row.status as AgentStatus,
    parentId: row.parent_id,
    agentType: row.agent_type,
    capabilities: JSON.parse(row.capabilities) as string[],
    createdAt: typeof row.created_at === 'object' ? (row.created_at as Date).toISOString() : row.created_at,
    updatedAt: typeof row.updated_at === 'object' ? (row.updated_at as Date).toISOString() : row.updated_at,
    createdBy: row.created_by,
    admins: row.admins ? JSON.parse(row.admins) as string[] : [],
    displayName: row.display_name ?? row.name,
    agentKind: (row.agent_kind as AgentKind) ?? 'personal',
  };
}

// ── Implementation ──

export class DatabaseAgentRegistry implements AgentRegistry {
  private readonly db: Kysely<any>;

  private constructor(db: Kysely<any>) {
    this.db = db;
  }

  static async create(database: DatabaseProvider): Promise<DatabaseAgentRegistry> {
    await runMigrations(database.db, registryMigrations(database.type), 'registry_migration');
    logger.info('registry_migrations_complete');
    return new DatabaseAgentRegistry(database.db);
  }

  async list(status?: AgentStatus): Promise<AgentRegistryEntry[]> {
    let query = this.db.selectFrom('agent_registry').selectAll();
    if (status) query = query.where('status', '=', status);
    const rows = await query.execute() as AgentRow[];
    return rows.map(rowToEntry);
  }

  async get(agentId: string): Promise<AgentRegistryEntry | null> {
    const row = await this.db.selectFrom('agent_registry')
      .selectAll()
      .where('id', '=', agentId)
      .executeTakeFirst() as AgentRow | undefined;
    return row ? rowToEntry(row) : null;
  }

  async register(entry: AgentRegisterInput): Promise<AgentRegistryEntry> {
    const existing = await this.get(entry.id);
    if (existing) throw new Error(`Agent "${entry.id}" already exists in registry`);

    const admins = entry.admins ?? [];
    const displayName = entry.displayName ?? entry.name;
    const agentKind = entry.agentKind ?? 'personal';
    const now = new Date().toISOString();
    await this.db.insertInto('agent_registry').values({
      id: entry.id,
      name: entry.name,
      description: entry.description ?? null,
      status: entry.status,
      parent_id: entry.parentId,
      agent_type: entry.agentType,
      capabilities: JSON.stringify(entry.capabilities),
      created_at: now,
      updated_at: now,
      created_by: entry.createdBy,
      admins: JSON.stringify(admins),
      display_name: displayName,
      agent_kind: agentKind,
    }).execute();

    logger.info('agent_registered', { agentId: entry.id, agentType: entry.agentType });
    return { ...entry, admins, displayName, agentKind, createdAt: now, updatedAt: now };
  }

  async update(agentId: string, updates: Partial<Pick<AgentRegistryEntry, 'name' | 'description' | 'status' | 'capabilities' | 'displayName'>>): Promise<AgentRegistryEntry> {
    const now = new Date().toISOString();
    const values: Record<string, unknown> = { updated_at: now };
    if (updates.name !== undefined) values.name = updates.name;
    if (updates.description !== undefined) values.description = updates.description;
    if (updates.status !== undefined) values.status = updates.status;
    if (updates.capabilities !== undefined) values.capabilities = JSON.stringify(updates.capabilities);
    if (updates.displayName !== undefined) values.display_name = updates.displayName;

    const result = await this.db.updateTable('agent_registry')
      .set(values)
      .where('id', '=', agentId)
      .executeTakeFirst();

    if (result.numUpdatedRows === 0n) throw new Error(`Agent "${agentId}" not found in registry`);

    logger.info('agent_updated', { agentId, updates: Object.keys(updates) });
    const updated = await this.get(agentId);
    return updated!;
  }

  async remove(agentId: string): Promise<boolean> {
    const result = await this.db.deleteFrom('agent_registry')
      .where('id', '=', agentId)
      .executeTakeFirst();
    if (result.numDeletedRows > 0n) {
      logger.info('agent_removed', { agentId });
      return true;
    }
    return false;
  }

  async findByCapability(capability: string): Promise<AgentRegistryEntry[]> {
    // Use LIKE for JSON array search (capabilities is stored as '["general","memory"]')
    const rows = await this.db.selectFrom('agent_registry')
      .selectAll()
      .where('status', '=', 'active')
      .where('capabilities', 'like', `%"${capability}"%`)
      .execute() as AgentRow[];
    return rows.map(rowToEntry);
  }

  async findByAdmin(userId: string): Promise<AgentRegistryEntry[]> {
    const rows = await this.db.selectFrom('agent_registry')
      .selectAll()
      .where('status', '=', 'active')
      .where('admins', 'like', `%"${userId}"%`)
      .execute() as AgentRow[];
    return rows.map(rowToEntry);
  }

  async findByKind(kind: AgentKind): Promise<AgentRegistryEntry[]> {
    const rows = await this.db.selectFrom('agent_registry')
      .selectAll()
      .where('status', '=', 'active')
      .where('agent_kind', '=', kind)
      .execute() as AgentRow[];
    return rows.map(rowToEntry);
  }

  async children(parentId: string): Promise<AgentRegistryEntry[]> {
    const rows = await this.db.selectFrom('agent_registry')
      .selectAll()
      .where('parent_id', '=', parentId)
      .execute() as AgentRow[];
    return rows.map(rowToEntry);
  }

}

/**
 * Convenience factory: create a SQLite-backed registry at the given file path.
 * Useful for tests and local dev where no DatabaseProvider is configured.
 */
export async function createSqliteRegistry(dbPath: string): Promise<AgentRegistry> {
  const db = createKyselyDb({ type: 'sqlite', path: dbPath });
  const provider: DatabaseProvider = {
    db,
    type: 'sqlite',
    vectorsAvailable: false,
    close: async () => { await db.destroy(); },
  };
  return DatabaseAgentRegistry.create(provider);
}
