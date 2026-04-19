import { describe, it, expect } from 'vitest';
import { generateModule, generateIndex, snakeToCamel } from '../../../src/host/toolgen/codegen.js';
import { initLogger } from '../../../src/logger.js';

initLogger({ file: false, level: 'silent' });

describe('snakeToCamel', () => {
  it('converts list_issues → listIssues', () => {
    expect(snakeToCamel('list_issues')).toBe('listIssues');
  });
  it('converts get_pull_request → getPullRequest', () => {
    expect(snakeToCamel('get_pull_request')).toBe('getPullRequest');
  });
  it('leaves camelCase unchanged', () => {
    expect(snakeToCamel('listIssues')).toBe('listIssues');
  });
});

describe('generateModule', () => {
  it('generates an importable JS module with async functions', () => {
    const result = generateModule('linear', [
      {
        name: 'list_issues',
        description: 'List issues with optional filters',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Filter query' },
            limit: { type: 'number', description: 'Max results' },
          },
        },
      },
      {
        name: 'create_issue',
        description: 'Create a new issue',
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            body: { type: 'string' },
            teamId: { type: 'string' },
          },
          required: ['title', 'teamId'],
        },
      },
    ]);

    expect(result).toContain('export async function listIssues');
    expect(result).toContain('export async function createIssue');
    expect(result).toContain('List issues with optional filters');
    expect(result).toContain('@param');
    expect(result).toContain('tool_batch');
    expect(result).toContain('AX_HOST_URL');
    expect(result).not.toContain('#!/usr/bin/env');
  });

  it('converts snake_case tool names to camelCase function names', () => {
    const result = generateModule('github', [
      { name: 'get_pull_request', description: 'Get PR', inputSchema: { type: 'object', properties: { id: { type: 'number' } } } },
    ]);
    expect(result).toContain('export async function getPullRequest');
  });

  it('emits object-form JSDoc so agents know to pass a single object', () => {
    // Regression: previously JSDoc wrote `@param {string} teamId` (positional
    // style) while the generated function actually takes one object argument.
    // The mismatch caused agents to call `listCycles("uuid")`, which then
    // serialized a raw string as IPC `args` and tripped the Zod
    // `z.record(...)` validator with an unhelpful "expected record, received
    // string" error — sending the model into a 16-call retry spiral.
    const result = generateModule('linear', [
      {
        name: 'list_cycles',
        description: 'Retrieve cycles',
        inputSchema: {
          type: 'object',
          properties: {
            teamId: { type: 'string', description: 'Team ID' },
            type: { type: 'string', description: 'Filter' },
          },
          required: ['teamId'],
        },
      },
    ]);
    expect(result).toContain('@param {object} params');
    expect(result).toContain('@param {string} params.teamId');
    expect(result).toContain('@param {string} [params.type]');
    // The old positional form must not appear — it's what misled the agent.
    expect(result).not.toMatch(/@param \{string\} teamId\b/);
  });

  it('emits a runtime guard that rejects non-object arguments', () => {
    // Defense in depth: even if the model ignores the JSDoc and passes a
    // string or primitive, the generated function should fail fast with an
    // actionable message rather than letting a cryptic IPC schema error
    // ("expected record, received string") leak back to the agent.
    const result = generateModule('linear', [
      {
        name: 'list_cycles',
        description: 'Retrieve cycles',
        inputSchema: {
          type: 'object',
          properties: { teamId: { type: 'string' } },
          required: ['teamId'],
        },
      },
    ]);
    expect(result).toMatch(/typeof params !== ['"]object['"]/);
    expect(result).toContain('throw new TypeError');
    expect(result).toMatch(/listCycles\b[^\n]*object/);
  });

  it('surfaces enum values as a union type in JSDoc', () => {
    // Regression: Linear's `list_cycles` tool takes `type: "current" | "previous" | "next"`.
    // Previously the JSDoc said `@param {string} [params.type] — Filter: current,
    // previous, next` and the agent would hallucinate adjacent values ("active",
    // "open", etc.), then hit a server-side enum validation error. Surfacing
    // the enum in the param type gives the agent a compile-time-ish hint that
    // it can't ignore without noticing.
    const result = generateModule('linear', [
      {
        name: 'list_cycles',
        description: 'Retrieve cycles',
        inputSchema: {
          type: 'object',
          properties: {
            teamId: { type: 'string' },
            type: {
              type: 'string',
              enum: ['current', 'previous', 'next'],
              description: 'Cycle window',
            },
          },
          required: ['teamId'],
        },
      },
    ]);
    expect(result).toContain('@param {"current"|"previous"|"next"} [params.type]');
    // Still surfaces description and optionality
    expect(result).toContain('— Cycle window');
    // Plain string params unchanged
    expect(result).toContain('@param {string} params.teamId');
  });

  it('falls back to plain {string} when enum values are empty or malformed', () => {
    // Defensive: a tool schema with an empty enum or non-string values
    // shouldn't crash codegen — just emit the plain type.
    const result = generateModule('x', [
      {
        name: 'f',
        description: 'f',
        inputSchema: {
          type: 'object',
          properties: {
            a: { type: 'string', enum: [] },
            b: { type: 'string' },
          },
        },
      },
    ]);
    expect(result).toContain('@param {string} [params.a]');
    expect(result).toContain('@param {string} [params.b]');
  });

  it('skips the guard for tools with no parameters', () => {
    // Tools whose inputSchema has no properties don't accept any args, so
    // there's nothing to guard — the function signature is zero-arity.
    const result = generateModule('linear', [
      { name: 'ping', description: 'Ping', inputSchema: { type: 'object', properties: {} } },
    ]);
    expect(result).toContain('export async function ping()');
    expect(result).not.toContain('typeof params');
  });

  it('defaults params to {} when no property is required, so no-args calls succeed', () => {
    // Regression: Linear's `list_teams` has all-optional params (limit, cursor,
    // orderBy, query, ...). The agent legitimately calls `listTeams()` with no
    // args. The previous guard tripped `typeof undefined !== 'object'` and
    // threw, even though the call was valid. Agents interpreted this as
    // "signature wrong" and retried with wrong shapes — exactly the spiral
    // the guard was supposed to prevent. Fix: when `required` is empty, bake
    // in `params = {}` so no-args works, while still rejecting strings/nulls.
    const result = generateModule('linear', [
      {
        name: 'list_teams',
        description: 'List teams',
        inputSchema: {
          type: 'object',
          properties: {
            limit: { type: 'number' },
            cursor: { type: 'string' },
            orderBy: { type: 'string' },
          },
          // No `required` key = all optional
        },
      },
    ]);
    expect(result).toContain('export async function listTeams(params = {})');
    // Guard still present — rejects explicit non-object values
    expect(result).toMatch(/typeof params !== ['"]object['"]/);
  });

  it('keeps bare params (no default) when any property is required', () => {
    // If a required param is missing, calling with no args should still surface
    // the actionable "expects a single object argument" error — NOT silently
    // skip all validation by defaulting to {} and then shipping an empty
    // object to the server.
    const result = generateModule('linear', [
      {
        name: 'get_team',
        description: 'Retrieve a team',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
        },
      },
    ]);
    expect(result).toContain('export async function getTeam(params)');
    expect(result).not.toContain('getTeam(params = {})');
  });

  it('warns about response-shape wrapping in the module header', () => {
    // Regression: Linear (and many MCP servers) wrap list results in an
    // object keyed by the plural resource name — `listIssues()` returns
    // `{ issues: [...], pageInfo: ... }`, NOT a bare array. Agents guess
    // `.map` on the result, hit "X.map is not a function", and burn 3-6
    // turns discovering the shape. We can't derive return shape at codegen
    // time (MCP inputSchema lacks an outputSchema), but we CAN put a
    // prominent hint at the top of the module the agent reads before
    // writing script. The hint is the minimum viable documentation —
    // cheaper than auto-unwrap heuristics and safer than losing pageInfo.
    const result = generateModule('linear', [
      { name: 'list_issues', description: 'List issues', inputSchema: { type: 'object', properties: {} } },
    ]);
    expect(result).toMatch(/response.*shape/i);
    expect(result).toContain('list_');
    expect(result).toMatch(/\{ issues:.*\[/);
  });
});

describe('generateIndex', () => {
  it('generates a barrel file that flat-re-exports every server module', () => {
    // Flat re-export so the agent can `import { listIssues }` directly,
    // matching the example in the `execute_script` tool description.
    const result = generateIndex(['linear', 'github', 'stripe']);
    expect(result).toContain("export * from './linear.js'");
    expect(result).toContain("export * from './github.js'");
    expect(result).toContain("export * from './stripe.js'");
    // The old namespace form (`export * as linear`) must not be used
    // — it forces a different import pattern that tends to confuse the
    // model.
    expect(result).not.toContain('as linear');
    expect(result).not.toContain('as github');
  });
});

