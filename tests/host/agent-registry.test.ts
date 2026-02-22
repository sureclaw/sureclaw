import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentRegistry } from '../../src/host/agent-registry.js';

describe('AgentRegistry', () => {
  let tmpDir: string;
  let registry: AgentRegistry;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ax-registry-test-'));
    registry = new AgentRegistry(join(tmpDir, 'registry.json'));
  });

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  test('list returns empty array when no registry file exists', () => {
    expect(registry.list()).toEqual([]);
  });

  test('register creates an agent entry', () => {
    const entry = registry.register({
      id: 'test-agent',
      name: 'Test Agent',
      description: 'A test agent',
      status: 'active',
      parentId: null,
      agentType: 'pi-agent-core',
      capabilities: ['general'],
      createdBy: 'test',
    });

    expect(entry.id).toBe('test-agent');
    expect(entry.name).toBe('Test Agent');
    expect(entry.status).toBe('active');
    expect(entry.createdAt).toBeTruthy();
    expect(entry.updatedAt).toBeTruthy();
  });

  test('get retrieves a registered agent', () => {
    registry.register({
      id: 'my-agent',
      name: 'My Agent',
      status: 'active',
      parentId: null,
      agentType: 'pi-agent-core',
      capabilities: [],
      createdBy: 'test',
    });

    const found = registry.get('my-agent');
    expect(found).not.toBeNull();
    expect(found!.id).toBe('my-agent');
    expect(found!.name).toBe('My Agent');
  });

  test('get returns null for unknown agent', () => {
    expect(registry.get('nonexistent')).toBeNull();
  });

  test('register throws on duplicate ID', () => {
    const entry = {
      id: 'dup',
      name: 'Dup',
      status: 'active' as const,
      parentId: null,
      agentType: 'pi-agent-core',
      capabilities: [],
      createdBy: 'test',
    };

    registry.register(entry);
    expect(() => registry.register(entry)).toThrow('already exists');
  });

  test('update modifies mutable fields', () => {
    registry.register({
      id: 'up-agent',
      name: 'Original Name',
      status: 'active',
      parentId: null,
      agentType: 'pi-agent-core',
      capabilities: ['general'],
      createdBy: 'test',
    });

    const updated = registry.update('up-agent', {
      name: 'New Name',
      status: 'suspended',
      capabilities: ['general', 'web'],
    });

    expect(updated.name).toBe('New Name');
    expect(updated.status).toBe('suspended');
    expect(updated.capabilities).toEqual(['general', 'web']);
    // Immutable fields unchanged
    expect(updated.agentType).toBe('pi-agent-core');
    expect(updated.createdBy).toBe('test');
  });

  test('update throws for unknown agent', () => {
    expect(() => registry.update('ghost', { name: 'X' })).toThrow('not found');
  });

  test('remove deletes an agent', () => {
    registry.register({
      id: 'rm-agent',
      name: 'Remove Me',
      status: 'active',
      parentId: null,
      agentType: 'pi-agent-core',
      capabilities: [],
      createdBy: 'test',
    });

    expect(registry.remove('rm-agent')).toBe(true);
    expect(registry.get('rm-agent')).toBeNull();
    expect(registry.list()).toHaveLength(0);
  });

  test('remove returns false for unknown agent', () => {
    expect(registry.remove('ghost')).toBe(false);
  });

  test('list filters by status', () => {
    registry.register({
      id: 'a1', name: 'Active', status: 'active',
      parentId: null, agentType: 'pi-agent-core', capabilities: [], createdBy: 'test',
    });
    registry.register({
      id: 'a2', name: 'Suspended', status: 'suspended',
      parentId: null, agentType: 'pi-agent-core', capabilities: [], createdBy: 'test',
    });
    registry.register({
      id: 'a3', name: 'Archived', status: 'archived',
      parentId: null, agentType: 'pi-agent-core', capabilities: [], createdBy: 'test',
    });

    expect(registry.list('active')).toHaveLength(1);
    expect(registry.list('suspended')).toHaveLength(1);
    expect(registry.list('archived')).toHaveLength(1);
    expect(registry.list()).toHaveLength(3);
  });

  test('findByCapability returns matching active agents', () => {
    registry.register({
      id: 'web-agent', name: 'Web', status: 'active',
      parentId: null, agentType: 'pi-agent-core', capabilities: ['web', 'general'], createdBy: 'test',
    });
    registry.register({
      id: 'code-agent', name: 'Coder', status: 'active',
      parentId: null, agentType: 'pi-coding-agent', capabilities: ['coding'], createdBy: 'test',
    });
    registry.register({
      id: 'off-agent', name: 'Offline', status: 'suspended',
      parentId: null, agentType: 'pi-agent-core', capabilities: ['web'], createdBy: 'test',
    });

    const webAgents = registry.findByCapability('web');
    expect(webAgents).toHaveLength(1);
    expect(webAgents[0].id).toBe('web-agent');
  });

  test('children returns child agents of a parent', () => {
    registry.register({
      id: 'parent', name: 'Parent', status: 'active',
      parentId: null, agentType: 'pi-agent-core', capabilities: [], createdBy: 'test',
    });
    registry.register({
      id: 'child1', name: 'Child 1', status: 'active',
      parentId: 'parent', agentType: 'pi-agent-core', capabilities: [], createdBy: 'test',
    });
    registry.register({
      id: 'child2', name: 'Child 2', status: 'active',
      parentId: 'parent', agentType: 'pi-agent-core', capabilities: [], createdBy: 'test',
    });
    registry.register({
      id: 'orphan', name: 'Orphan', status: 'active',
      parentId: null, agentType: 'pi-agent-core', capabilities: [], createdBy: 'test',
    });

    const kids = registry.children('parent');
    expect(kids).toHaveLength(2);
    expect(kids.map(k => k.id).sort()).toEqual(['child1', 'child2']);
  });

  test('ensureDefault creates main agent on first call', () => {
    const main = registry.ensureDefault();
    expect(main.id).toBe('main');
    expect(main.status).toBe('active');
    expect(main.createdBy).toBe('system');
  });

  test('ensureDefault returns existing main agent on subsequent calls', () => {
    const first = registry.ensureDefault();
    const second = registry.ensureDefault();
    expect(first.createdAt).toBe(second.createdAt);
  });

  test('persists across registry instances', () => {
    const path = join(tmpDir, 'persist.json');
    const r1 = new AgentRegistry(path);
    r1.register({
      id: 'persist-test', name: 'Persist', status: 'active',
      parentId: null, agentType: 'pi-agent-core', capabilities: [], createdBy: 'test',
    });

    const r2 = new AgentRegistry(path);
    expect(r2.get('persist-test')).not.toBeNull();
  });
});
