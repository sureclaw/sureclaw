/**
 * Tests for company identity read/write IPC handlers.
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';
import { createCompanyHandlers } from '../../../src/host/ipc-handlers/company.js';
import type { IPCContext } from '../../../src/host/ipc-server.js';
import type { DocumentStore } from '../../../src/providers/storage/types.js';
import type { AuditProvider } from '../../../src/providers/audit/types.js';

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

describe('company identity IPC handlers', () => {
  let docs: DocumentStore;
  let audit: AuditProvider;

  beforeEach(() => {
    docs = createMockDocStore();
    audit = { log: vi.fn() } as any;
  });

  test('company_identity_read returns stored content', async () => {
    await docs.put('identity', 'company/AGENTS.md', '# Company Agents');
    const handlers = createCompanyHandlers(docs, audit);
    const ctx: IPCContext = { sessionId: 's1', agentId: 'system', userId: 'alice' };
    const result = await handlers.company_identity_read({ file: 'AGENTS.md' }, ctx);
    expect(result.content).toBe('# Company Agents');
  });

  test('company_identity_read returns null for missing file', async () => {
    const handlers = createCompanyHandlers(docs, audit);
    const ctx: IPCContext = { sessionId: 's1', agentId: 'system', userId: 'alice' };
    const result = await handlers.company_identity_read({ file: 'AGENTS.md' }, ctx);
    expect(result.content).toBeNull();
  });

  test('company_identity_write requires company admin', async () => {
    const handlers = createCompanyHandlers(docs, audit);
    const ctx: IPCContext = { sessionId: 's1', agentId: 'system', userId: 'alice' };
    // alice is not a company admin
    await expect(
      handlers.company_identity_write({ file: 'AGENTS.md', content: '# New', reason: 'test' }, ctx)
    ).rejects.toThrow(/company admin/i);
  });

  test('company_identity_write succeeds for company admin', async () => {
    // Set up alice as company admin
    await docs.put('config', 'company/admins', JSON.stringify(['alice']));
    const handlers = createCompanyHandlers(docs, audit);
    const ctx: IPCContext = { sessionId: 's1', agentId: 'system', userId: 'alice' };

    await handlers.company_identity_write({ file: 'AGENTS.md', content: '# Updated Company Agents', reason: 'update agents' }, ctx);

    const stored = await docs.get('identity', 'company/AGENTS.md');
    expect(stored).toBe('# Updated Company Agents');
  });

  test('company_identity_write audits the write', async () => {
    await docs.put('config', 'company/admins', JSON.stringify(['alice']));
    const handlers = createCompanyHandlers(docs, audit);
    const ctx: IPCContext = { sessionId: 's1', agentId: 'system', userId: 'alice' };

    await handlers.company_identity_write({ file: 'IDENTITY.md', content: '# New Identity', reason: 'rebrand' }, ctx);

    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({
      action: 'company_identity_write',
    }));
  });
});
