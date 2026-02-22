/**
 * Agent Registry — JSON-based registry of enterprise agents.
 *
 * Tracks registered agents, their capabilities, status, and relationships.
 * Stored at ~/.ax/registry.json (see paths.ts:registryPath).
 *
 * Thread-safe for single-process use (no file locking). Reads on-demand,
 * writes atomically via rename.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { registryPath } from '../paths.js';
import { getLogger } from '../logger.js';

const logger = getLogger().child({ component: 'agent-registry' });

// ═══════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════

export type AgentStatus = 'active' | 'suspended' | 'archived';

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
  /** Agent type (pi-agent-core, pi-coding-agent, claude-code). */
  agentType: string;
  /** Capability tags for routing and discovery. */
  capabilities: string[];
  /** ISO 8601 timestamp of creation. */
  createdAt: string;
  /** ISO 8601 timestamp of last update. */
  updatedAt: string;
  /** Who created this agent (user ID or 'system'). */
  createdBy: string;
}

export interface AgentRegistryData {
  version: 1;
  agents: AgentRegistryEntry[];
}

// ═══════════════════════════════════════════════════════
// Registry
// ═══════════════════════════════════════════════════════

export class AgentRegistry {
  private readonly filePath: string;

  constructor(filePath?: string) {
    this.filePath = filePath ?? registryPath();
  }

  /** Load the registry from disk. Returns empty registry if file doesn't exist. */
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

  /** Save the registry to disk atomically (write-then-rename). */
  private save(data: AgentRegistryData): void {
    const dir = dirname(this.filePath);
    mkdirSync(dir, { recursive: true });
    const tmpPath = join(dir, `.registry-${randomUUID().slice(0, 8)}.tmp`);
    writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
    renameSync(tmpPath, this.filePath);
  }

  /** List all agents, optionally filtered by status. */
  list(status?: AgentStatus): AgentRegistryEntry[] {
    const data = this.load();
    if (status) {
      return data.agents.filter(a => a.status === status);
    }
    return data.agents;
  }

  /** Get a single agent by ID. Returns null if not found. */
  get(agentId: string): AgentRegistryEntry | null {
    const data = this.load();
    return data.agents.find(a => a.id === agentId) ?? null;
  }

  /** Register a new agent. Returns the created entry. */
  register(entry: Omit<AgentRegistryEntry, 'createdAt' | 'updatedAt'>): AgentRegistryEntry {
    const data = this.load();

    // Check for duplicate ID
    if (data.agents.some(a => a.id === entry.id)) {
      throw new Error(`Agent "${entry.id}" already exists in registry`);
    }

    const now = new Date().toISOString();
    const full: AgentRegistryEntry = {
      ...entry,
      createdAt: now,
      updatedAt: now,
    };

    data.agents.push(full);
    this.save(data);
    logger.info('agent_registered', { agentId: entry.id, agentType: entry.agentType });
    return full;
  }

  /** Update an existing agent's mutable fields. Returns updated entry. */
  update(agentId: string, updates: Partial<Pick<AgentRegistryEntry, 'name' | 'description' | 'status' | 'capabilities'>>): AgentRegistryEntry {
    const data = this.load();
    const idx = data.agents.findIndex(a => a.id === agentId);
    if (idx === -1) {
      throw new Error(`Agent "${agentId}" not found in registry`);
    }

    const agent = data.agents[idx];
    const updated: AgentRegistryEntry = {
      ...agent,
      ...updates,
      updatedAt: new Date().toISOString(),
    };
    data.agents[idx] = updated;
    this.save(data);
    logger.info('agent_updated', { agentId, updates: Object.keys(updates) });
    return updated;
  }

  /** Remove an agent from the registry. Returns true if found and removed. */
  remove(agentId: string): boolean {
    const data = this.load();
    const idx = data.agents.findIndex(a => a.id === agentId);
    if (idx === -1) return false;

    data.agents.splice(idx, 1);
    this.save(data);
    logger.info('agent_removed', { agentId });
    return true;
  }

  /** Find agents by capability tag. */
  findByCapability(capability: string): AgentRegistryEntry[] {
    const data = this.load();
    return data.agents.filter(a =>
      a.status === 'active' && a.capabilities.includes(capability)
    );
  }

  /** Get child agents of a parent. */
  children(parentId: string): AgentRegistryEntry[] {
    const data = this.load();
    return data.agents.filter(a => a.parentId === parentId);
  }

  /** Ensure the default 'main' agent exists. Called on server startup. */
  ensureDefault(): AgentRegistryEntry {
    const existing = this.get('main');
    if (existing) return existing;

    return this.register({
      id: 'main',
      name: 'Main Agent',
      description: 'Default primary agent',
      status: 'active',
      parentId: null,
      agentType: 'pi-agent-core',
      capabilities: ['general', 'memory', 'web', 'scheduling'],
      createdBy: 'system',
    });
  }
}
