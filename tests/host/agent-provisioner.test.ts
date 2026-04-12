import { describe, test, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentProvisioner } from '../../src/host/agent-provisioner.js';
import type { AgentRegistry } from '../../src/host/agent-registry.js';
import { createSqliteRegistry } from '../../src/host/agent-registry-db.js';
import type { DocumentStore } from '../../src/providers/storage/types.js';

function createMockDocStore(): DocumentStore {
  const store = new Map<string, string>();
  return {
    async get(collection: string, key: string) {
      return store.get(`${collection}/${key}`);
    },
    async put(collection: string, key: string, content: string) {
      store.set(`${collection}/${key}`, content);
    },
    async delete(collection: string, key: string) {
      return store.delete(`${collection}/${key}`);
    },
    async list(collection: string) {
      const prefix = `${collection}/`;
      return [...store.keys()]
        .filter(k => k.startsWith(prefix))
        .map(k => k.slice(prefix.length));
    },
  };
}

describe('AgentProvisioner', () => {
  let tmpDir: string;
  let registry: AgentRegistry;
  let documents: DocumentStore;
  let provisioner: AgentProvisioner;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ax-provisioner-test-'));
    registry = await createSqliteRegistry(join(tmpDir, 'registry.db'));
    documents = createMockDocStore();
    provisioner = new AgentProvisioner(registry, documents);
  });

  test('ensureAgent creates personal agent on first call', async () => {
    const agent = await provisioner.ensureAgent('alice');
    expect(agent.admins).toEqual(['alice']);
    expect(agent.name).toContain('alice');
    expect(agent.status).toBe('active');
  });

  test('ensureAgent returns existing agent on second call', async () => {
    const first = await provisioner.ensureAgent('alice');
    const second = await provisioner.ensureAgent('alice');
    expect(first.id).toBe(second.id);
  });

  test('resolveAgent returns specified agent if user is admin', async () => {
    const created = await provisioner.ensureAgent('alice');
    const resolved = await provisioner.resolveAgent('alice', created.id);
    expect(resolved.id).toBe(created.id);
  });

  test('resolveAgent falls back to ensureAgent when agentId not found', async () => {
    const resolved = await provisioner.resolveAgent('alice', 'nonexistent');
    expect(resolved.admins).toEqual(['alice']);
  });

  test('resolveAgent rejects when user is not admin of specified agent', async () => {
    const aliceAgent = await provisioner.ensureAgent('alice');
    await expect(provisioner.resolveAgent('bob', aliceAgent.id)).rejects.toThrow(/not authorized/i);
  });

  test('resolveAgent without agentId creates default agent', async () => {
    const resolved = await provisioner.resolveAgent('carol');
    expect(resolved.admins).toEqual(['carol']);
    expect(resolved.status).toBe('active');
  });

  test('different users get different agents', async () => {
    const alice = await provisioner.ensureAgent('alice');
    const bob = await provisioner.ensureAgent('bob');
    expect(alice.id).not.toBe(bob.id);
  });
});
