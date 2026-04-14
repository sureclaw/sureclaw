import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createGovernanceHandlers } from '../../../src/host/ipc-handlers/governance.js';
import type { AgentRegistry } from '../../../src/host/agent-registry.js';
import { createSqliteRegistry } from '../../../src/host/agent-registry-db.js';
import type { IPCContext } from '../../../src/host/ipc-server.js';
import type { ProviderRegistry } from '../../../src/types.js';
import type { AdminContext } from '../../../src/host/server-admin-helpers.js';

let tmpDir: string;
let proposalsDirPath: string;
let adminCtx: AdminContext;

vi.mock('../../../src/paths.js', () => ({
  proposalsDir: () => proposalsDirPath,
}));

function createInMemoryDocuments(): any {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (_col: string, key: string) => store.get(key) ?? null),
    put: vi.fn(async (_col: string, key: string, content: string) => { store.set(key, content); }),
    delete: vi.fn(async (_col: string, key: string) => { store.delete(key); }),
    list: vi.fn(async () => [...store.keys()]),
  };
}

function stubProviders(): ProviderRegistry {
  return {
    audit: { log: vi.fn() },
    security: { scanInput: vi.fn().mockResolvedValue({ verdict: 'PASS' }) },
    storage: { documents: createInMemoryDocuments() },
  } as any;
}

