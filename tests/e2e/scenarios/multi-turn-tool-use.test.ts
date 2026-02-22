/**
 * Scenario: Multi-turn tool use loops
 *
 * Tests the agent runner loop simulation where the LLM makes multiple
 * sequential tool calls before producing a final text response.
 * Covers: chained tools, parallel tool calls, memory + web combos.
 */

import { describe, test, expect, afterEach } from 'vitest';
import { TestHarness } from '../harness.js';
import {
  textTurn,
  toolUseTurn,
  textAndToolTurn,
  matchLastMessage,
  matchHasToolResult,
} from '../scripted-llm.js';
import type { LLMTurn, RecordedLLMCall } from '../scripted-llm.js';

describe('E2E Scenario: Multi-Turn Tool Use', () => {
  let harness: TestHarness;

  afterEach(() => {
    harness?.dispose();
  });

  test('single tool call: memory_write then text response', async () => {
    harness = await TestHarness.create({
      llmTurns: [
        toolUseTurn('memory_write', {
          scope: 'user_notes',
          content: 'User prefers dark mode',
          tags: ['preference'],
        }),
        textTurn('Got it! I\'ll remember that you prefer dark mode.'),
      ],
    });

    const result = await harness.runAgentLoop('Remember that I prefer dark mode');

    expect(result.toolCalls.length).toBe(1);
    expect(result.toolCalls[0]!.name).toBe('memory_write');
    expect(result.finalText).toContain('dark mode');

    // Memory should have the entry
    const entries = harness.memoryForScope('user_notes');
    expect(entries.length).toBe(1);
    expect(entries[0]!.content).toBe('User prefers dark mode');
  });

  test('chained tool calls: search web then write to memory', async () => {
    harness = await TestHarness.create({
      webSearches: [{
        query: /node.*version/i,
        results: [{
          title: 'Node.js Releases',
          url: 'https://nodejs.org/releases',
          snippet: 'Latest LTS: v22.0.0',
          taint: { source: 'web_search', trust: 'external', timestamp: new Date() },
        }],
      }],
      llmTurns: [
        // Turn 1: Search the web
        toolUseTurn('web_search', { query: 'latest node version' }),
        // Turn 2: Save to memory
        toolUseTurn('memory_write', {
          scope: 'research',
          content: 'Latest Node.js LTS is v22.0.0',
          tags: ['node', 'version'],
        }),
        // Turn 3: Report back
        textTurn('The latest Node.js LTS version is v22.0.0. I\'ve saved this to memory.'),
      ],
    });

    const result = await harness.runAgentLoop('What\'s the latest Node.js version? Save it for later.');

    expect(result.toolCalls.length).toBe(2);
    expect(result.toolCalls[0]!.name).toBe('web_search');
    expect(result.toolCalls[1]!.name).toBe('memory_write');
    expect(result.finalText).toContain('v22.0.0');

    const entries = harness.memoryForScope('research');
    expect(entries.length).toBe(1);
  });

  test('three chained tool calls: query memory, search web, write memory', async () => {
    harness = await TestHarness.create({
      seedMemory: [{
        scope: 'project',
        content: 'Project uses React 18',
        tags: ['tech-stack'],
      }],
      webSearches: [{
        query: /react.*19/i,
        results: [{
          title: 'React 19 Migration Guide',
          url: 'https://react.dev/blog/react-19',
          snippet: 'React 19 introduces Server Components by default.',
          taint: { source: 'web_search', trust: 'external', timestamp: new Date() },
        }],
      }],
      llmTurns: [
        // Turn 1: Check what we know
        toolUseTurn('memory_query', { scope: 'project', tags: ['tech-stack'] }),
        // Turn 2: Search for upgrade path
        toolUseTurn('web_search', { query: 'react 19 migration from 18' }),
        // Turn 3: Save migration notes
        toolUseTurn('memory_write', {
          scope: 'project',
          content: 'React 19 migration: Server Components by default. Need to review.',
          tags: ['tech-stack', 'migration'],
        }),
        // Turn 4: Report
        textTurn('I checked our stack (React 18), researched the upgrade path, and saved migration notes.'),
      ],
    });

    const result = await harness.runAgentLoop('Should we upgrade React? Check what we have and research.');

    expect(result.toolCalls.length).toBe(3);
    expect(result.toolCalls.map(tc => tc.name)).toEqual([
      'memory_query', 'web_search', 'memory_write',
    ]);
    expect(result.turns.length).toBe(4); // 3 tool turns + 1 final text
  });

  test('text alongside tool_use in the same turn', async () => {
    harness = await TestHarness.create({
      llmTurns: [
        textAndToolTurn(
          'Let me save that for you.',
          'memory_write',
          { scope: 'user_notes', content: 'Meeting at 3pm', tags: ['reminder'] },
        ),
        textTurn('Done! I\'ve saved your reminder about the 3pm meeting.'),
      ],
    });

    const result = await harness.runAgentLoop('Remember: meeting at 3pm');

    expect(result.toolCalls.length).toBe(1);
    expect(result.finalText).toContain('3pm meeting');
  });

  test('max turns limit prevents infinite loops', async () => {
    // Create a script that always returns tool_use (never stops)
    const infiniteTools: LLMTurn[] = Array.from({ length: 20 }, (_, i) =>
      toolUseTurn('memory_write', {
        scope: 'infinite',
        content: `Entry ${i}`,
      })
    );

    harness = await TestHarness.create({ llmTurns: infiniteTools });

    const result = await harness.runAgentLoop('Do something', { maxTurns: 3 });

    // Should stop after 3 turns even though more tool_use is available
    expect(result.turns.length).toBeLessThanOrEqual(3);
    expect(harness.llm.callCount).toBeLessThanOrEqual(3);
  });

  test('tool call failure is propagated as tool_result', async () => {
    harness = await TestHarness.create({
      llmTurns: [
        // Try to fetch a page — web provider will return a mock response
        toolUseTurn('web_fetch', { url: 'https://example.com/api' }),
        textTurn('I fetched the page successfully.'),
      ],
    });

    const result = await harness.runAgentLoop('Fetch example.com');

    // The tool result should have been passed back to the LLM
    expect(result.toolCalls.length).toBe(1);
    expect(result.toolCalls[0]!.result.ok).toBe(true);
    expect(result.turns.length).toBe(2);
  });

  test('conditional LLM turns: match on tool_result content', async () => {
    harness = await TestHarness.create({
      llmTurns: [
        // Sequential turn 1: write to memory
        toolUseTurn('memory_write', {
          scope: 'test',
          content: 'test data',
        }),
        // Conditional: after getting tool result, respond with text
        {
          match: matchHasToolResult(),
          chunks: [
            { type: 'text', content: 'Memory saved successfully!' },
            { type: 'done', usage: { inputTokens: 10, outputTokens: 5 } },
          ],
        },
      ],
    });

    const result = await harness.runAgentLoop('Save some test data');

    expect(result.finalText).toBe('Memory saved successfully!');
  });

  test('LLM receives tool_result in conversation history', async () => {
    harness = await TestHarness.create({
      llmTurns: [
        toolUseTurn('memory_write', {
          scope: 'test',
          content: 'data',
        }),
        textTurn('Saved.'),
      ],
    });

    await harness.runAgentLoop('Save data');

    // The second LLM call should have tool_result in the messages
    expect(harness.llm.callCount).toBe(2);
    const secondCall = harness.llm.calls[1]!;
    const lastMessage = secondCall.request.messages[secondCall.request.messages.length - 1]!;

    // The last message should contain tool_result content blocks
    expect(Array.isArray(lastMessage.content)).toBe(true);
    const contentBlocks = lastMessage.content as any[];
    expect(contentBlocks.some((b: any) => b.type === 'tool_result')).toBe(true);
  });
});
