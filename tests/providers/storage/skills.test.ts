import { describe, it, expect } from 'vitest';
import {
  upsertSkill, getSkill, listSkills, deleteSkill, inferMcpApps,
} from '../../../src/providers/storage/skills.js';
import type { DocumentStore } from '../../../src/providers/storage/types.js';

// ---------------------------------------------------------------------------
// In-memory DocumentStore stub
// ---------------------------------------------------------------------------

function memoryDocuments(): DocumentStore {
  const store = new Map<string, Map<string, string>>();

  return {
    async get(collection: string, key: string) {
      return store.get(collection)?.get(key);
    },
    async put(collection: string, key: string, content: string) {
      if (!store.has(collection)) store.set(collection, new Map());
      store.get(collection)!.set(key, content);
    },
    async delete(collection: string, key: string) {
      return store.get(collection)?.delete(key) ?? false;
    },
    async list(collection: string) {
      return [...(store.get(collection)?.keys() ?? [])];
    },
  };
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

describe('skill CRUD (DocumentStore)', () => {
  it('upsert and get skill', async () => {
    const docs = memoryDocuments();
    await upsertSkill(docs, {
      id: 'linear-skill',
      agentId: 'agent-1',
      version: '1.0.0',
      instructions: 'Use linear_get_issues to find issues.',
      mcpApps: ['linear'],
    });

    const skill = await getSkill(docs, 'agent-1', 'linear-skill');
    expect(skill).not.toBeNull();
    expect(skill!.id).toBe('linear-skill');
    expect(skill!.instructions).toContain('linear_get_issues');
    expect(skill!.mcpApps).toEqual(['linear']);
    expect(skill!.authType).toBeNull();
  });

  it('upsert overwrites existing skill', async () => {
    const docs = memoryDocuments();
    await upsertSkill(docs, {
      id: 'my-skill',
      agentId: 'agent-1',
      version: '1.0.0',
      instructions: 'v1',
      mcpApps: [],
    });
    await upsertSkill(docs, {
      id: 'my-skill',
      agentId: 'agent-1',
      version: '2.0.0',
      instructions: 'v2',
      mcpApps: ['gmail'],
    });

    const skill = await getSkill(docs, 'agent-1', 'my-skill');
    expect(skill!.version).toBe('2.0.0');
    expect(skill!.instructions).toBe('v2');
    expect(skill!.mcpApps).toEqual(['gmail']);
  });

  it('get returns null for non-existent skill', async () => {
    const docs = memoryDocuments();
    expect(await getSkill(docs, 'agent-1', 'nope')).toBeNull();
  });

  it('listSkills returns only skills for the given agent', async () => {
    const docs = memoryDocuments();
    await upsertSkill(docs, { id: 's1', agentId: 'a1', version: '1', instructions: 'i1', mcpApps: [] });
    await upsertSkill(docs, { id: 's2', agentId: 'a1', version: '1', instructions: 'i2', mcpApps: [] });
    await upsertSkill(docs, { id: 's3', agentId: 'a2', version: '1', instructions: 'i3', mcpApps: [] });

    const a1Skills = await listSkills(docs, 'a1');
    expect(a1Skills).toHaveLength(2);
    expect(a1Skills.map(s => s.id).sort()).toEqual(['s1', 's2']);

    const a2Skills = await listSkills(docs, 'a2');
    expect(a2Skills).toHaveLength(1);
    expect(a2Skills[0].id).toBe('s3');
  });

  it('deleteSkill removes the skill', async () => {
    const docs = memoryDocuments();
    await upsertSkill(docs, { id: 'del-me', agentId: 'a1', version: '1', instructions: '', mcpApps: [] });

    expect(await getSkill(docs, 'a1', 'del-me')).not.toBeNull();
    const deleted = await deleteSkill(docs, 'a1', 'del-me');
    expect(deleted).toBe(true);
    expect(await getSkill(docs, 'a1', 'del-me')).toBeNull();
  });

  it('deleteSkill returns false for non-existent', async () => {
    const docs = memoryDocuments();
    expect(await deleteSkill(docs, 'a1', 'nope')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// inferMcpApps
// ---------------------------------------------------------------------------

describe('inferMcpApps', () => {
  it('extracts apps from custom_api_call patterns', () => {
    const instructions = 'Use google_slides_custom_api_call for presentations.';
    expect(inferMcpApps(instructions)).toContain('google-slides');
  });

  it('extracts apps from CRUD tool patterns', () => {
    const instructions = 'Call linear_get_issues and linear_create_issue.';
    const apps = inferMcpApps(instructions);
    expect(apps).toContain('linear');
  });

  it('returns empty for no tool references', () => {
    expect(inferMcpApps('Just a simple instruction with no tools.')).toEqual([]);
  });

  it('deduplicates apps', () => {
    const instructions = 'Use linear_get_issues then linear_create_issue.';
    const apps = inferMcpApps(instructions);
    const linearCount = apps.filter(a => a === 'linear').length;
    expect(linearCount).toBe(1);
  });
});
