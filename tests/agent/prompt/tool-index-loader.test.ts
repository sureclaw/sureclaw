// tests/agent/prompt/tool-index-loader.test.ts
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadToolIndex } from '../../../src/agent/prompt/tool-index-loader.js';

function makeWorkspace(): string {
  return join(tmpdir(), 'ax-tool-index-loader-' + Date.now() + '-' + Math.random().toString(36).slice(2));
}

function writeIndex(workspace: string, skill: string, body: unknown): void {
  const dir = join(workspace, '.ax', 'tools', skill);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '_index.json'), JSON.stringify(body, null, 2));
}

describe('loadToolIndex', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = makeWorkspace();
    mkdirSync(workspace, { recursive: true });
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  test('returns empty index when workspace dir does not exist', () => {
    const idx = loadToolIndex('/nonexistent/does/not/exist/ax-ws');
    expect(idx.render).toBe('');
    expect(idx.skills).toEqual([]);
  });

  test('returns empty index when .ax/tools dir does not exist', () => {
    const idx = loadToolIndex(workspace);
    expect(idx.render).toBe('');
    expect(idx.skills).toEqual([]);
  });

  test('renders signatures with destructuring braces so the agent knows it takes a single object arg', () => {
    // Regression: previous render `listCycles(teamId, type?)` looked to the
    // model like a TypeScript-style POSITIONAL signature (`fn(a, b)`). Agent
    // called `listCycles(team.id, 'current')`, the runtime guard rejected the
    // string as non-object, spiral. The generated stubs all take a single
    // object argument, so the render must make that unambiguous. Destructured
    // braces (`listCycles({ teamId, type? })`) match idiomatic JS call shape
    // and eliminate the positional guess.
    writeIndex(workspace, 'linear', {
      skill: 'linear',
      tools: [
        {
          name: 'list_cycles',
          parameters: {
            type: 'object',
            properties: { teamId: { type: 'string' }, type: { type: 'string' } },
            required: ['teamId'],
          },
        },
      ],
      generated_at: '2026-04-18T20:00:00Z',
    });

    const idx = loadToolIndex(workspace);
    expect(idx.render).toBe('  linear: listCycles({ teamId, type? })');
  });

  test('zero-param tools stay bare — no empty braces', () => {
    // `ping()` is a zero-arity call; rendering `ping({})` would be misleading.
    writeIndex(workspace, 'x', {
      skill: 'x',
      tools: [{ name: 'ping', parameters: { type: 'object', properties: {}, required: [] } }],
      generated_at: '2026-04-18T20:00:00Z',
    });

    const idx = loadToolIndex(workspace);
    expect(idx.render).toBe('  x: ping()');
  });

  test('loads one skill with camelCased tool names and optional params marked', () => {
    writeIndex(workspace, 'linear', {
      skill: 'linear',
      tools: [
        {
          name: 'list_issues',
          description: 'List all issues',
          parameters: {
            type: 'object',
            properties: { issueId: { type: 'string' }, limit: { type: 'number' } },
            required: ['issueId'],
          },
        },
        {
          name: 'create_issue',
          description: 'Create a new issue',
          parameters: {
            type: 'object',
            properties: { title: { type: 'string' }, description: { type: 'string' } },
            required: ['title'],
          },
        },
      ],
      generated_at: '2026-04-18T20:00:00Z',
    });

    const idx = loadToolIndex(workspace);
    expect(idx.render).toBe('  linear: listIssues({ issueId, limit? }), createIssue({ title, description? })');
    expect(idx.skills).toEqual([
      {
        name: 'linear',
        tools: [
          { name: 'list_issues', description: 'List all issues' },
          { name: 'create_issue', description: 'Create a new issue' },
        ],
      },
    ]);
  });

  test('loads multiple skills, one per line in render', () => {
    writeIndex(workspace, 'linear', {
      skill: 'linear',
      tools: [
        {
          name: 'list_issues',
          parameters: { type: 'object', properties: { limit: { type: 'number' } }, required: [] },
        },
      ],
      generated_at: '2026-04-18T20:00:00Z',
    });
    writeIndex(workspace, 'zendesk', {
      skill: 'zendesk',
      tools: [
        {
          name: 'get_ticket',
          parameters: { type: 'object', properties: { ticketId: { type: 'string' } }, required: ['ticketId'] },
        },
        {
          name: 'list_tickets',
          parameters: { type: 'object', properties: {}, required: [] },
        },
      ],
      generated_at: '2026-04-18T20:00:00Z',
    });

    const idx = loadToolIndex(workspace);
    const lines = idx.render.split('\n').sort();
    expect(lines).toEqual([
      '  linear: listIssues({ limit? })',
      '  zendesk: getTicket({ ticketId }), listTickets()',
    ]);
    expect(idx.skills.map(s => s.name).sort()).toEqual(['linear', 'zendesk']);
  });

  test('handles tool with no parameters field', () => {
    writeIndex(workspace, 'calendar', {
      skill: 'calendar',
      tools: [
        { name: 'list_events' },
      ],
      generated_at: '2026-04-18T20:00:00Z',
    });

    const idx = loadToolIndex(workspace);
    expect(idx.render).toBe('  calendar: listEvents()');
  });

  test('skips skill with malformed JSON but loads others', () => {
    writeIndex(workspace, 'good', {
      skill: 'good',
      tools: [
        { name: 'do_thing', parameters: { type: 'object', properties: {}, required: [] } },
      ],
      generated_at: '2026-04-18T20:00:00Z',
    });
    const badDir = join(workspace, '.ax', 'tools', 'bad');
    mkdirSync(badDir, { recursive: true });
    writeFileSync(join(badDir, '_index.json'), '{ not valid json');

    const idx = loadToolIndex(workspace);
    expect(idx.render).toBe('  good: doThing()');
    expect(idx.skills.map(s => s.name)).toEqual(['good']);
  });

  test('skips skill with missing tools field', () => {
    writeIndex(workspace, 'broken', { skill: 'broken' });
    writeIndex(workspace, 'ok', {
      skill: 'ok',
      tools: [{ name: 'ping', parameters: { type: 'object', properties: {}, required: [] } }],
      generated_at: '2026-04-18T20:00:00Z',
    });

    const idx = loadToolIndex(workspace);
    expect(idx.render).toBe('  ok: ping()');
    expect(idx.skills.map(s => s.name)).toEqual(['ok']);
  });

  test('skips skill with empty tools array', () => {
    writeIndex(workspace, 'empty', { skill: 'empty', tools: [], generated_at: '2026-04-18T20:00:00Z' });
    writeIndex(workspace, 'has-tools', {
      skill: 'has-tools',
      tools: [{ name: 'ping', parameters: { type: 'object', properties: {}, required: [] } }],
      generated_at: '2026-04-18T20:00:00Z',
    });

    const idx = loadToolIndex(workspace);
    expect(idx.render).toBe('  has-tools: ping()');
    expect(idx.skills.map(s => s.name)).toEqual(['has-tools']);
  });

  test('ignores subdirectories without _index.json', () => {
    // Only has server modules, no index metadata
    const skillDir = join(workspace, '.ax', 'tools', 'modules-only');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'server.js'), '// some module');

    writeIndex(workspace, 'real', {
      skill: 'real',
      tools: [{ name: 'ping', parameters: { type: 'object', properties: {}, required: [] } }],
      generated_at: '2026-04-18T20:00:00Z',
    });

    const idx = loadToolIndex(workspace);
    expect(idx.render).toBe('  real: ping()');
  });

  test('surfaces enum values in the rendered signature so agents cannot hallucinate', () => {
    // Regression: Linear's `list_cycles` has `type: "current" | "previous" | "next"`.
    // Without the enum in the render, the agent sees `listCycles(teamId, type?)`
    // in the prompt and hallucinates `type: 'active'`. Linear rejects the call,
    // the agent burns a turn, then retries with 'current'. Embedding the enum
    // in the rendered signature gives the agent the valid values before it
    // writes the script — the wrong-value retry vanishes.
    writeIndex(workspace, 'linear', {
      skill: 'linear',
      tools: [
        {
          name: 'list_cycles',
          parameters: {
            type: 'object',
            properties: {
              teamId: { type: 'string' },
              type: { type: 'string', enum: ['current', 'previous', 'next'] },
            },
            required: ['teamId'],
          },
        },
      ],
      generated_at: '2026-04-18T20:00:00Z',
    });

    const idx = loadToolIndex(workspace);
    expect(idx.render).toBe('  linear: listCycles({ teamId, type?: "current"|"previous"|"next" })');
  });

  test('falls back to plain param name when enum is empty, missing, or non-string', () => {
    // Defensive: a malformed enum (empty, all non-strings) should NOT crash
    // the render — just drop the hint and emit the plain param.
    writeIndex(workspace, 'mixed', {
      skill: 'mixed',
      tools: [
        {
          name: 'f',
          parameters: {
            type: 'object',
            properties: {
              plain: { type: 'string' },
              emptyEnum: { type: 'string', enum: [] },
              numericEnum: { type: 'number', enum: [1, 2, 3] },
            },
            required: [],
          },
        },
      ],
      generated_at: '2026-04-18T20:00:00Z',
    });

    const idx = loadToolIndex(workspace);
    expect(idx.render).toBe('  mixed: f({ plain?, emptyEnum?, numericEnum? })');
  });

  test('truncates very long enum lists so the prompt stays compact', () => {
    // Rendering a 50-value enum inline would bloat the prompt. Cap the
    // rendered list and signal truncation with `|…`. Agent still sees
    // "this is an enum" + a few valid values; for the rest it falls back
    // to reading the module file.
    const values = Array.from({ length: 12 }, (_, i) => `v${i}`);
    writeIndex(workspace, 'wide', {
      skill: 'wide',
      tools: [
        {
          name: 'g',
          parameters: {
            type: 'object',
            properties: { kind: { type: 'string', enum: values } },
            required: [],
          },
        },
      ],
      generated_at: '2026-04-18T20:00:00Z',
    });

    const idx = loadToolIndex(workspace);
    // The exact cap is a policy choice; test the shape: some values present,
    // then the truncation marker.
    expect(idx.render).toMatch(/kind\?: "v0"\|"v1"\|"v2"\|"v3"\|"v4"\|"v5"\|/);
    expect(idx.render).toContain('|…');
    expect(idx.render).not.toContain('"v11"');
  });

  test('render preserves required field ordering from properties', () => {
    writeIndex(workspace, 'ordered', {
      skill: 'ordered',
      tools: [
        {
          name: 'do_stuff',
          parameters: {
            type: 'object',
            properties: { a: {}, b: {}, c: {}, d: {} },
            required: ['b', 'd'],
          },
        },
      ],
      generated_at: '2026-04-18T20:00:00Z',
    });

    const idx = loadToolIndex(workspace);
    // Order matches properties iteration order: a?, b, c?, d
    expect(idx.render).toBe('  ordered: doStuff({ a?, b, c?, d })');
  });
});