describe('Governance IPC handlers', () => {
  let ctx: IPCContext;
  let registry: AgentRegistry;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ax-gov-test-'));
    proposalsDirPath = join(tmpDir, 'proposals');

    registry = await createSqliteRegistry(join(tmpDir, 'registry.db'));
    await registry.register({
      id: 'test-agent',
      name: 'test-agent',
      status: 'active',
      parentId: null,
      agentType: 'pi-coding-agent',
      capabilities: [],
      createdBy: 'system',
      admins: ['alice'],
    });

    const documents = createInMemoryDocuments();
    adminCtx = { registry, documents, agentId: 'test-agent' };
    ctx = { sessionId: 'sess-1', agentId: 'main', userId: 'alice' };
  });

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  test('identity_propose creates a pending proposal', async () => {
    const providers = stubProviders();
    const handlers = createGovernanceHandlers(providers, {
      adminCtx,
      agentId: 'test-agent',
      profile: 'balanced',
      registry,
    });

    const result = await handlers.identity_propose(
      { file: 'SOUL.md', content: 'I am a helpful agent', reason: 'initial soul', origin: 'user_request' },
      ctx,
    );

    expect(result.status).toBe('pending');
    expect(result.proposalId).toBeTruthy();

    // Verify file was saved
    const filePath = join(proposalsDirPath, `${result.proposalId}.json`);
    expect(existsSync(filePath)).toBe(true);
    const saved = JSON.parse(readFileSync(filePath, 'utf-8'));
    expect(saved.content).toBe('I am a helpful agent');
    expect(saved.status).toBe('pending');
  });

  test('identity_propose blocks content flagged by scanner', async () => {
    const providers = stubProviders();
    (providers.security.scanInput as any).mockResolvedValue({ verdict: 'BLOCK', reason: 'malicious' });
    const handlers = createGovernanceHandlers(providers, {
      adminCtx,
      agentId: 'test-agent',
      profile: 'balanced',
      registry,
    });

    const result = await handlers.identity_propose(
      { file: 'SOUL.md', content: 'bad content', reason: 'test', origin: 'agent_initiated' },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain('blocked');
  });

  test('proposal_list returns all proposals', async () => {
    const providers = stubProviders();
    const handlers = createGovernanceHandlers(providers, {
      adminCtx,
      agentId: 'test-agent',
      profile: 'balanced',
      registry,
    });

    await handlers.identity_propose(
      { file: 'SOUL.md', content: 'v1', reason: 'first', origin: 'user_request' },
      ctx,
    );
    await handlers.identity_propose(
      { file: 'IDENTITY.md', content: 'v2', reason: 'second', origin: 'user_request' },
      ctx,
    );

    const result = await handlers.proposal_list({});
    expect(result.proposals).toHaveLength(2);
  });

  test('proposal_list filters by status', async () => {
    const providers = stubProviders();
    const handlers = createGovernanceHandlers(providers, {
      adminCtx,
      agentId: 'test-agent',
      profile: 'balanced',
      registry,
    });

    const { proposalId } = await handlers.identity_propose(
      { file: 'SOUL.md', content: 'v1', reason: 'test', origin: 'user_request' },
      ctx,
    );

    // Approve it
    await handlers.proposal_review({ proposalId, decision: 'approved' }, ctx);

    const pending = await handlers.proposal_list({ status: 'pending' });
    expect(pending.proposals).toHaveLength(0);

    const approved = await handlers.proposal_list({ status: 'approved' });
    expect(approved.proposals).toHaveLength(1);
  });

  test('proposal_review approves and applies identity change', async () => {
    const providers = stubProviders();
    const handlers = createGovernanceHandlers(providers, {
      adminCtx,
      agentId: 'test-agent',
      profile: 'balanced',
      registry,
    });

    const { proposalId } = await handlers.identity_propose(
      { file: 'SOUL.md', content: 'I am a soul', reason: 'test', origin: 'user_request' },
      ctx,
    );

    const result = await handlers.proposal_review(
      { proposalId, decision: 'approved', reason: 'looks good' },
      ctx,
    );

    expect(result.reviewed).toBe(true);
    expect(result.decision).toBe('approved');

    // Verify SOUL.md was written to DocumentStore
    const soulContent = await providers.storage.documents.get('identity', 'test-agent/SOUL.md');
    expect(soulContent).toBe('I am a soul');
  });

  test('proposal_review rejects a proposal without applying', async () => {
    const providers = stubProviders();
    const handlers = createGovernanceHandlers(providers, {
      adminCtx,
      agentId: 'test-agent',
      profile: 'balanced',
      registry,
    });

    const { proposalId } = await handlers.identity_propose(
      { file: 'SOUL.md', content: 'bad soul', reason: 'test', origin: 'agent_initiated' },
      ctx,
    );

    const result = await handlers.proposal_review(
      { proposalId, decision: 'rejected', reason: 'not appropriate' },
      ctx,
    );

    expect(result.decision).toBe('rejected');
    // SOUL.md should NOT be in DocumentStore after rejection
    const soul = await providers.storage.documents.get('identity', 'test-agent/SOUL.md');
    expect(soul).toBeFalsy();
  });

  test('proposal_review returns error for unknown proposal', async () => {
    const providers = stubProviders();
    const handlers = createGovernanceHandlers(providers, {
      adminCtx,
      agentId: 'test-agent',
      profile: 'balanced',
      registry,
    });

    const result = await handlers.proposal_review(
      { proposalId: '00000000-0000-0000-0000-000000000000', decision: 'approved' },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain('not found');
  });

  test('agent_registry_list returns agents from registry', async () => {
    await registry.register({
      id: 'test-bot',
      name: 'Test Bot',
      status: 'active',
      parentId: null,
      agentType: 'pi-coding-agent',
      capabilities: ['general'],
      createdBy: 'test',
    });

    const providers = stubProviders();
    const handlers = createGovernanceHandlers(providers, {
      adminCtx,
      agentId: 'test-agent',
      profile: 'balanced',
      registry,
    });

    const result = await handlers.agent_registry_list({});
    // test-agent from beforeEach + test-bot registered above
    expect(result.agents).toHaveLength(2);
    expect(result.agents.map((a: any) => a.id)).toContain('test-bot');
  });

  test('agent_registry_get returns specific agent', async () => {
    await registry.register({
      id: 'specific-bot',
      name: 'Specific',
      status: 'active',
      parentId: null,
      agentType: 'pi-coding-agent',
      capabilities: [],
      createdBy: 'test',
    });

    const providers = stubProviders();
    const handlers = createGovernanceHandlers(providers, {
      adminCtx,
      agentId: 'test-agent',
      profile: 'balanced',
      registry,
    });

    const result = await handlers.agent_registry_get({ agentId: 'specific-bot' });
    expect(result.agent.name).toBe('Specific');
  });

  test('agent_registry_get returns error for unknown agent', async () => {
    const providers = stubProviders();
    const handlers = createGovernanceHandlers(providers, {
      adminCtx,
      agentId: 'test-agent',
      profile: 'balanced',
      registry,
    });

    const result = await handlers.agent_registry_get({ agentId: 'ghost' });
    expect(result.ok).toBe(false);
  });

  // ── Admin gate tests for proposal_review ──

  test('proposal_review rejects non-admin users', async () => {
    const providers = stubProviders();
    const handlers = createGovernanceHandlers(providers, {
      adminCtx,
      agentId: 'test-agent',
      profile: 'balanced',
      registry,
    });

    // Create a proposal as alice (admin)
    const { proposalId } = await handlers.identity_propose(
      { file: 'SOUL.md', content: 'test', reason: 'test', origin: 'user_request' },
      ctx,
    );

    // Try to review as eve (not admin)
    const nonAdminCtx: IPCContext = { sessionId: 'sess-2', agentId: 'main', userId: 'eve' };
    const result = await handlers.proposal_review(
      { proposalId, decision: 'approved', reason: 'looks good' },
      nonAdminCtx,
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Only admins');
  });

  test('proposal_review allows admin users', async () => {
    const providers = stubProviders();
    const handlers = createGovernanceHandlers(providers, {
      adminCtx,
      agentId: 'test-agent',
      profile: 'balanced',
      registry,
    });

    const { proposalId } = await handlers.identity_propose(
      { file: 'SOUL.md', content: 'admin soul', reason: 'test', origin: 'user_request' },
      ctx,
    );

    // alice is admin — should succeed
    const result = await handlers.proposal_review(
      { proposalId, decision: 'approved', reason: 'admin approves' },
      ctx,
    );

    expect(result.reviewed).toBe(true);
    expect(result.decision).toBe('approved');
  });

  test('proposal_review allows when no userId (system context)', async () => {
    const providers = stubProviders();
    const handlers = createGovernanceHandlers(providers, {
      adminCtx,
      agentId: 'test-agent',
      profile: 'balanced',
      registry,
    });

    const { proposalId } = await handlers.identity_propose(
      { file: 'SOUL.md', content: 'system soul', reason: 'test', origin: 'user_request' },
      ctx,
    );

    // System context (no userId) should bypass admin check
    const systemCtx: IPCContext = { sessionId: 'sess-sys', agentId: 'system' };
    const result = await handlers.proposal_review(
      { proposalId, decision: 'approved', reason: 'system approves' },
      systemCtx,
    );

    expect(result.reviewed).toBe(true);
  });
});
