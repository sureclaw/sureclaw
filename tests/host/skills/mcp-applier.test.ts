import { describe, it, expect, vi } from 'vitest';
import { McpConnectionManager } from '../../../src/plugins/mcp-manager.js';
import { createMcpApplier } from '../../../src/host/skills/mcp-applier.js';

function makeManager() {
  return new McpConnectionManager();
}

function fakeAudit() {
  const entries: any[] = [];
  return { log: vi.fn(async (e: any) => { entries.push(e); }), query: vi.fn(), entries };
}

describe('McpApplier', () => {
  it('registers desired servers when nothing is present', async () => {
    const mcp = makeManager();
    const audit = fakeAudit();
    const applier = createMcpApplier({ mcpManager: mcp, audit });

    const result = await applier.apply('a1', new Map([
      ['linear', { url: 'https://mcp.linear.app' }],
    ]));

    expect(result.registered).toEqual([{ name: 'linear', url: 'https://mcp.linear.app' }]);
    expect(result.unregistered).toEqual([]);
    expect(result.conflicts).toEqual([]);
    expect(mcp.listServers('_').map(s => s.name)).toEqual(['linear']);
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'mcp_registered' }));
  });

  it('unregisters servers that drop out of desired', async () => {
    const mcp = makeManager();
    mcp.addServer('_', { name: 'linear', type: 'http', url: 'https://mcp.linear.app' }, { source: 'skill:a1' });
    const applier = createMcpApplier({ mcpManager: mcp });

    const result = await applier.apply('a1', new Map());

    expect(result.unregistered).toEqual([{ name: 'linear' }]);
    expect(mcp.listServers('_')).toEqual([]);
  });

  it('is idempotent when desired matches current', async () => {
    const mcp = makeManager();
    mcp.addServer('_', { name: 'linear', type: 'http', url: 'https://mcp.linear.app' }, { source: 'skill:a1' });
    const applier = createMcpApplier({ mcpManager: mcp });

    const result = await applier.apply('a1', new Map([
      ['linear', { url: 'https://mcp.linear.app' }],
    ]));

    expect(result.registered).toEqual([]);
    expect(result.unregistered).toEqual([]);
  });

  it('re-registers when URL changes for same name', async () => {
    const mcp = makeManager();
    mcp.addServer('_', { name: 'linear', type: 'http', url: 'https://old.example' }, { source: 'skill:a1' });
    const applier = createMcpApplier({ mcpManager: mcp });

    const result = await applier.apply('a1', new Map([
      ['linear', { url: 'https://new.example' }],
    ]));

    expect(result.registered).toEqual([{ name: 'linear', url: 'https://new.example' }]);
    expect(result.unregistered).toEqual([{ name: 'linear' }]);
    expect(mcp.listServers('_')[0].url).toBe('https://new.example');
  });

  it('does not touch servers owned by other sources (plugins/database/other agents)', async () => {
    const mcp = makeManager();
    mcp.addServer('_', { name: 'hubspot', type: 'http', url: 'https://hub' }, { source: 'plugin:hubspot' });
    mcp.addServer('_', { name: 'linear', type: 'http', url: 'https://lin-a2' }, { source: 'skill:a2' });
    const applier = createMcpApplier({ mcpManager: mcp });

    const result = await applier.apply('a1', new Map([
      ['notes', { url: 'https://notes' }],
    ]));

    expect(result.registered.map(r => r.name)).toEqual(['notes']);
    // hubspot + linear untouched
    expect(mcp.listServers('_').map(s => s.name).sort()).toEqual(['hubspot', 'linear', 'notes']);
  });

  it('emits skill.mcp_global_conflict when name already owned by non-skill source', async () => {
    const mcp = makeManager();
    mcp.addServer('_', { name: 'linear', type: 'http', url: 'https://plugin-url' }, { source: 'plugin:linear' });
    const applier = createMcpApplier({ mcpManager: mcp });

    const result = await applier.apply('a1', new Map([
      ['linear', { url: 'https://skill-url' }],
    ]));

    expect(result.registered).toEqual([]);
    expect(result.conflicts).toEqual([
      { name: 'linear', desiredUrl: 'https://skill-url', existingUrl: 'https://plugin-url', existingSource: 'plugin:linear' },
    ]);
    // Existing server NOT overwritten
    expect(mcp.listServers('_')[0].url).toBe('https://plugin-url');
  });

  it('attaches Authorization header placeholder when bearerCredential is set', async () => {
    const mcp = makeManager();
    const applier = createMcpApplier({ mcpManager: mcp });

    await applier.apply('a1', new Map([
      ['linear', { url: 'https://mcp.linear.app', bearerCredential: 'LINEAR_TOKEN' }],
    ]));

    const meta = mcp.getServerMeta('_', 'linear');
    expect(meta?.source).toBe('skill:a1');
    expect(meta?.headers).toEqual({ Authorization: 'Bearer ${LINEAR_TOKEN}' });
  });

  it('re-registers when bearerCredential changes (same URL)', async () => {
    const mcp = makeManager();
    const applier = createMcpApplier({ mcpManager: mcp });

    await applier.apply('a1', new Map([
      ['linear', { url: 'https://mcp.linear.app', bearerCredential: 'OLD_TOKEN' }],
    ]));

    const result = await applier.apply('a1', new Map([
      ['linear', { url: 'https://mcp.linear.app', bearerCredential: 'NEW_TOKEN' }],
    ]));

    expect(result.unregistered).toEqual([{ name: 'linear' }]);
    expect(result.registered).toEqual([{ name: 'linear', url: 'https://mcp.linear.app' }]);
    expect(mcp.getServerMeta('_', 'linear')?.headers).toEqual({
      Authorization: 'Bearer ${NEW_TOKEN}',
    });
  });

  it('re-registers when bearerCredential is added (previously unset)', async () => {
    const mcp = makeManager();
    const applier = createMcpApplier({ mcpManager: mcp });

    await applier.apply('a1', new Map([
      ['linear', { url: 'https://mcp.linear.app' }],
    ]));
    const result = await applier.apply('a1', new Map([
      ['linear', { url: 'https://mcp.linear.app', bearerCredential: 'LINEAR_TOKEN' }],
    ]));

    expect(result.unregistered).toEqual([{ name: 'linear' }]);
    expect(result.registered).toEqual([{ name: 'linear', url: 'https://mcp.linear.app' }]);
    expect(mcp.getServerMeta('_', 'linear')?.headers).toEqual({
      Authorization: 'Bearer ${LINEAR_TOKEN}',
    });
  });

  it('is idempotent when bearerCredential is unchanged', async () => {
    const mcp = makeManager();
    const applier = createMcpApplier({ mcpManager: mcp });

    await applier.apply('a1', new Map([
      ['linear', { url: 'https://mcp.linear.app', bearerCredential: 'LINEAR_TOKEN' }],
    ]));
    const result = await applier.apply('a1', new Map([
      ['linear', { url: 'https://mcp.linear.app', bearerCredential: 'LINEAR_TOKEN' }],
    ]));

    expect(result.registered).toEqual([]);
    expect(result.unregistered).toEqual([]);
  });
});
