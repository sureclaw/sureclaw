import { describe, it, expect, vi } from 'vitest';
import { createIPCHandler } from '../../src/host/ipc-server.js';
import type { SkillStateStore } from '../../src/host/skills/state-store.js';
import type { SkillState } from '../../src/host/skills/types.js';
import type { ProviderRegistry } from '../../src/types.js';
import { initLogger } from '../../src/logger.js';

initLogger({ file: false, level: 'silent' });

function makeProviders(): ProviderRegistry {
  return {
    audit: { log: vi.fn().mockResolvedValue(undefined), query: vi.fn().mockResolvedValue([]) },
    credentials: { get: vi.fn(), set: vi.fn(), list: vi.fn(), delete: vi.fn() },
  } as unknown as ProviderRegistry;
}

function makeStateStore(rows: SkillState[]): SkillStateStore {
  return {
    getPriorStates: vi.fn(async () => new Map()),
    getStates: vi.fn(async () => rows),
    putStates: vi.fn(),
    putSetupQueue: vi.fn(),
    getSetupQueue: vi.fn(async () => []),
    putStatesAndQueue: vi.fn(),
  };
}

describe('createIPCHandler + stateStore wiring', () => {
  it('threads stateStore into skills_index handler', async () => {
    const store = makeStateStore([
      { name: 'linear', kind: 'pending', description: 'Linear issues', pendingReasons: ['needs LINEAR_TOKEN'] },
    ]);
    const handleIPC = createIPCHandler(makeProviders(), { agentId: 'alpha', stateStore: store });
    const raw = JSON.stringify({ action: 'skills_index', _msgId: 1 });
    const responseStr = await handleIPC(raw, { sessionId: 's', agentId: 'alpha' });
    const res = JSON.parse(responseStr);
    expect(res.ok).toBe(true);
    expect(res.skills).toEqual([
      { name: 'linear', kind: 'pending', description: 'Linear issues', pendingReasons: ['needs LINEAR_TOKEN'] },
    ]);
    expect(store.getStates).toHaveBeenCalledWith('alpha');
  });

  it('returns empty skills when stateStore not provided', async () => {
    const handleIPC = createIPCHandler(makeProviders(), { agentId: 'alpha' });
    const raw = JSON.stringify({ action: 'skills_index', _msgId: 2 });
    const responseStr = await handleIPC(raw, { sessionId: 's', agentId: 'alpha' });
    const res = JSON.parse(responseStr);
    expect(res.ok).toBe(true);
    expect(res.skills).toEqual([]);
  });
});
