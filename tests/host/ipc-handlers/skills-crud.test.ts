import { describe, it, expect, beforeEach } from 'vitest';
import { upsertSkill, getSkill, listSkills, deleteSkill } from '../../../src/providers/storage/skills.js';

// Use an in-memory DocumentStore mock
function createMockDocStore() {
  const store = new Map<string, Map<string, string>>();
  return {
    async put(collection: string, key: string, value: string) {
      if (!store.has(collection)) store.set(collection, new Map());
      store.get(collection)!.set(key, value);
    },
    async get(collection: string, key: string) {
      return store.get(collection)?.get(key) ?? null;
    },
    async list(collection: string) {
      return [...(store.get(collection)?.keys() ?? [])];
    },
    async delete(collection: string, key: string) {
      return store.get(collection)?.delete(key) ?? false;
    },
  };
}

describe('skill CRUD with files', () => {
  let docs: ReturnType<typeof createMockDocStore>;

  beforeEach(() => { docs = createMockDocStore(); });

  it('upsertSkill stores files array', async () => {
    await upsertSkill(docs as any, {
      id: 'linear',
      agentId: 'main',
      version: '1.0.0',
      instructions: '# Linear Skill',
      files: [
        { path: 'SKILL.md', content: '# Linear Skill' },
        { path: 'schema.json', content: '{}' },
      ],
      mcpApps: ['linear'],
    });

    const skill = await getSkill(docs as any, 'main', 'linear');
    expect(skill).not.toBeNull();
    expect(skill!.files).toHaveLength(2);
    expect(skill!.files[1].path).toBe('schema.json');
  });

  it('upsertSkill defaults files to SKILL.md when omitted', async () => {
    await upsertSkill(docs as any, {
      id: 'test',
      agentId: 'main',
      version: '1.0.0',
      instructions: '# Test',
      mcpApps: [],
    });

    const skill = await getSkill(docs as any, 'main', 'test');
    expect(skill!.files).toHaveLength(1);
    expect(skill!.files[0].path).toBe('SKILL.md');
  });

  it('listSkills returns all skills for agent', async () => {
    await upsertSkill(docs as any, { id: 'a', agentId: 'main', version: '1', instructions: '', mcpApps: [] });
    await upsertSkill(docs as any, { id: 'b', agentId: 'main', version: '1', instructions: '', mcpApps: [] });
    await upsertSkill(docs as any, { id: 'c', agentId: 'other', version: '1', instructions: '', mcpApps: [] });

    const skills = await listSkills(docs as any, 'main');
    expect(skills).toHaveLength(2);
  });

  it('deleteSkill removes from store', async () => {
    await upsertSkill(docs as any, { id: 'x', agentId: 'main', version: '1', instructions: '', mcpApps: [] });
    const deleted = await deleteSkill(docs as any, 'main', 'x');
    expect(deleted).toBe(true);
    const skill = await getSkill(docs as any, 'main', 'x');
    expect(skill).toBeNull();
  });
});
