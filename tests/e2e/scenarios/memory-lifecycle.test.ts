/**
 * Scenario: Memory CRUD lifecycle
 *
 * Tests the complete memory_write → memory_read → memory_list → memory_delete
 * flow, covering the full data lifecycle that was partially tested in
 * multi-turn-tool-use.test.ts (only write + query).
 *
 * Response shapes:
 *   memory_write  → { ok, id }
 *   memory_read   → { ok, entry }
 *   memory_query  → { ok, results }
 *   memory_list   → { ok, entries }
 *   memory_delete → { ok: true }
 */

import { describe, test, expect, afterEach } from 'vitest';
import { TestHarness } from '../harness.js';
import { textTurn, toolUseTurn } from '../scripted-llm.js';

describe('E2E Scenario: Memory Lifecycle', () => {
  let harness: TestHarness;

  afterEach(() => {
    harness?.dispose();
  });

  test('memory_write returns an ID', async () => {
    harness = await TestHarness.create();

    const result = await harness.ipcCall('memory_write', {
      scope: 'agent',
      content: 'Test fact: the sky is blue.',
      tags: ['test'],
    });

    expect(result.ok).toBe(true);
    expect(result.id).toBeDefined();
    expect(typeof result.id).toBe('string');
  });

  test('memory_read retrieves a written entry', async () => {
    harness = await TestHarness.create();

    const writeResult = await harness.ipcCall('memory_write', {
      scope: 'agent',
      content: 'Important fact for later.',
      tags: ['important'],
    });

    const readResult = await harness.ipcCall('memory_read', {
      id: writeResult.id,
    });

    expect(readResult.ok).toBe(true);
    expect(readResult.entry).toBeDefined();
    expect(readResult.entry.content).toBe('Important fact for later.');
    expect(readResult.entry.tags).toContain('important');
  });

  test('memory_read for nonexistent ID returns null entry', async () => {
    harness = await TestHarness.create();

    // ID must be a valid UUID (Zod schema enforces this)
    const result = await harness.ipcCall('memory_read', {
      id: '00000000-0000-0000-0000-000000000000',
    });

    expect(result.ok).toBe(true);
    expect(result.entry).toBeNull();
  });

  test('memory_list returns all entries in a scope', async () => {
    harness = await TestHarness.create();

    await harness.ipcCall('memory_write', {
      scope: 'project',
      content: 'Fact A',
      tags: ['a'],
    });
    await harness.ipcCall('memory_write', {
      scope: 'project',
      content: 'Fact B',
      tags: ['b'],
    });
    await harness.ipcCall('memory_write', {
      scope: 'other',
      content: 'Fact C',
      tags: ['c'],
    });

    const result = await harness.ipcCall('memory_list', {
      scope: 'project',
    });

    expect(result.ok).toBe(true);
    expect(result.entries.length).toBe(2);
  });

  test('memory_list respects limit parameter', async () => {
    harness = await TestHarness.create();

    for (let i = 0; i < 5; i++) {
      await harness.ipcCall('memory_write', {
        scope: 'bulk',
        content: `Entry ${i}`,
        tags: [],
      });
    }

    const result = await harness.ipcCall('memory_list', {
      scope: 'bulk',
      limit: 2,
    });

    expect(result.ok).toBe(true);
    expect(result.entries.length).toBe(2);
  });

  test('memory_delete removes an entry', async () => {
    harness = await TestHarness.create();

    const writeResult = await harness.ipcCall('memory_write', {
      scope: 'agent',
      content: 'Temporary fact.',
      tags: ['temp'],
    });

    // Verify it exists
    const readBefore = await harness.ipcCall('memory_read', {
      id: writeResult.id,
    });
    expect(readBefore.entry).not.toBeNull();

    // Delete it
    const deleteResult = await harness.ipcCall('memory_delete', {
      id: writeResult.id,
    });
    expect(deleteResult.ok).toBe(true);

    // Verify it's gone
    const readAfter = await harness.ipcCall('memory_read', {
      id: writeResult.id,
    });
    expect(readAfter.entry).toBeNull();
  });

  test('memory_delete is audited', async () => {
    harness = await TestHarness.create();

    const writeResult = await harness.ipcCall('memory_write', {
      scope: 'agent',
      content: 'To be deleted.',
      tags: [],
    });

    await harness.ipcCall('memory_delete', { id: writeResult.id });

    expect(harness.wasAudited('memory_delete')).toBe(true);
  });

  test('memory_query with tags filters correctly', async () => {
    harness = await TestHarness.create();

    await harness.ipcCall('memory_write', {
      scope: 'tagged',
      content: 'Has foo tag',
      tags: ['foo'],
    });
    await harness.ipcCall('memory_write', {
      scope: 'tagged',
      content: 'Has bar tag',
      tags: ['bar'],
    });
    await harness.ipcCall('memory_write', {
      scope: 'tagged',
      content: 'Has both tags',
      tags: ['foo', 'bar'],
    });

    const result = await harness.ipcCall('memory_query', {
      scope: 'tagged',
      tags: ['foo'],
    });

    expect(result.ok).toBe(true);
    expect(result.results.length).toBe(2); // 'Has foo tag' and 'Has both tags'
  });

  test('full lifecycle: write → read → query → delete → confirm gone', async () => {
    harness = await TestHarness.create();

    // Write
    const { id } = await harness.ipcCall('memory_write', {
      scope: 'lifecycle',
      content: 'Full lifecycle test.',
      tags: ['lifecycle'],
    });

    // Read
    const readResult = await harness.ipcCall('memory_read', { id });
    expect(readResult.entry.content).toBe('Full lifecycle test.');

    // Query
    const queryResult = await harness.ipcCall('memory_query', {
      scope: 'lifecycle',
      tags: ['lifecycle'],
    });
    expect(queryResult.results.length).toBe(1);

    // Delete
    await harness.ipcCall('memory_delete', { id });

    // Confirm gone from read
    const readAfter = await harness.ipcCall('memory_read', { id });
    expect(readAfter.entry).toBeNull();

    // Confirm gone from query
    const queryAfter = await harness.ipcCall('memory_query', {
      scope: 'lifecycle',
      tags: ['lifecycle'],
    });
    expect(queryAfter.results.length).toBe(0);
  });

  test('multi-turn: LLM writes then reads memory via tool_use', async () => {
    harness = await TestHarness.create({
      llmTurns: [
        // Turn 1: LLM writes a memory
        toolUseTurn('memory_write', {
          scope: 'agent',
          content: 'The user prefers dark mode.',
          tags: ['preference'],
        }),
        // Turn 2: LLM queries the memory
        toolUseTurn('memory_query', {
          scope: 'agent',
          tags: ['preference'],
        }),
        // Turn 3: LLM responds
        textTurn('I remember that you prefer dark mode.'),
      ],
    });

    const result = await harness.runAgentLoop('What do you remember about my preferences?');

    expect(result.toolCalls.length).toBe(2);
    expect(result.toolCalls[0]!.name).toBe('memory_write');
    expect(result.toolCalls[1]!.name).toBe('memory_query');
    expect(result.finalText).toContain('dark mode');
  });
});
