import { describe, test, expect } from 'vitest';
import {
  IdentityProposeSchema,
  ProposalListSchema,
  ProposalReviewSchema,
  AgentRegistryListSchema,
  AgentRegistryGetSchema,
  IPC_SCHEMAS,
} from '../src/ipc-schemas.js';

describe('Enterprise IPC Schemas', () => {

  // ── Governance schemas ──

  test('IdentityProposeSchema accepts valid input', () => {
    const result = IdentityProposeSchema.safeParse({
      action: 'identity_propose',
      file: 'SOUL.md',
      content: 'I am a helpful agent',
      reason: 'initial setup',
      origin: 'user_request',
    });
    expect(result.success).toBe(true);
  });

  test('IdentityProposeSchema rejects invalid file', () => {
    const result = IdentityProposeSchema.safeParse({
      action: 'identity_propose',
      file: 'EVIL.md',
      content: 'bad',
      reason: 'test',
      origin: 'user_request',
    });
    expect(result.success).toBe(false);
  });

  test('ProposalListSchema accepts empty input', () => {
    const result = ProposalListSchema.safeParse({
      action: 'proposal_list',
    });
    expect(result.success).toBe(true);
  });

  test('ProposalListSchema accepts status filter', () => {
    const result = ProposalListSchema.safeParse({
      action: 'proposal_list',
      status: 'pending',
    });
    expect(result.success).toBe(true);
  });

  test('ProposalReviewSchema accepts valid decision', () => {
    const result = ProposalReviewSchema.safeParse({
      action: 'proposal_review',
      proposalId: '12345678-1234-1234-1234-123456789abc',
      decision: 'approved',
      reason: 'looks good',
    });
    expect(result.success).toBe(true);
  });

  test('ProposalReviewSchema rejects invalid decision', () => {
    const result = ProposalReviewSchema.safeParse({
      action: 'proposal_review',
      proposalId: '12345678-1234-1234-1234-123456789abc',
      decision: 'maybe',
    });
    expect(result.success).toBe(false);
  });

  // ── Agent Registry schemas ──

  test('AgentRegistryListSchema accepts empty input', () => {
    const result = AgentRegistryListSchema.safeParse({
      action: 'agent_registry_list',
    });
    expect(result.success).toBe(true);
  });

  test('AgentRegistryListSchema accepts status filter', () => {
    const result = AgentRegistryListSchema.safeParse({
      action: 'agent_registry_list',
      status: 'active',
    });
    expect(result.success).toBe(true);
  });

  test('AgentRegistryGetSchema requires agentId', () => {
    const result = AgentRegistryGetSchema.safeParse({
      action: 'agent_registry_get',
      agentId: 'my-bot',
    });
    expect(result.success).toBe(true);
  });


  // ── Registry integration ──

  test('all enterprise actions are registered in IPC_SCHEMAS', () => {
    const enterpriseActions = [
      'save_artifact',
      'identity_propose', 'proposal_list', 'proposal_review',
      'agent_registry_list', 'agent_registry_get',
    ];
    for (const action of enterpriseActions) {
      expect(IPC_SCHEMAS[action]).toBeDefined();
    }
  });

});
