/**
 * Scenario: Error handling and edge cases
 *
 * Tests how the IPC layer handles:
 *   - Invalid JSON
 *   - Unknown actions
 *   - Missing required parameters
 *   - Audit query action
 *   - Multiple sequential operations
 *   - Empty/edge-case inputs
 */

import { describe, test, expect, afterEach } from 'vitest';
import { TestHarness } from '../harness.js';
import { textTurn, toolUseTurn } from '../scripted-llm.js';
import type { IPCContext } from '../../../src/host/ipc-server.js';

describe('E2E Scenario: Error Handling & Edge Cases', () => {
  let harness: TestHarness;

  afterEach(() => {
    harness?.dispose();
  });

  // ─── Invalid JSON ─────────────────────────────────

  test('invalid JSON returns parse error', async () => {
    harness = await TestHarness.create();
    const ctx: IPCContext = { sessionId: 'test', agentId: 'agent-1' };

    const result = JSON.parse(await harness.handleIPC('not valid json{{{', ctx));

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Invalid JSON');
  });

  test('invalid JSON is audited as parse error', async () => {
    harness = await TestHarness.create();
    const ctx: IPCContext = { sessionId: 'test', agentId: 'agent-1' };

    await harness.handleIPC('}{bad', ctx);

    expect(harness.wasAudited('ipc_parse_error')).toBe(true);
  });

  // ─── Unknown Action ───────────────────────────────

  test('unknown action returns error', async () => {
    harness = await TestHarness.create();
    const ctx: IPCContext = { sessionId: 'test', agentId: 'agent-1' };

    const result = JSON.parse(await harness.handleIPC(
      JSON.stringify({ action: 'nonexistent_action' }),
      ctx,
    ));

    expect(result.ok).toBe(false);
  });

  // ─── Audit Query ──────────────────────────────────

  test('audit_query returns logged entries', async () => {
    harness = await TestHarness.create();

    // Perform some operations to generate audit entries
    await harness.ipcCall('memory_write', {
      scope: 'test',
      content: 'Test data',
      tags: [],
    });
    await harness.ipcCall('web_search', { query: 'test query' });

    const result = await harness.ipcCall('audit_query', {});

    expect(result.ok).toBe(true);
    expect(result.entries.length).toBeGreaterThan(0);
    expect(result.entries.some((e: any) => e.action === 'memory_write')).toBe(true);
  });

  // ─── Empty Inputs ─────────────────────────────────

  test('memory_write with empty content succeeds', async () => {
    harness = await TestHarness.create();

    const result = await harness.ipcCall('memory_write', {
      scope: 'test',
      content: '',
      tags: [],
    });

    expect(result.ok).toBe(true);
    expect(result.id).toBeDefined();
  });

  test('web_search with empty query returns default mock', async () => {
    harness = await TestHarness.create();

    const result = await harness.ipcCall('web_search', { query: '' });

    expect(result.ok).toBe(true);
    expect(result[0]).toBeDefined();
  });

  // ─── Workspace Edge Cases ─────────────────────────

  test('workspace_write with nested path', async () => {
    harness = await TestHarness.create();

    const result = await harness.ipcCall('workspace_write', {
      tier: 'agent',
      path: 'deep/nested/file.md',
      content: 'Nested content',
    });

    expect(result.ok).toBe(true);
    expect(result.written).toBe(true);
  });

  test('workspace_write with empty content', async () => {
    harness = await TestHarness.create();

    const result = await harness.ipcCall('workspace_write', {
      tier: 'agent',
      path: 'empty.md',
      content: '',
    });

    expect(result.ok).toBe(true);
  });

  // ─── Sequential Operations ────────────────────────

  test('rapid sequential memory writes all succeed', async () => {
    harness = await TestHarness.create();

    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      const result = await harness.ipcCall('memory_write', {
        scope: 'rapid',
        content: `Entry ${i}`,
        tags: [`tag-${i}`],
      });
      expect(result.ok).toBe(true);
      ids.push(result.id);
    }

    // Verify all entries exist
    const listResult = await harness.ipcCall('memory_list', {
      scope: 'rapid',
    });
    expect(listResult.entries.length).toBe(10);
  });

  test('mixed operations maintain consistency', async () => {
    harness = await TestHarness.create();

    // Write memory
    const memResult = await harness.ipcCall('memory_write', {
      scope: 'mixed',
      content: 'Memory entry',
      tags: [],
    });

    // Write workspace
    await harness.ipcCall('workspace_write', {
      tier: 'agent',
      path: 'mixed-test.md',
      content: 'Workspace content',
    });

    // Search web
    await harness.ipcCall('web_search', { query: 'mixed test' });

    // Read memory back
    const readResult = await harness.ipcCall('memory_read', {
      id: memResult.id,
    });
    expect(readResult.entry.content).toBe('Memory entry');

    // All operations should be audited
    expect(harness.auditLog.length).toBeGreaterThanOrEqual(2); // memory_write + web operations vary
  });

  // ─── LLM Error Path ──────────────────────────────

  test('agent loop handles max turns gracefully', async () => {
    harness = await TestHarness.create({
      llmTurns: [
        // Keep calling tools forever — will hit maxTurns
        toolUseTurn('memory_write', { scope: 'loop', content: 'Turn 1', tags: [] }),
        toolUseTurn('memory_write', { scope: 'loop', content: 'Turn 2', tags: [] }),
        toolUseTurn('memory_write', { scope: 'loop', content: 'Turn 3', tags: [] }),
        toolUseTurn('memory_write', { scope: 'loop', content: 'Turn 4', tags: [] }),
      ],
      llmFallback: toolUseTurn('memory_write', { scope: 'loop', content: 'Fallback', tags: [] }),
    });

    const result = await harness.runAgentLoop('Keep writing', { maxTurns: 3 });

    // Should stop after 3 turns even though LLM keeps requesting tools
    expect(result.toolCalls.length).toBe(3);
  });

  test('multiple harness instances are isolated', async () => {
    const harness1 = await TestHarness.create();
    const harness2 = await TestHarness.create();
    // Set module-level harness so afterEach can clean up harness1
    harness = harness1;

    await harness1.ipcCall('memory_write', {
      scope: 'isolated',
      content: 'Harness 1 data',
      tags: [],
    });

    const result = await harness2.ipcCall('memory_list', {
      scope: 'isolated',
    });

    expect(result.entries.length).toBe(0); // harness2 shouldn't see harness1's data

    harness2.dispose();
    // harness1 will be disposed by afterEach via the module-level harness variable
  });

  // ─── Seed Data ────────────────────────────────────

  test('seeded memory is queryable immediately', async () => {
    harness = await TestHarness.create({
      seedMemory: [
        { id: 'seed-1', scope: 'preloaded', content: 'Pre-loaded fact', tags: ['seed'] },
        { id: 'seed-2', scope: 'preloaded', content: 'Another fact', tags: ['seed'] },
      ],
    });

    const result = await harness.ipcCall('memory_query', {
      scope: 'preloaded',
      tags: ['seed'],
    });

    expect(result.ok).toBe(true);
    expect(result.results.length).toBe(2);
  });

  test('seeded agents are available in registry', async () => {
    harness = await TestHarness.create({
      seedAgents: [
        {
          id: 'preloaded-agent',
          name: 'Preloaded',
          status: 'active',
          parentId: null,
          agentType: 'pi-agent-core',
          capabilities: ['test'],
          createdBy: 'system',
        },
      ],
    });

    const result = await harness.ipcCall('agent_registry_get', {
      agentId: 'preloaded-agent',
    });

    expect(result.ok).toBe(true);
    expect(result.agent.name).toBe('Preloaded');
  });
});
