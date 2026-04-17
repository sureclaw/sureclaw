import { describe, it, expect, vi } from 'vitest';
import { createSkillsHandlers } from '../../../src/host/ipc-handlers/skills.js';
import type { SkillStateStore } from '../../../src/host/skills/state-store.js';
import type { SkillState } from '../../../src/host/skills/types.js';
import type { ProviderRegistry } from '../../../src/types.js';
import type { IPCContext } from '../../../src/host/ipc-server.js';
import { initLogger } from '../../../src/logger.js';

initLogger({ file: false, level: 'silent' });

function makeProviders(): ProviderRegistry {
  return {
    audit: { log: vi.fn().mockResolvedValue(undefined), query: vi.fn().mockResolvedValue([]) },
    credentials: { get: vi.fn(), set: vi.fn(), list: vi.fn(), delete: vi.fn() },
  } as unknown as ProviderRegistry;
}

function makeCtx(agentId: string): IPCContext {
  return { sessionId: 's1', agentId };
}

function makeStore(byAgent: Record<string, SkillState[]>): SkillStateStore {
  return {
    getPriorStates: vi.fn(async () => new Map()),
    getStates: vi.fn(async (agentId: string) => byAgent[agentId] ?? []),
    putStates: vi.fn(),
    putSetupQueue: vi.fn(),
    getSetupQueue: vi.fn(async () => []),
    putStatesAndQueue: vi.fn(),
  };
}

describe('skills_index handler', () => {
  it('returns {skills: []} when stateStore is not wired', async () => {
    const handlers = createSkillsHandlers(makeProviders(), {});
    const res = await handlers.skills_index({ action: 'skills_index' }, makeCtx('a1'));
    expect(res).toEqual({ skills: [] });
  });

  it('reads from stateStore scoped to ctx.agentId', async () => {
    const store = makeStore({
      alpha: [
        { name: 'linear', kind: 'pending', description: 'Linear issues', pendingReasons: ['needs LINEAR_TOKEN'] },
        { name: 'weather', kind: 'enabled', description: 'Weather data' },
      ],
      beta: [{ name: 'other', kind: 'enabled', description: 'Beta only' }],
    });
    const handlers = createSkillsHandlers(makeProviders(), { stateStore: store });
    const res = await handlers.skills_index({ action: 'skills_index' }, makeCtx('alpha'));
    expect(res.skills).toHaveLength(2);
    expect(res.skills[0]).toEqual({
      name: 'linear',
      kind: 'pending',
      description: 'Linear issues',
      pendingReasons: ['needs LINEAR_TOKEN'],
    });
    expect(res.skills[1]).toEqual({
      name: 'weather',
      kind: 'enabled',
      description: 'Weather data',
    });
    expect(store.getStates).toHaveBeenCalledWith('alpha');
  });

  it('omits description and pendingReasons when unset on the source row', async () => {
    const store = makeStore({
      a: [{ name: 'bad', kind: 'invalid', error: 'parse error' }],
    });
    const handlers = createSkillsHandlers(makeProviders(), { stateStore: store });
    const res = await handlers.skills_index({ action: 'skills_index' }, makeCtx('a'));
    expect(res.skills).toEqual([{ name: 'bad', kind: 'invalid' }]);
    expect(res.skills[0]).not.toHaveProperty('description');
    expect(res.skills[0]).not.toHaveProperty('pendingReasons');
    expect(res.skills[0]).not.toHaveProperty('error');
  });

  it('returns empty array for unknown agent', async () => {
    const store = makeStore({ a: [{ name: 'x', kind: 'enabled', description: 'X' }] });
    const handlers = createSkillsHandlers(makeProviders(), { stateStore: store });
    const res = await handlers.skills_index({ action: 'skills_index' }, makeCtx('other'));
    expect(res.skills).toEqual([]);
  });
});
