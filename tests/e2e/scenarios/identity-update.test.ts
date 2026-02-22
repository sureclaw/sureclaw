/**
 * Scenario: Identity and soul updates
 *
 * Tests identity_write and user_write IPC actions, including
 * profile-based gating (balanced applies, paranoid queues).
 */

import { describe, test, expect, afterEach } from 'vitest';
import { TestHarness } from '../harness.js';
import { textTurn, toolUseTurn } from '../scripted-llm.js';

describe('E2E Scenario: Identity & Soul Updates', () => {
  let harness: TestHarness;

  afterEach(() => {
    harness?.dispose();
  });

  test('identity_write SOUL.md in balanced profile applies to filesystem', async () => {
    harness = await TestHarness.create({ profile: 'balanced' });

    const result = await harness.ipcCall('identity_write', {
      file: 'SOUL.md',
      content: '# My Soul\n\nI am a helpful assistant who loves puns.',
      reason: 'User wants personality update',
      origin: 'user_request',
    });

    expect(result.ok).toBe(true);
    expect(result.applied).toBe(true);

    // Verify file was written
    const content = harness.readIdentityFile('SOUL.md');
    expect(content).toBe('# My Soul\n\nI am a helpful assistant who loves puns.');
  });

  test('identity_write IDENTITY.md in balanced profile applies', async () => {
    harness = await TestHarness.create({ profile: 'balanced' });

    const result = await harness.ipcCall('identity_write', {
      file: 'IDENTITY.md',
      content: '# Identity\n\nName: TestBot\nRole: Assistant',
      reason: 'Setting up identity',
      origin: 'user_request',
    });

    expect(result.ok).toBe(true);
    expect(result.applied).toBe(true);

    const content = harness.readIdentityFile('IDENTITY.md');
    expect(content).toContain('TestBot');
  });

  test('identity_write in paranoid profile queues instead of applying', async () => {
    harness = await TestHarness.create({ profile: 'paranoid' });

    const result = await harness.ipcCall('identity_write', {
      file: 'SOUL.md',
      content: '# Changed Soul',
      reason: 'Agent wants to change',
      origin: 'agent_initiated',
    });

    expect(result.ok).toBe(true);
    expect(result.queued).toBe(true);

    // File should NOT exist on disk
    const content = harness.readIdentityFile('SOUL.md');
    expect(content).toBeNull();
  });

  test('identity_write is audited with the correct decision', async () => {
    harness = await TestHarness.create({ profile: 'balanced' });

    await harness.ipcCall('identity_write', {
      file: 'SOUL.md',
      content: '# Audited Soul',
      reason: 'Testing audit trail',
      origin: 'user_request',
    });

    const auditEntries = harness.auditEntriesFor('identity_write');
    expect(auditEntries.length).toBeGreaterThan(0);
    expect(auditEntries.some(e => e.args?.decision === 'applied')).toBe(true);
  });

  test('user_write stores per-user notes', async () => {
    harness = await TestHarness.create({ profile: 'balanced' });

    const result = await harness.ipcCall('user_write', {
      userId: 'alice',
      content: '# Alice\n\nPrefers dark mode. Works on Project X.',
      reason: 'Learned user preferences',
      origin: 'user_request',
    });

    expect(result.ok).toBe(true);
    expect(harness.wasAudited('user_write')).toBe(true);
  });

  test('multi-turn: LLM updates soul via tool_use', async () => {
    harness = await TestHarness.create({
      profile: 'balanced',
      llmTurns: [
        // Turn 1: LLM decides to update its soul
        toolUseTurn('identity_write', {
          file: 'SOUL.md',
          content: '# Soul\n\nI am curious, thoughtful, and slightly sarcastic.',
          reason: 'User asked me to be more sarcastic',
          origin: 'user_request',
        }),
        // Turn 2: Confirm to user
        textTurn('Done! I\'ve updated my personality to be a bit more sarcastic.'),
      ],
    });

    const result = await harness.runAgentLoop('Can you be a bit more sarcastic?');

    expect(result.finalText).toContain('sarcastic');
    expect(result.toolCalls.length).toBe(1);
    expect(result.toolCalls[0]!.name).toBe('identity_write');

    // File should be written
    const soul = harness.readIdentityFile('SOUL.md');
    expect(soul).toContain('sarcastic');
  });

  test('identity_write rejects invalid file names', async () => {
    harness = await TestHarness.create({ profile: 'balanced' });

    const result = await harness.ipcCall('identity_write', {
      file: 'EVIL.md',  // Not SOUL.md or IDENTITY.md
      content: 'hacked',
      reason: 'attack',
      origin: 'user_request',
    });

    // Should fail validation (only SOUL.md and IDENTITY.md are allowed)
    expect(result.ok).toBe(false);
  });
});
