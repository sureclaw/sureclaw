/**
 * Scenario: Enterprise governance — proposals and agent registry
 *
 * Tests the governance flow:
 *   identity_propose → proposal_list → proposal_review
 * Plus the agent registry:
 *   agent_registry_list, agent_registry_get
 *
 * Response shapes:
 *   identity_propose     → { ok, proposalId, status: 'pending' }
 *   proposal_list        → { ok, proposals: [...] }
 *   proposal_review      → { ok, reviewed: true, proposalId, decision }
 *   agent_registry_list  → { ok, agents: [...] }
 *   agent_registry_get   → { ok, agent: {...} }
 */

import { describe, test, expect, afterEach } from 'vitest';
import { TestHarness } from '../harness.js';
import { textTurn, toolUseTurn } from '../scripted-llm.js';

describe('E2E Scenario: Governance & Proposals', () => {
  let harness: TestHarness;

  afterEach(() => {
    harness?.dispose();
  });

  // ─── Identity Proposals ──────────────────────────

  test('identity_propose creates a pending proposal', async () => {
    harness = await TestHarness.create();

    const result = await harness.ipcCall('identity_propose', {
      file: 'SOUL.md',
      content: '# Soul\n\nI am a helpful agent.',
      reason: 'Initial soul draft',
      origin: 'agent_initiated',
    });

    expect(result.ok).toBe(true);
    expect(result.proposalId).toBeDefined();
    expect(result.status).toBe('pending');
  });

  test('identity_propose is audited', async () => {
    harness = await TestHarness.create();

    await harness.ipcCall('identity_propose', {
      file: 'SOUL.md',
      content: '# Soul',
      reason: 'Test audit',
      origin: 'agent_initiated',
    });

    expect(harness.wasAudited('identity_propose')).toBe(true);
  });

  test('identity_propose blocked by scanner returns error', async () => {
    harness = await TestHarness.create({ scannerInputVerdict: 'BLOCK' });

    const result = await harness.ipcCall('identity_propose', {
      file: 'SOUL.md',
      content: 'Dangerous identity content',
      reason: 'Should be blocked',
      origin: 'agent_initiated',
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('blocked');
  });

  // ─── Proposal List ───────────────────────────────

  test('proposal_list returns empty when no proposals exist', async () => {
    harness = await TestHarness.create();

    const result = await harness.ipcCall('proposal_list', {});

    expect(result.ok).toBe(true);
    expect(result.proposals).toEqual([]);
  });

  test('proposal_list returns created proposals', async () => {
    harness = await TestHarness.create();

    await harness.ipcCall('identity_propose', {
      file: 'SOUL.md',
      content: '# Soul v1',
      reason: 'First draft',
      origin: 'agent_initiated',
    });
    await harness.ipcCall('identity_propose', {
      file: 'IDENTITY.md',
      content: '# Identity v1',
      reason: 'Identity draft',
      origin: 'agent_initiated',
    });

    const result = await harness.ipcCall('proposal_list', {});

    expect(result.ok).toBe(true);
    expect(result.proposals.length).toBe(2);
    expect(result.proposals.every((p: any) => p.status === 'pending')).toBe(true);
  });

  test('proposal_list filters by status', async () => {
    harness = await TestHarness.create();

    // Create two proposals
    const p1 = await harness.ipcCall('identity_propose', {
      file: 'SOUL.md',
      content: '# Soul',
      reason: 'Draft',
      origin: 'agent_initiated',
    });
    await harness.ipcCall('identity_propose', {
      file: 'IDENTITY.md',
      content: '# Identity',
      reason: 'Draft',
      origin: 'agent_initiated',
    });

    // Approve one
    await harness.ipcCall('proposal_review', {
      proposalId: p1.proposalId,
      decision: 'approved',
      reason: 'Looks good',
    });

    // Filter by pending
    const pending = await harness.ipcCall('proposal_list', { status: 'pending' });
    expect(pending.proposals.length).toBe(1);

    // Filter by approved
    const approved = await harness.ipcCall('proposal_list', { status: 'approved' });
    expect(approved.proposals.length).toBe(1);
  });

  // ─── Proposal Review ─────────────────────────────

  test('proposal_review approves a proposal and applies identity file', async () => {
    harness = await TestHarness.create();

    const propResult = await harness.ipcCall('identity_propose', {
      file: 'SOUL.md',
      content: '# My Soul\n\nI am thoughtful and careful.',
      reason: 'Soul evolution',
      origin: 'agent_initiated',
    });

    const reviewResult = await harness.ipcCall('proposal_review', {
      proposalId: propResult.proposalId,
      decision: 'approved',
      reason: 'Approved by admin',
    });

    expect(reviewResult.ok).toBe(true);
    expect(reviewResult.reviewed).toBe(true);
    expect(reviewResult.decision).toBe('approved');

    // Identity file should be written
    const soulContent = harness.readIdentityFile('SOUL.md');
    expect(soulContent).toContain('thoughtful and careful');
  });

  test('proposal_review rejects a proposal without applying', async () => {
    harness = await TestHarness.create();

    const propResult = await harness.ipcCall('identity_propose', {
      file: 'SOUL.md',
      content: '# Bad Soul',
      reason: 'Suspicious change',
      origin: 'agent_initiated',
    });

    const reviewResult = await harness.ipcCall('proposal_review', {
      proposalId: propResult.proposalId,
      decision: 'rejected',
      reason: 'Content inappropriate',
    });

    expect(reviewResult.ok).toBe(true);
    expect(reviewResult.decision).toBe('rejected');

    // Identity file should NOT be written
    const soulContent = harness.readIdentityFile('SOUL.md');
    expect(soulContent).toBeNull();
  });

  test('proposal_review for nonexistent proposal returns error', async () => {
    harness = await TestHarness.create();

    // proposalId must be a valid UUID (Zod schema enforces this)
    const result = await harness.ipcCall('proposal_review', {
      proposalId: '00000000-0000-0000-0000-000000000000',
      decision: 'approved',
      reason: 'Does not exist',
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('not found');
  });

  test('proposal_review for already-reviewed proposal returns error', async () => {
    harness = await TestHarness.create();

    const propResult = await harness.ipcCall('identity_propose', {
      file: 'SOUL.md',
      content: '# Soul',
      reason: 'Draft',
      origin: 'agent_initiated',
    });

    // Approve it
    await harness.ipcCall('proposal_review', {
      proposalId: propResult.proposalId,
      decision: 'approved',
      reason: 'First review',
    });

    // Try to review again
    const secondReview = await harness.ipcCall('proposal_review', {
      proposalId: propResult.proposalId,
      decision: 'rejected',
      reason: 'Second review attempt',
    });

    expect(secondReview.ok).toBe(false);
    expect(secondReview.error).toContain('already');
  });

  test('proposal_review is audited', async () => {
    harness = await TestHarness.create();

    const propResult = await harness.ipcCall('identity_propose', {
      file: 'SOUL.md',
      content: '# Soul',
      reason: 'Audit test',
      origin: 'agent_initiated',
    });

    await harness.ipcCall('proposal_review', {
      proposalId: propResult.proposalId,
      decision: 'approved',
      reason: 'Approved',
    });

    expect(harness.wasAudited('proposal_review')).toBe(true);
  });

  // ─── Agent Registry ───────────────────────────────

  test('agent_registry_list returns empty when no agents registered', async () => {
    harness = await TestHarness.create();

    const result = await harness.ipcCall('agent_registry_list', {});

    expect(result.ok).toBe(true);
    expect(result.agents).toEqual([]);
  });

  test('agent_registry_list returns seeded agents', async () => {
    harness = await TestHarness.create({
      seedAgents: [
        {
          id: 'research-agent',
          name: 'Research Agent',
          description: 'Handles research tasks',
          status: 'active',
          parentId: null,
          agentType: 'pi-agent-core',
          capabilities: ['research', 'web'],
          createdBy: 'system',
        },
        {
          id: 'coding-agent',
          name: 'Coding Agent',
          description: 'Handles coding tasks',
          status: 'active',
          parentId: null,
          agentType: 'pi-coding-agent',
          capabilities: ['coding', 'git'],
          createdBy: 'system',
        },
      ],
    });

    const result = await harness.ipcCall('agent_registry_list', {});

    expect(result.ok).toBe(true);
    expect(result.agents.length).toBe(2);
  });

  test('agent_registry_list filters by status', async () => {
    harness = await TestHarness.create({
      seedAgents: [
        {
          id: 'active-agent',
          name: 'Active',
          status: 'active',
          parentId: null,
          agentType: 'pi-agent-core',
          capabilities: [],
          createdBy: 'system',
        },
        {
          id: 'suspended-agent',
          name: 'Suspended',
          status: 'suspended',
          parentId: null,
          agentType: 'pi-agent-core',
          capabilities: [],
          createdBy: 'system',
        },
      ],
    });

    const result = await harness.ipcCall('agent_registry_list', {
      status: 'active',
    });

    expect(result.ok).toBe(true);
    expect(result.agents.length).toBe(1);
    expect(result.agents[0].id).toBe('active-agent');
  });

  test('agent_registry_get returns agent details', async () => {
    harness = await TestHarness.create({
      seedAgents: [
        {
          id: 'my-agent',
          name: 'My Agent',
          description: 'Does things',
          status: 'active',
          parentId: null,
          agentType: 'pi-agent-core',
          capabilities: ['general', 'memory'],
          createdBy: 'admin',
        },
      ],
    });

    const result = await harness.ipcCall('agent_registry_get', {
      agentId: 'my-agent',
    });

    expect(result.ok).toBe(true);
    expect(result.agent.name).toBe('My Agent');
    expect(result.agent.capabilities).toContain('general');
    expect(result.agent.createdBy).toBe('admin');
  });

  test('agent_registry_get for nonexistent agent returns error', async () => {
    harness = await TestHarness.create();

    const result = await harness.ipcCall('agent_registry_get', {
      agentId: 'ghost-agent',
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('not found');
  });

  // ─── Full Governance Flow ─────────────────────────

  test('full flow: propose → list → review → verify applied', async () => {
    harness = await TestHarness.create();

    // Step 1: Propose
    const propResult = await harness.ipcCall('identity_propose', {
      file: 'IDENTITY.md',
      content: '# Identity\n\nName: Research Assistant\nRole: Information gatherer',
      reason: 'Establishing agent identity',
      origin: 'agent_initiated',
    });
    expect(propResult.proposalId).toBeDefined();

    // Step 2: List pending
    const listResult = await harness.ipcCall('proposal_list', { status: 'pending' });
    expect(listResult.proposals.length).toBe(1);
    expect(listResult.proposals[0].type).toBe('identity');

    // Step 3: Review (approve)
    const reviewResult = await harness.ipcCall('proposal_review', {
      proposalId: propResult.proposalId,
      decision: 'approved',
      reason: 'Identity looks correct',
    });
    expect(reviewResult.reviewed).toBe(true);

    // Step 4: Verify applied
    const identity = harness.readIdentityFile('IDENTITY.md');
    expect(identity).toContain('Research Assistant');

    // Step 5: List should now show approved
    const listAfter = await harness.ipcCall('proposal_list', { status: 'pending' });
    expect(listAfter.proposals.length).toBe(0);
  });

  test('multi-turn: LLM proposes identity via tool_use', async () => {
    harness = await TestHarness.create({
      llmTurns: [
        toolUseTurn('identity_propose', {
          file: 'SOUL.md',
          content: '# Soul\n\nI value clarity and precision.',
          reason: 'Evolving my sense of self',
          origin: 'agent_initiated',
        }),
        textTurn('I\'ve proposed updates to my soul document for review.'),
      ],
    });

    const result = await harness.runAgentLoop('Reflect on your identity and propose updates.');

    expect(result.toolCalls.length).toBe(1);
    expect(result.toolCalls[0]!.name).toBe('identity_propose');
    expect(result.finalText).toContain('soul');
  });
});
