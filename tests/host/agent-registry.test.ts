import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentRegistry } from '../../src/host/agent-registry.js';
import { createSqliteRegistry } from '../../src/host/agent-registry-db.js';

describe('AgentRegistry', () => {
  let tmpDir: string;
  let registry: AgentRegistry;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ax-registry-test-'));
    registry = await createSqliteRegistry(join(tmpDir, 'registry.db'));
  });

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  test('list returns empty array when no registry file exists', async () => {
    expect(await registry.list()).toEqual([]);
  });

  test('register creates an agent entry', async () => {
    const entry = await registry.register({
      id: 'test-agent',
      name: 'Test Agent',
      description: 'A test agent',
      status: 'active',
      parentId: null,
      agentType: 'pi-coding-agent',
      capabilities: ['general'],
      createdBy: 'test',
    });

    expect(entry.id).toBe('test-agent');
    expect(entry.name).toBe('Test Agent');
    expect(entry.status).toBe('active');
    expect(entry.createdAt).toBeTruthy();
    expect(entry.updatedAt).toBeTruthy();
  });

  test('get retrieves a registered agent', async () => {
    await registry.register({
      id: 'my-agent',
      name: 'My Agent',
      status: 'active',
      parentId: null,
      agentType: 'pi-coding-agent',
      capabilities: [],
      createdBy: 'test',
    });

    const found = await registry.get('my-agent');
    expect(found).not.toBeNull();
    expect(found!.id).toBe('my-agent');
    expect(found!.name).toBe('My Agent');
  });

  test('get returns null for unknown agent', async () => {
    expect(await registry.get('nonexistent')).toBeNull();
  });

  test('register throws on duplicate ID', async () => {
    const entry = {
      id: 'dup',
      name: 'Dup',
      status: 'active' as const,
      parentId: null,
      agentType: 'pi-coding-agent',
      capabilities: [],
      createdBy: 'test',
    };

    await registry.register(entry);
    await expect(registry.register(entry)).rejects.toThrow('already exists');
  });

  test('update modifies mutable fields', async () => {
    await registry.register({
      id: 'up-agent',
      name: 'Original Name',
      status: 'active',
      parentId: null,
      agentType: 'pi-coding-agent',
      capabilities: ['general'],
      createdBy: 'test',
    });

    const updated = await registry.update('up-agent', {
      name: 'New Name',
      status: 'suspended',
      capabilities: ['general', 'web'],
    });

    expect(updated.name).toBe('New Name');
    expect(updated.status).toBe('suspended');
    expect(updated.capabilities).toEqual(['general', 'web']);
    // Immutable fields unchanged
    expect(updated.agentType).toBe('pi-coding-agent');
    expect(updated.createdBy).toBe('test');
  });

  test('update throws for unknown agent', async () => {
    await expect(registry.update('ghost', { name: 'X' })).rejects.toThrow('not found');
  });

  test('remove deletes an agent', async () => {
    await registry.register({
      id: 'rm-agent',
      name: 'Remove Me',
      status: 'active',
      parentId: null,
      agentType: 'pi-coding-agent',
      capabilities: [],
      createdBy: 'test',
    });

    expect(await registry.remove('rm-agent')).toBe(true);
    expect(await registry.get('rm-agent')).toBeNull();
    expect(await registry.list()).toHaveLength(0);
  });

  test('remove returns false for unknown agent', async () => {
    expect(await registry.remove('ghost')).toBe(false);
  });

  test('list filters by status', async () => {
    await registry.register({
      id: 'a1', name: 'Active', status: 'active',
      parentId: null, agentType: 'pi-coding-agent', capabilities: [], createdBy: 'test',
    });
    await registry.register({
      id: 'a2', name: 'Suspended', status: 'suspended',
      parentId: null, agentType: 'pi-coding-agent', capabilities: [], createdBy: 'test',
    });
    await registry.register({
      id: 'a3', name: 'Archived', status: 'archived',
      parentId: null, agentType: 'pi-coding-agent', capabilities: [], createdBy: 'test',
    });

    expect(await registry.list('active')).toHaveLength(1);
    expect(await registry.list('suspended')).toHaveLength(1);
    expect(await registry.list('archived')).toHaveLength(1);
    expect(await registry.list()).toHaveLength(3);
  });

  test('findByCapability returns matching active agents', async () => {
    await registry.register({
      id: 'web-agent', name: 'Web', status: 'active',
      parentId: null, agentType: 'pi-coding-agent', capabilities: ['web', 'general'], createdBy: 'test',
    });
    await registry.register({
      id: 'code-agent', name: 'Coder', status: 'active',
      parentId: null, agentType: 'pi-coding-agent', capabilities: ['coding'], createdBy: 'test',
    });
    await registry.register({
      id: 'off-agent', name: 'Offline', status: 'suspended',
      parentId: null, agentType: 'pi-coding-agent', capabilities: ['web'], createdBy: 'test',
    });

    const webAgents = await registry.findByCapability('web');
    expect(webAgents).toHaveLength(1);
    expect(webAgents[0].id).toBe('web-agent');
  });

  test('children returns child agents of a parent', async () => {
    await registry.register({
      id: 'parent', name: 'Parent', status: 'active',
      parentId: null, agentType: 'pi-coding-agent', capabilities: [], createdBy: 'test',
    });
    await registry.register({
      id: 'child1', name: 'Child 1', status: 'active',
      parentId: 'parent', agentType: 'pi-coding-agent', capabilities: [], createdBy: 'test',
    });
    await registry.register({
      id: 'child2', name: 'Child 2', status: 'active',
      parentId: 'parent', agentType: 'pi-coding-agent', capabilities: [], createdBy: 'test',
    });
    await registry.register({
      id: 'orphan', name: 'Orphan', status: 'active',
      parentId: null, agentType: 'pi-coding-agent', capabilities: [], createdBy: 'test',
    });

    const kids = await registry.children('parent');
    expect(kids).toHaveLength(2);
    expect(kids.map(k => k.id).sort()).toEqual(['child1', 'child2']);
  });

  describe('admins field', () => {
    test('register stores admins', async () => {
      const entry = await registry.register({
        id: 'test-agent',
        name: 'Test Agent',
        status: 'active',
        parentId: null,
        agentType: 'pi-coding-agent',
        capabilities: [],
        createdBy: 'alice',
        admins: ['alice'],
      });
      expect(entry.admins).toEqual(['alice']);
    });

    test('findByAdmin returns agents where userId is an admin', async () => {
      await registry.register({
        id: 'a1', name: 'A1', status: 'active', parentId: null,
        agentType: 'pi-coding-agent', capabilities: [], createdBy: 'alice',
        admins: ['alice'],
      });
      await registry.register({
        id: 'a2', name: 'A2', status: 'active', parentId: null,
        agentType: 'pi-coding-agent', capabilities: [], createdBy: 'bob',
        admins: ['bob', 'alice'],
      });
      await registry.register({
        id: 'a3', name: 'A3', status: 'active', parentId: null,
        agentType: 'pi-coding-agent', capabilities: [], createdBy: 'carol',
        admins: ['carol'],
      });

      const aliceAgents = await registry.findByAdmin('alice');
      expect(aliceAgents.map(a => a.id).sort()).toEqual(['a1', 'a2']);
    });

    test('findByAdmin only returns active agents', async () => {
      await registry.register({
        id: 'active-agent', name: 'Active', status: 'active', parentId: null,
        agentType: 'pi-coding-agent', capabilities: [], createdBy: 'alice',
        admins: ['alice'],
      });
      await registry.register({
        id: 'suspended-agent', name: 'Suspended', status: 'suspended', parentId: null,
        agentType: 'pi-coding-agent', capabilities: [], createdBy: 'alice',
        admins: ['alice'],
      });

      const agents = await registry.findByAdmin('alice');
      expect(agents).toHaveLength(1);
      expect(agents[0].id).toBe('active-agent');
    });

    test('register defaults admins to empty array when not provided', async () => {
      const entry = await registry.register({
        id: 'no-admins',
        name: 'No Admins',
        status: 'active',
        parentId: null,
        agentType: 'pi-coding-agent',
        capabilities: [],
        createdBy: 'test',
      });
      expect(entry.admins).toEqual([]);
    });
  });

  describe('display_name and agent_kind fields', () => {
    test('register stores display_name and agent_kind', async () => {
      const entry = await registry.register({
        id: 'backend-bot',
        name: 'Backend Bot',
        status: 'active',
        parentId: null,
        agentType: 'pi-coding-agent',
        capabilities: ['coding'],
        createdBy: 'alice',
        admins: ['alice'],
        displayName: 'Backend Team Bot',
        agentKind: 'shared',
      });
      expect(entry.displayName).toBe('Backend Team Bot');
      expect(entry.agentKind).toBe('shared');
    });

    test('display_name defaults to name when not provided', async () => {
      const entry = await registry.register({
        id: 'default-display',
        name: 'My Agent',
        status: 'active',
        parentId: null,
        agentType: 'pi-coding-agent',
        capabilities: [],
        createdBy: 'test',
      });
      expect(entry.displayName).toBe('My Agent');
    });

    test('agent_kind defaults to personal when not provided', async () => {
      const entry = await registry.register({
        id: 'default-kind',
        name: 'My Agent',
        status: 'active',
        parentId: null,
        agentType: 'pi-coding-agent',
        capabilities: [],
        createdBy: 'test',
      });
      expect(entry.agentKind).toBe('personal');
    });

    test('update can modify display_name', async () => {
      await registry.register({
        id: 'up-display',
        name: 'Original',
        status: 'active',
        parentId: null,
        agentType: 'pi-coding-agent',
        capabilities: [],
        createdBy: 'test',
        displayName: 'Original Display',
      });

      const updated = await registry.update('up-display', {
        displayName: 'New Display',
      });
      expect(updated.displayName).toBe('New Display');
    });

    test('findByKind returns agents of the specified kind', async () => {
      await registry.register({
        id: 'personal-a', name: 'PA', status: 'active', parentId: null,
        agentType: 'pi-coding-agent', capabilities: [], createdBy: 'alice',
        agentKind: 'personal',
      });
      await registry.register({
        id: 'shared-a', name: 'SA', status: 'active', parentId: null,
        agentType: 'pi-coding-agent', capabilities: [], createdBy: 'alice',
        agentKind: 'shared',
      });

      const shared = await registry.findByKind('shared');
      expect(shared).toHaveLength(1);
      expect(shared[0].id).toBe('shared-a');

      const personal = await registry.findByKind('personal');
      expect(personal).toHaveLength(1);
      expect(personal[0].id).toBe('personal-a');
    });
  });

  test('persists across registry instances', async () => {
    const path = join(tmpDir, 'persist.db');
    const r1 = await createSqliteRegistry(path);
    await r1.register({
      id: 'persist-test', name: 'Persist', status: 'active',
      parentId: null, agentType: 'pi-coding-agent', capabilities: [], createdBy: 'test',
    });

    const r2 = await createSqliteRegistry(path);
    expect(await r2.get('persist-test')).not.toBeNull();
  });
});
