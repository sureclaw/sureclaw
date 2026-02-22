/**
 * Scenario: Autonomous skill creation
 *
 * Tests the skill_propose / skill_read / skill_list IPC flow,
 * including auto-approve, needs-review, and reject verdicts.
 */

import { describe, test, expect, afterEach } from 'vitest';
import { TestHarness } from '../harness.js';
import { textTurn, toolUseTurn } from '../scripted-llm.js';

describe('E2E Scenario: Skill Creation', () => {
  let harness: TestHarness;

  afterEach(() => {
    harness?.dispose();
  });

  test('skill_propose via IPC auto-approves a safe skill', async () => {
    harness = await TestHarness.create();

    const result = await harness.ipcCall('skill_propose', {
      skill: 'greeting',
      content: '# Greeting Skill\n\nGreet users warmly.',
      reason: 'Learned a greeting pattern',
    });

    expect(result.ok).toBe(true);
    // skill_propose handler returns ProposalResult directly (id, verdict, reason)
    expect(result.verdict).toBe('AUTO_APPROVE');

    // Skill should be in the store now
    expect(harness.skillStore.has('greeting')).toBe(true);
    expect(harness.skillStore.get('greeting')).toContain('Greeting Skill');
  });

  test('skill_list returns all stored skills', async () => {
    harness = await TestHarness.create({
      seedSkills: [
        { name: 'skill-a', content: '# Skill A' },
        { name: 'skill-b', content: '# Skill B' },
      ],
    });

    const result = await harness.ipcCall('skill_list', {});

    expect(result.ok).toBe(true);
    expect(result.skills.length).toBe(2);
    expect(result.skills.map((s: any) => s.name).sort()).toEqual(['skill-a', 'skill-b']);
  });

  test('skill_read returns skill content', async () => {
    harness = await TestHarness.create({
      seedSkills: [
        { name: 'my-skill', content: '# My Skill\n\nDo the thing.' },
      ],
    });

    const result = await harness.ipcCall('skill_read', { name: 'my-skill' });

    expect(result.ok).toBe(true);
    expect(result.content).toContain('My Skill');
    expect(result.content).toContain('Do the thing');
  });

  test('skill_propose with NEEDS_REVIEW verdict does not auto-store', async () => {
    harness = await TestHarness.create({
      skillProposalVerdict: {
        id: 'review-001',
        verdict: 'NEEDS_REVIEW',
        reason: 'Uses env-access pattern',
      },
    });

    const result = await harness.ipcCall('skill_propose', {
      skill: 'env-reader',
      content: '# Env Reader\n\nReads from process.env.',
      reason: 'Need environment config',
    });

    expect(result.ok).toBe(true);
    expect(result.verdict).toBe('NEEDS_REVIEW');

    // Skill should NOT be in the store (needs review first)
    expect(harness.skillStore.has('env-reader')).toBe(false);
  });

  test('skill_propose with REJECT verdict does not store', async () => {
    harness = await TestHarness.create({
      skillProposalVerdict: {
        id: 'reject-001',
        verdict: 'REJECT',
        reason: 'Contains eval()',
      },
    });

    const result = await harness.ipcCall('skill_propose', {
      skill: 'evil-skill',
      content: '# Evil\n\nRun eval("bad")',
    });

    expect(result.ok).toBe(true);
    expect(result.verdict).toBe('REJECT');
    expect(harness.skillStore.has('evil-skill')).toBe(false);
  });

  test('multi-turn agent loop: LLM proposes a skill via tool_use', async () => {
    harness = await TestHarness.create({
      llmTurns: [
        // Turn 1: LLM decides to propose a skill
        toolUseTurn('skill_propose', {
          skill: 'summarizer',
          content: '# Summarizer\n\nSummarize long texts into bullet points.',
          reason: 'User frequently asks for summaries',
        }),
        // Turn 2: After tool result, LLM responds with text
        textTurn('I\'ve created a new "summarizer" skill for you.'),
      ],
    });

    const result = await harness.runAgentLoop('I keep asking you to summarize things. Can you learn to do that?');

    expect(result.finalText).toContain('summarizer');
    expect(result.toolCalls.length).toBe(1);
    expect(result.toolCalls[0]!.name).toBe('skill_propose');
    expect(harness.skillStore.has('summarizer')).toBe(true);
  });

  test('skill proposal is recorded in skill log', async () => {
    harness = await TestHarness.create();

    await harness.ipcCall('skill_propose', {
      skill: 'logged-skill',
      content: '# Logged\n\nThis is logged.',
      reason: 'Testing log',
    });

    expect(harness.skillLog.length).toBe(1);
    expect(harness.skillLog[0]!.skill).toBe('logged-skill');
    expect(harness.skillLog[0]!.action).toBe('propose');
  });
});
