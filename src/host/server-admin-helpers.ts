// src/host/server-admin-helpers.ts — Admin helper functions backed by AgentRegistry + DocumentStore.
//
// All state is stored in the database. No filesystem access.

import type { AgentRegistry } from './agent-registry.js';
import type { DocumentStore } from '../providers/storage/types.js';

export interface AdminContext {
  registry: AgentRegistry;
  documents: DocumentStore;
  agentId: string;
}

/** Returns true when the agent is still in bootstrap mode (missing SOUL.md or IDENTITY.md while BOOTSTRAP.md present). */
export async function isAgentBootstrapMode(ctx: AdminContext): Promise<boolean> {
  const { documents, agentId } = ctx;
  const bootstrap = await documents.get('identity', `${agentId}/BOOTSTRAP.md`);
  if (!bootstrap) return false;
  const soul = await documents.get('identity', `${agentId}/SOUL.md`);
  const identity = await documents.get('identity', `${agentId}/IDENTITY.md`);
  return !soul || !identity;
}

/** Returns true when the given userId is an admin for this agent. */
export async function isAdmin(ctx: AdminContext, userId: string): Promise<boolean> {
  const entry = await ctx.registry.get(ctx.agentId);
  if (!entry) return false;
  return entry.admins.includes(userId);
}

/** Adds a userId to the agent's admins list. */
export async function addAdmin(ctx: AdminContext, userId: string): Promise<void> {
  await ctx.registry.addAdmin(ctx.agentId, userId);
}

/**
 * Atomically claims the bootstrap admin slot for the given userId.
 * Returns true if this user is the first to claim (and is added to admins).
 * Returns false if someone already claimed it.
 */
export async function claimBootstrapAdmin(ctx: AdminContext, userId: string): Promise<boolean> {
  return ctx.registry.claimBootstrapAdmin(ctx.agentId, userId);
}
