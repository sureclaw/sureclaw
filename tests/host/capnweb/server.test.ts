/**
 * Tests for tool batch IPC handler — $ref resolution, pipelining, errors.
 */

import { describe, it, expect } from 'vitest';
import {
  createToolBatchHandlers,
  evaluatePath,
  resolveRefs,
} from '../../../src/host/ipc-handlers/tool-batch.js';
import type { McpToolCall } from '../../../src/providers/mcp/types.js';
import { initLogger } from '../../../src/logger.js';

initLogger({ file: false, level: 'silent' });

// ---------------------------------------------------------------------------
// evaluatePath
// ---------------------------------------------------------------------------

describe('evaluatePath', () => {
  it('should resolve array index', () => {
    expect(evaluatePath([{ id: 'a' }, { id: 'b' }], '[0].id')).toBe('a');
    expect(evaluatePath([{ id: 'a' }, { id: 'b' }], '[1].id')).toBe('b');
  });

  it('should resolve nested properties', () => {
    expect(evaluatePath({ data: { items: [{ name: 'x' }] } }, '.data.items[0].name')).toBe('x');
  });

  it('should return the value itself for empty path', () => {
    expect(evaluatePath('hello', '')).toBe('hello');
  });

  it('should return undefined for missing paths', () => {
    expect(evaluatePath({ a: 1 }, '.b.c')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// resolveRefs
// ---------------------------------------------------------------------------

describe('resolveRefs', () => {
  it('should replace $ref with prior result', () => {
    const results = [['team-1', 'team-2'], { name: 'repo' }];
    const resolved = resolveRefs({ $ref: 0, path: '[0]' }, results);
    expect(resolved).toBe('team-1');
  });

  it('should recursively resolve refs in nested objects', () => {
    const results = [{ teams: [{ id: 'T1' }] }];
    const args = {
      teamId: { $ref: 0, path: '.teams[0].id' },
      limit: 10,
    };
    const resolved = resolveRefs(args, results) as any;
    expect(resolved.teamId).toBe('T1');
    expect(resolved.limit).toBe(10);
  });

  it('should resolve refs in arrays', () => {
    const results = ['a', 'b'];
    const resolved = resolveRefs([{ $ref: 0 }, { $ref: 1 }], results);
    expect(resolved).toEqual(['a', 'b']);
  });

  it('should pass through non-ref values', () => {
    expect(resolveRefs('hello', [])).toBe('hello');
    expect(resolveRefs(42, [])).toBe(42);
    expect(resolveRefs(null, [])).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// createToolBatchHandlers
// ---------------------------------------------------------------------------

describe('createToolBatchHandlers', () => {
  const ctx = { sessionId: 's', agentId: 'a', userId: 'u' };

  it('should execute independent calls and return results', async () => {
    const calls: McpToolCall[] = [];
    const provider = {
      async callTool(call: McpToolCall) {
        calls.push(call);
        return { content: { tool: call.tool, args: call.arguments } };
      },
    };

    const handlers = createToolBatchHandlers(() => provider);
    const result = await handlers.tool_batch({
      calls: [
        { tool: 'getTeams', args: {} },
        { tool: 'getRepos', args: { org: 'ax' } },
      ],
    }, ctx);

    expect(result.results).toHaveLength(2);
    expect(result.results[0]).toEqual({ tool: 'getTeams', args: {} });
    expect(result.results[1]).toEqual({ tool: 'getRepos', args: { org: 'ax' } });
  });

  it('should resolve $ref dependencies between calls', async () => {
    const provider = {
      async callTool(call: McpToolCall) {
        if (call.tool === 'getTeams') {
          return { content: [{ id: 'T1', name: 'Eng' }, { id: 'T2', name: 'Product' }] };
        }
        if (call.tool === 'getIssues') {
          return { content: [{ title: `Issue for ${call.arguments.teamId}` }] };
        }
        return { content: null };
      },
    };

    const handlers = createToolBatchHandlers(() => provider);
    const result = await handlers.tool_batch({
      calls: [
        { tool: 'getTeams', args: {} },
        { tool: 'getIssues', args: { teamId: { $ref: 0, path: '[0].id' } } },
      ],
    }, ctx);

    expect(result.results[0]).toEqual([{ id: 'T1', name: 'Eng' }, { id: 'T2', name: 'Product' }]);
    expect(result.results[1]).toEqual([{ title: 'Issue for T1' }]);
  });

  it('should handle errors per-call without aborting the batch', async () => {
    const provider = {
      async callTool(call: McpToolCall) {
        if (call.tool === 'failing') {
          return { content: 'Rate limit exceeded', isError: true };
        }
        return { content: 'ok' };
      },
    };

    const handlers = createToolBatchHandlers(() => provider);
    const result = await handlers.tool_batch({
      calls: [
        { tool: 'failing', args: {} },
        { tool: 'working', args: {} },
      ],
    }, ctx);

    expect(result.results[0]).toEqual({ $error: 'Rate limit exceeded' });
    expect(result.results[1]).toBe('ok');
  });

  it('should throw when provider is null', async () => {
    const handlers = createToolBatchHandlers(() => null);
    await expect(
      handlers.tool_batch({ calls: [] }, ctx),
    ).rejects.toThrow('not available');
  });
});
