// tests/host/skills/current-state.test.ts
import { describe, it, expect } from 'vitest';
import { loadCurrentState, type CurrentStateDeps } from '../../../src/host/skills/current-state.js';
import type { CredentialProvider } from '../../../src/providers/credentials/types.js';
import type { SkillStateStore } from '../../../src/host/skills/state-store.js';
import { ProxyDomainList } from '../../../src/host/proxy-domain-list.js';
import type { SkillState, SetupRequest, SkillStateKind } from '../../../src/host/skills/types.js';

/** Build a stub credentials provider keyed by scope. */
function stubCredentials(args: {
  byScope?: Record<string, string[]>;
  byPrefix?: Record<string, Array<{ scope: string; envName: string }>>;
}): CredentialProvider {
  const byScope = args.byScope ?? {};
  const byPrefix = args.byPrefix ?? {};
  return {
    async get() { return null; },
    async set() {},
    async delete() {},
    async list(scope?: string) {
      return byScope[scope ?? 'global'] ?? [];
    },
    async listScopePrefix(prefix: string) {
      return byPrefix[prefix] ?? [];
    },
  };
}

/** Build a stub SkillStateStore that only implements getPriorStates. */
function stubStateStore(
  priorByAgent: Record<string, Map<string, SkillStateKind>>,
): SkillStateStore {
  return {
    async getPriorStates(agentId: string) {
      return priorByAgent[agentId] ?? new Map<string, SkillStateKind>();
    },
    async putStates(_agentId: string, _states: SkillState[]) {},
    async putSetupQueue(_agentId: string, _queue: SetupRequest[]) {},
    async putStatesAndQueue(
      _agentId: string,
      _states: SkillState[],
      _queue: SetupRequest[],
    ) {},
    async getSetupQueue(_agentId: string) { return []; },
  };
}

describe('loadCurrentState', () => {
  it('aggregates approvals, credentials (both scopes), mcp, and prior states', async () => {
    const proxyDomainList = new ProxyDomainList();
    proxyDomainList.approvePending('api.linear.app');

    const credentials = stubCredentials({
      byScope: {
        'agent:foo-agent': ['BAR_KEY'],
      },
      byPrefix: {
        'user:foo-agent:': [
          { scope: 'user:foo-agent:alice', envName: 'LINEAR_TOKEN' },
        ],
      },
    });

    const mcpManager = {
      listRegistered() {
        return [{ name: 'linear', url: 'https://mcp.linear.app' }];
      },
    };

    const stateStore = stubStateStore({
      'agent-1': new Map<string, SkillStateKind>([['linear', 'enabled']]),
    });

    const deps: CurrentStateDeps = {
      agentName: 'foo-agent',
      proxyDomainList,
      credentials,
      mcpManager,
      stateStore,
    };

    const result = await loadCurrentState('agent-1', deps);

    expect(result.approvedDomains.has('api.linear.app')).toBe(true);
    expect(result.storedCredentials.has('BAR_KEY@agent')).toBe(true);
    expect(result.storedCredentials.has('LINEAR_TOKEN@user')).toBe(true);
    expect(result.registeredMcpServers.get('linear')?.url).toBe('https://mcp.linear.app');
    expect(result.priorSkillStates.get('linear')).toBe('enabled');
  });

  it('returns an empty registeredMcpServers Map when no mcpManager is provided', async () => {
    const deps: CurrentStateDeps = {
      agentName: 'foo-agent',
      proxyDomainList: new ProxyDomainList(),
      credentials: stubCredentials({}),
      stateStore: stubStateStore({}),
      // mcpManager omitted
    };

    const result = await loadCurrentState('agent-1', deps);

    expect(result.registeredMcpServers).toBeInstanceOf(Map);
    expect(result.registeredMcpServers.size).toBe(0);
  });

  it('returns correctly-typed empty collections when everything is empty', async () => {
    const deps: CurrentStateDeps = {
      agentName: 'foo-agent',
      // ProxyDomainList still contains BUILTIN_DOMAINS, so use a fake here
      //   to isolate "empty everything" from builtin domains
      proxyDomainList: {
        getAllowedDomains: () => new Set<string>(),
      } as unknown as ProxyDomainList,
      credentials: stubCredentials({}),
      mcpManager: { listRegistered: () => [] },
      stateStore: stubStateStore({}),
    };

    const result = await loadCurrentState('agent-1', deps);

    expect(result.approvedDomains).toBeInstanceOf(Set);
    expect(result.approvedDomains.size).toBe(0);
    expect(result.storedCredentials).toBeInstanceOf(Set);
    expect(result.storedCredentials.size).toBe(0);
    expect(result.registeredMcpServers).toBeInstanceOf(Map);
    expect(result.registeredMcpServers.size).toBe(0);
    expect(result.priorSkillStates).toBeInstanceOf(Map);
    expect(result.priorSkillStates.size).toBe(0);
  });
});
