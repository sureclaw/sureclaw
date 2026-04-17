// src/host/skills/current-state.ts — Aggregate host-side state for the
// skills reconciler. Thin async loader — hides provider-specific key formats
// (credential scope strings, MCP server shape) from the orchestrator.

import type { ReconcilerCurrentState } from './types.js';
import type { ProxyDomainList } from '../proxy-domain-list.js';
import type { CredentialProvider } from '../../providers/credentials/types.js';
import type { SkillStateStore } from './state-store.js';
import { credentialScope } from '../credential-scopes.js';

/** Narrow read-only view of an MCP manager. Phase 2 takes a stub. */
export interface McpManagerRead {
  listRegistered(): Array<{ name: string; url: string }>;
}

export interface CurrentStateDeps {
  /** Used to build credential scope keys (`agent:<name>`, `user:<name>:*`). */
  agentName: string;
  proxyDomainList: ProxyDomainList;
  credentials: CredentialProvider;
  /** Phase 2: may be omitted / a stub. Real wiring lands later. */
  mcpManager?: McpManagerRead;
  stateStore: SkillStateStore;
}

/**
 * Poll existing host providers and return the `ReconcilerCurrentState` that
 * the phase-1 reconciler expects. Pure async aggregator — no caching, no
 * batching, no side effects.
 *
 * storedCredentials uses `${envName}@${scope}` keys where scope is either
 * `agent` (one row per envName at `agent:<agentName>`) or `user` (any envName
 * present under any `user:<agentName>:*` scope). Phase 2 YAGNI: if ANY user
 * has the credential, `${envName}@user` is in the set — phase 6 will refine
 * once OAuth lands.
 */
export async function loadCurrentState(
  agentId: string,
  deps: CurrentStateDeps,
): Promise<ReconcilerCurrentState> {
  const { agentName, proxyDomainList, credentials, mcpManager, stateStore } = deps;

  // 1. Approved domains — ProxyDomainList returns a fresh Set.
  const approvedDomains = proxyDomainList.getAllowedDomains();

  // 2. Stored credentials across both scopes.
  const storedCredentials = new Set<string>();

  const agentEnvNames = await credentials.list(credentialScope(agentName));
  for (const envName of agentEnvNames) {
    storedCredentials.add(`${envName}@agent`);
  }

  // User scope uses a prefix match — any `user:<agentName>:<userId>` row
  // contributes `${envName}@user`. The `user:<agentName>:` shape mirrors
  // credentialScope(agentName, userId) — see credential-scopes.ts.
  const userScopePrefix = `user:${agentName}:`;
  const userRows = await credentials.listScopePrefix(userScopePrefix);
  for (const row of userRows) {
    storedCredentials.add(`${row.envName}@user`);
  }

  // 3. MCP servers — phase 2 may have no manager wired yet.
  const registeredMcpServers = new Map<string, { url: string }>();
  if (mcpManager) {
    for (const server of mcpManager.listRegistered()) {
      registeredMcpServers.set(server.name, { url: server.url });
    }
  }

  // 4. Prior skill states for this agent.
  const priorSkillStates = await stateStore.getPriorStates(agentId);

  return {
    approvedDomains,
    storedCredentials,
    registeredMcpServers,
    priorSkillStates,
  };
}
