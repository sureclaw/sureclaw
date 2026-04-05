/**
 * Agent Registry — tracks registered agents, capabilities, status, relationships.
 *
 * Two implementations:
 *   - FileAgentRegistry  — JSON file at ~/.ax/registry.json (used with SQLite / no database)
 *   - DatabaseAgentRegistry — PostgreSQL-backed (see agent-registry-db.ts)
 *
 * Use createAgentRegistry() factory to get the right one.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { registryPath } from '../paths.js';
import { getLogger } from '../logger.js';
import type { DatabaseProvider } from '../providers/database/types.js';

const logger = getLogger().child({ component: 'agent-registry' });

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
// File-based implementation
// ═══════════════════════════════════════════════════════

interface AgentRegistryData {
  version: 1;
  agents: AgentRegistryEntry[];
}

export class FileAgentRegistry implements AgentRegistry {
  private readonly filePath: string;

  constructor(filePath?: string) {
    this.filePath = filePath ?? registryPath();
  }

  private load(): AgentRegistryData {
    try {
      if (!existsSync(this.filePath)) {
        return { version: 1, agents: [] };
      }
      const raw = readFileSync(this.filePath, 'utf-8');
      const data = JSON.parse(raw) as AgentRegistryData;
      if (data.version !== 1) {
        logger.warn('registry_version_mismatch', { version: data.version });
      }
      return data;
    } catch (err) {
      logger.error('registry_load_error', { error: (err as Error).message });
      return { version: 1, agents: [] };
    }
  }

  private save(data: AgentRegistryData): void {
    const dir = dirname(this.filePath);
    mkdirSync(dir, { recursive: true });
    const tmpPath = join(dir, `.registry-${randomUUID().slice(0, 8)}.tmp`);
    writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
    renameSync(tmpPath, this.filePath);
  }

  async list(status?: AgentStatus): Promise<AgentRegistryEntry[]> {
    const data = this.load();
    return status ? data.agents.filter(a => a.status === status) : data.agents;
  }

  async get(agentId: string): Promise<AgentRegistryEntry | null> {
    const data = this.load();
    return data.agents.find(a => a.id === agentId) ?? null;
  }

  async register(entry: AgentRegisterInput): Promise<AgentRegistryEntry> {
    const data = this.load();
    if (data.agents.some(a => a.id === entry.id)) {
      throw new Error(`Agent "${entry.id}" already exists in registry`);
    }
    const now = new Date().toISOString();
    const full: AgentRegistryEntry = {
      ...entry,
      admins: entry.admins ?? [],
      displayName: entry.displayName ?? entry.name,
      agentKind: entry.agentKind ?? 'personal',
      createdAt: now,
      updatedAt: now,
    };
    data.agents.push(full);
    this.save(data);
    logger.info('agent_registered', { agentId: entry.id, agentType: entry.agentType });
    return full;
  }

  async update(agentId: string, updates: Partial<Pick<AgentRegistryEntry, 'name' | 'description' | 'status' | 'capabilities' | 'displayName'>>): Promise<AgentRegistryEntry> {
    const data = this.load();
    const idx = data.agents.findIndex(a => a.id === agentId);
    if (idx === -1) throw new Error(`Agent "${agentId}" not found in registry`);
    const updated: AgentRegistryEntry = { ...data.agents[idx], ...updates, updatedAt: new Date().toISOString() };
    data.agents[idx] = updated;
    this.save(data);
    logger.info('agent_updated', { agentId, updates: Object.keys(updates) });
    return updated;
  }

  async remove(agentId: string): Promise<boolean> {
    const data = this.load();
    const idx = data.agents.findIndex(a => a.id === agentId);
    if (idx === -1) return false;
    data.agents.splice(idx, 1);
    this.save(data);
    logger.info('agent_removed', { agentId });
    return true;
  }

  async findByCapability(capability: string): Promise<AgentRegistryEntry[]> {
    const data = this.load();
    return data.agents.filter(a => a.status === 'active' && a.capabilities.includes(capability));
  }

  async findByAdmin(userId: string): Promise<AgentRegistryEntry[]> {
    const data = this.load();
    return data.agents.filter(a => a.status === 'active' && a.admins?.includes(userId));
  }

  async findByKind(kind: AgentKind): Promise<AgentRegistryEntry[]> {
    const data = this.load();
    return data.agents.filter(a => a.status === 'active' && a.agentKind === kind);
  }

  async children(parentId: string): Promise<AgentRegistryEntry[]> {
    const data = this.load();
    return data.agents.filter(a => a.parentId === parentId);
  }

}

// ═══════════════════════════════════════════════════════
// Factory
// ═══════════════════════════════════════════════════════

export async function createAgentRegistry(database?: DatabaseProvider): Promise<AgentRegistry> {
  if (database?.type === 'postgresql') {
    const { DatabaseAgentRegistry } = await import('./agent-registry-db.js');
    return DatabaseAgentRegistry.create(database);
  }
  return new FileAgentRegistry();
}
