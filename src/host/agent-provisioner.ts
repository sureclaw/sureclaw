/**
 * Agent Provisioner — auto-creates personal agents for users on first contact.
 *
 * Each user gets a personal agent (named `personal-{userId}-{uuid}`) with
 * themselves as the sole admin. The provisioner also validates access when
 * a specific agentId is requested.
 */

import { randomUUID } from 'node:crypto';
import type { AgentRegistry, AgentRegistryEntry } from './agent-registry.js';
import type { DocumentStore } from '../providers/storage/types.js';
import { getLogger } from '../logger.js';

const logger = getLogger().child({ component: 'agent-provisioner' });

export class AgentProvisioner {
  constructor(
    private readonly registry: AgentRegistry,
    private readonly documents?: DocumentStore,
  ) {}

  /** Ensure a personal agent exists for this user. Returns existing or newly created. */
  async ensureAgent(userId: string): Promise<AgentRegistryEntry> {
    const existing = await this.registry.findByAdmin(userId);
    if (existing.length > 0) return existing[0];

    const agentId = `personal-${userId.slice(0, 20)}-${randomUUID().slice(0, 8)}`;
    const agent = await this.registry.register({
      id: agentId,
      name: `${userId}'s Agent`,
      description: `Auto-provisioned personal agent for ${userId}`,
      status: 'active',
      parentId: null,
      agentType: 'pi-coding-agent',
      capabilities: ['general', 'memory', 'web', 'scheduling'],
      createdBy: userId,
      admins: [userId],
    });

    logger.info('agent_provisioned', { agentId: agent.id, userId });
    return agent;
  }

  /** Resolve which agent handles a request. Validates access. Falls back to ensureAgent. */
  async resolveAgent(userId: string, agentId?: string): Promise<AgentRegistryEntry> {
    if (agentId) {
      const agent = await this.registry.get(agentId);
      if (agent) {
        if (!agent.admins.includes(userId)) {
          throw new Error(`User "${userId}" is not authorized for agent "${agentId}"`);
        }
        return agent;
      }
      logger.warn('agent_not_found_fallback', { agentId, userId });
    }
    return this.ensureAgent(userId);
  }
}
