/**
 * Agent Registry — tracks registered agents, capabilities, status, relationships.
 *
 * Uses DatabaseAgentRegistry (see agent-registry-db.ts) backed by either
 * PostgreSQL or SQLite depending on the configured DatabaseProvider.
 *
 * Use createAgentRegistry() factory to get an instance.
 */

import { mkdirSync } from 'node:fs';
import type { DatabaseProvider } from '../providers/database/types.js';
import { createKyselyDb } from '../utils/database.js';
import { dataDir, dataFile } from '../paths.js';

// ═══════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════

export type AgentStatus = 'active' | 'suspended' | 'archived';

/** Whether this agent is personal (one user) or shared (team/company). */
export type AgentKind = 'personal' | 'shared';

export interface AgentRegistryEntry {
  /** Unique agent identifier (alphanumeric, dash, underscore). */
  id: string;
  /** Human-readable display name. */
  name: string;
  /** Brief description of what this agent does. */
  description?: string;
  /** Current status. */
  status: AgentStatus;
  /** Parent agent ID (for delegation hierarchy). Null for root agents. */
  parentId: string | null;
  /** Agent type (pi-coding-agent, claude-code). */
  agentType: string;
  /** Capability tags for routing and discovery. */
  capabilities: string[];
  /** ISO 8601 timestamp of creation. */
  createdAt: string;
  /** ISO 8601 timestamp of last update. */
  updatedAt: string;
  /** Who created this agent (user ID or 'system'). */
  createdBy: string;
  /** UserIds who can administer this agent. Creator is always first admin. */
  admins: string[];
  /** Display name shown in Slack responses (defaults to name). */
  displayName: string;
  /** Whether this is a personal or shared agent. Defaults to 'personal'. */
  agentKind: AgentKind;
}

// ═══════════════════════════════════════════════════════
// Interface
// ═══════════════════════════════════════════════════════

/** Input type for agent registration. admins defaults to []. displayName defaults to name. agentKind defaults to 'personal'. */
export type AgentRegisterInput = Omit<AgentRegistryEntry, 'createdAt' | 'updatedAt' | 'admins' | 'displayName' | 'agentKind'> & {
  admins?: string[];
  displayName?: string;
  agentKind?: AgentKind;
};

export interface AgentRegistry {
  list(status?: AgentStatus): Promise<AgentRegistryEntry[]>;
  get(agentId: string): Promise<AgentRegistryEntry | null>;
  register(entry: AgentRegisterInput): Promise<AgentRegistryEntry>;
  update(agentId: string, updates: Partial<Pick<AgentRegistryEntry, 'name' | 'description' | 'status' | 'capabilities' | 'displayName'>>): Promise<AgentRegistryEntry>;
  remove(agentId: string): Promise<boolean>;
  findByCapability(capability: string): Promise<AgentRegistryEntry[]>;
  findByAdmin(userId: string): Promise<AgentRegistryEntry[]>;
  findByKind(kind: AgentKind): Promise<AgentRegistryEntry[]>;
  children(parentId: string): Promise<AgentRegistryEntry[]>;
}

// ═══════════════════════════════════════════════════════
// Factory
// ═══════════════════════════════════════════════════════

export async function createAgentRegistry(database?: DatabaseProvider): Promise<AgentRegistry> {
  const { DatabaseAgentRegistry } = await import('./agent-registry-db.js');

  if (database) {
    return DatabaseAgentRegistry.create(database);
  }

  // No external database — create a local SQLite-backed registry
  mkdirSync(dataDir(), { recursive: true });
  const db = createKyselyDb({ type: 'sqlite', path: dataFile('registry.db') });
  const sqliteProvider: DatabaseProvider = {
    db,
    type: 'sqlite',
    vectorsAvailable: false,
    close: async () => { await db.destroy(); },
  };
  return DatabaseAgentRegistry.create(sqliteProvider);
}
