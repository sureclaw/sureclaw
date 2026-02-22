/**
 * Scenario: Agent delegation with depth and concurrency limits
 *
 * Tests the agent_delegate IPC action, which allows an agent to spawn
 * sub-agent tasks. The delegation handler enforces:
 *   - maxConcurrent (default 3): simultaneous delegations
 *   - maxDepth (default 2): chain depth via :depth= suffix in agentId
 *
 * Response shapes:
 *   agent_delegate → { ok, response } on success
 *   agent_delegate → { ok: false, error } when limits exceeded or not configured
 */

import { describe, test, expect, afterEach } from 'vitest';
import { TestHarness } from '../harness.js';
import { textTurn, toolUseTurn } from '../scripted-llm.js';

describe('E2E Scenario: Agent Delegation', () => {
  let harness: TestHarness;

  afterEach(() => {
    harness?.dispose();
  });

  test('agent_delegate succeeds with configured handler', async () => {
    harness = await TestHarness.create({
      onDelegate: async (task, context) => {
        return `Completed task: ${task}`;
      },
    });

    const result = await harness.ipcCall('agent_delegate', {
      task: 'Summarize this document',
      context: 'Document about TypeScript patterns.',
    });

    expect(result.ok).toBe(true);
    expect(result.response).toBe('Completed task: Summarize this document');
  });

  test('agent_delegate without handler returns error', async () => {
    harness = await TestHarness.create();

    const result = await harness.ipcCall('agent_delegate', {
      task: 'Any task',
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('not configured');
  });

  test('agent_delegate is audited', async () => {
    harness = await TestHarness.create({
      onDelegate: async (task) => `Done: ${task}`,
    });

    await harness.ipcCall('agent_delegate', {
      task: 'Audit test task',
    });

    expect(harness.wasAudited('agent_delegate')).toBe(true);
  });

  test('agent_delegate passes context to handler', async () => {
    let receivedContext: string | undefined;

    harness = await TestHarness.create({
      onDelegate: async (task, context) => {
        receivedContext = context;
        return 'Done';
      },
    });

    await harness.ipcCall('agent_delegate', {
      task: 'Research topic',
      context: 'Focus on security aspects.',
    });

    expect(receivedContext).toBe('Focus on security aspects.');
  });

  test('agent_delegate respects max depth limit', async () => {
    harness = await TestHarness.create({
      delegation: { maxDepth: 2 },
      onDelegate: async (task) => `Done: ${task}`,
    });

    // Simulate a call at depth=2 (already at max)
    const result = await harness.ipcCall(
      'agent_delegate',
      { task: 'Too deep' },
      { sessionId: 'test-session', agentId: 'agent-1:depth=2' },
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain('depth');
  });

  test('agent_delegate within depth limit succeeds', async () => {
    harness = await TestHarness.create({
      delegation: { maxDepth: 3 },
      onDelegate: async (task) => `Done: ${task}`,
    });

    // Simulate a call at depth=1 (within limit of 3)
    const result = await harness.ipcCall(
      'agent_delegate',
      { task: 'Within limit' },
      { sessionId: 'test-session', agentId: 'agent-1:depth=1' },
    );

    expect(result.ok).toBe(true);
    expect(result.response).toBe('Done: Within limit');
  });

  test('agent_delegate respects max concurrency limit', async () => {
    let resolveFirst: () => void;
    const firstDelegation = new Promise<void>(resolve => { resolveFirst = resolve; });

    harness = await TestHarness.create({
      delegation: { maxConcurrent: 1 },
      onDelegate: async (task) => {
        if (task === 'blocking') {
          await firstDelegation;
        }
        return `Done: ${task}`;
      },
    });

    // Start first delegation (will block)
    const first = harness.ipcCall('agent_delegate', { task: 'blocking' });

    // Try second delegation immediately — should fail because maxConcurrent=1
    // Give a tick for the first call to register
    await new Promise(r => setTimeout(r, 10));
    const second = await harness.ipcCall('agent_delegate', { task: 'second' });

    expect(second.ok).toBe(false);
    expect(second.error).toContain('concurrent');

    // Unblock first
    resolveFirst!();
    const firstResult = await first;
    expect(firstResult.ok).toBe(true);
  });

  test('multi-turn: LLM delegates a task via tool_use', async () => {
    harness = await TestHarness.create({
      onDelegate: async (task) => {
        return 'The document discusses three main patterns: Factory, Observer, and Strategy.';
      },
      llmTurns: [
        // Turn 1: LLM decides to delegate
        toolUseTurn('agent_delegate', {
          task: 'Analyze the design patterns document',
          context: 'User wants a summary of patterns used.',
        }),
        // Turn 2: LLM synthesizes the delegated result
        textTurn('Based on the analysis, the document covers Factory, Observer, and Strategy patterns.'),
      ],
    });

    const result = await harness.runAgentLoop('What patterns are in the design doc?');

    expect(result.toolCalls.length).toBe(1);
    expect(result.toolCalls[0]!.name).toBe('agent_delegate');
    expect(result.toolCalls[0]!.result.response).toContain('Factory');
    expect(result.finalText).toContain('Factory');
  });

  test('delegation handler receives correct child context', async () => {
    let receivedCtx: any;

    harness = await TestHarness.create({
      onDelegate: async (task, context, ctx) => {
        receivedCtx = ctx;
        return 'Done';
      },
    });

    await harness.ipcCall(
      'agent_delegate',
      { task: 'Check context' },
      { sessionId: 'session-abc', agentId: 'parent-agent' },
    );

    // The delegation handler creates a child context with incremented depth
    expect(receivedCtx.agentId).toContain('delegate-');
    expect(receivedCtx.agentId).toContain('depth=1');
    expect(receivedCtx.sessionId).toBe('session-abc');
  });
});
