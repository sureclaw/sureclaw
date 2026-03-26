import { describe, it, expect } from 'vitest';
import { createWorkspaceHandlers } from '../../../src/host/ipc-handlers/workspace.js';

function mockProviders(files: Array<{ path: string; content: Buffer; size: number }>) {
  return {
    workspace: {
      activeMounts: () => [],
      mount: async () => ({ paths: {} }),
      listFiles: async () => files.map(f => ({ path: f.path, size: f.size })),
      downloadScope: async () => files.map(f => ({ path: f.path, content: f.content })),
    },
    audit: { log: async () => {} },
  } as any;
}

const ctx = { sessionId: 'test-session', agentId: 'main', userId: 'user1' } as any;

describe('workspace_list', () => {
  it('lists all files in scope', async () => {
    const files = [
      { path: 'a.txt', content: Buffer.from('hello'), size: 5 },
      { path: 'dir/b.txt', content: Buffer.from('world'), size: 5 },
    ];
    const handlers = createWorkspaceHandlers(mockProviders(files), { agentName: 'main', profile: '' });
    const result = await handlers.workspace_list({ scope: 'agent' }, ctx);
    expect(result.ok).toBe(true);
    expect(result.files).toHaveLength(2);
  });

  it('filters by prefix', async () => {
    const files = [
      { path: 'a.txt', content: Buffer.from(''), size: 0 },
      { path: 'dir/b.txt', content: Buffer.from(''), size: 0 },
    ];
    const handlers = createWorkspaceHandlers(mockProviders(files), { agentName: 'main', profile: '' });
    const result = await handlers.workspace_list({ scope: 'agent', prefix: 'dir/' }, ctx);
    expect(result.ok).toBe(true);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].path).toBe('dir/b.txt');
  });
});

describe('workspace_read', () => {
  it('reads a single file', async () => {
    const files = [{ path: 'test.md', content: Buffer.from('# Hello'), size: 7 }];
    const handlers = createWorkspaceHandlers(mockProviders(files), { agentName: 'main', profile: '' });
    const result = await handlers.workspace_read({ scope: 'user', path: 'test.md' }, ctx);
    expect(result.ok).toBe(true);
    expect(result.content).toBe('# Hello');
  });

  it('returns error for missing file', async () => {
    const handlers = createWorkspaceHandlers(mockProviders([]), { agentName: 'main', profile: '' });
    const result = await handlers.workspace_read({ scope: 'user', path: 'missing.md' }, ctx);
    expect(result.ok).toBe(false);
  });
});
