import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { convertPiMessages, emitStreamEvents, loadContext, loadSkills } from '../../src/agent/stream-utils.js';

// ── convertPiMessages ────────────────────────────────────────────────

describe('convertPiMessages', () => {
  test('converts user message with string content', () => {
    const result = convertPiMessages([
      { role: 'user', content: 'Hello world', timestamp: Date.now() },
    ] as any);
    expect(result).toEqual([{ role: 'user', content: 'Hello world' }]);
  });

  test('converts user message with structured text content', () => {
    const result = convertPiMessages([{
      role: 'user',
      content: [{ type: 'text', text: 'Hello ' }, { type: 'text', text: 'world' }],
    }] as any);
    expect(result).toEqual([{ role: 'user', content: 'Hello world' }]);
  });

  test('uses fallback dot for empty user content', () => {
    const result = convertPiMessages([
      { role: 'user', content: '' },
    ] as any);
    expect(result).toEqual([{ role: 'user', content: '.' }]);
  });

  test('filters non-text content from user messages', () => {
    const result = convertPiMessages([{
      role: 'user',
      content: [
        { type: 'text', text: 'Hello' },
        { type: 'image', url: 'http://example.com/img.png' },
        { type: 'text', text: ' world' },
      ],
    }] as any);
    expect(result).toEqual([{ role: 'user', content: 'Hello world' }]);
  });

  test('converts assistant text-only to string', () => {
    const result = convertPiMessages([{
      role: 'assistant',
      content: [{ type: 'text', text: 'Hi there' }],
    }] as any);
    expect(result).toEqual([{ role: 'assistant', content: 'Hi there' }]);
  });

  test('converts assistant with multiple text blocks to joined string', () => {
    const result = convertPiMessages([{
      role: 'assistant',
      content: [{ type: 'text', text: 'Part 1 ' }, { type: 'text', text: 'Part 2' }],
    }] as any);
    expect(result).toEqual([{ role: 'assistant', content: 'Part 1 Part 2' }]);
  });

  test('converts assistant with tool calls to blocks array', () => {
    const result = convertPiMessages([{
      role: 'assistant',
      content: [
        { type: 'text', text: 'Let me help' },
        { type: 'toolCall', id: 'tc_1', name: 'read_file', arguments: { path: '/tmp/a.txt' } },
      ],
    }] as any);
    expect(result).toEqual([{
      role: 'assistant',
      content: [
        { type: 'text', text: 'Let me help' },
        { type: 'tool_use', id: 'tc_1', name: 'read_file', input: { path: '/tmp/a.txt' } },
      ],
    }]);
  });

  test('uses fallback dot for empty assistant content', () => {
    const result = convertPiMessages([{
      role: 'assistant', content: [],
    }] as any);
    expect(result).toEqual([{ role: 'assistant', content: '.' }]);
  });

  test('uses fallback dot for assistant with empty text', () => {
    const result = convertPiMessages([{
      role: 'assistant',
      content: [{ type: 'text', text: '' }],
    }] as any);
    expect(result).toEqual([{ role: 'assistant', content: '.' }]);
  });

  test('converts toolResult to user message with tool_result block', () => {
    const result = convertPiMessages([{
      role: 'toolResult',
      toolCallId: 'tc_1',
      content: [{ type: 'text', text: 'file contents here' }],
    }] as any);
    expect(result).toEqual([{
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tc_1', content: 'file contents here' }],
    }]);
  });

  test('uses [no output] fallback for empty toolResult', () => {
    const result = convertPiMessages([{
      role: 'toolResult',
      toolCallId: 'tc_1',
      content: [{ type: 'text', text: '' }],
    }] as any);
    expect(result).toEqual([{
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tc_1', content: '[no output]' }],
    }]);
  });

  test('handles unknown role as user with fallback dot', () => {
    const result = convertPiMessages([
      { role: 'system', content: 'system message' },
    ] as any);
    expect(result).toEqual([{ role: 'user', content: '.' }]);
  });

  test('converts mixed message sequence', () => {
    const result = convertPiMessages([
      { role: 'user', content: 'Do something' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'OK' },
          { type: 'toolCall', id: 'tc_1', name: 'run', arguments: { cmd: 'ls' } },
        ],
      },
      {
        role: 'toolResult',
        toolCallId: 'tc_1',
        content: [{ type: 'text', text: 'file1.txt' }],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Done!' }],
      },
    ] as any);
    expect(result).toHaveLength(4);
    expect(result[0]).toEqual({ role: 'user', content: 'Do something' });
    expect(result[1].role).toBe('assistant');
    expect(result[1].content).toHaveLength(2);
    expect(result[2]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tc_1', content: 'file1.txt' }],
    });
    expect(result[3]).toEqual({ role: 'assistant', content: 'Done!' });
  });
});

// ── emitStreamEvents ─────────────────────────────────────────────────

describe('emitStreamEvents', () => {
  function createMockStream() {
    const events: any[] = [];
    return { push: (e: any) => events.push(e), events };
  }

  const mockMsg = { role: 'assistant', content: [], timestamp: Date.now() } as any;

  test('emits text events for text-only response', () => {
    const stream = createMockStream();
    emitStreamEvents(stream as any, mockMsg, 'hello', [], 'stop');
    expect(stream.events.map((e: any) => e.type)).toEqual([
      'start', 'text_start', 'text_delta', 'text_end', 'done',
    ]);
    expect(stream.events[2].delta).toBe('hello');
    expect(stream.events[3].content).toBe('hello');
    expect(stream.events[4].reason).toBe('stop');
  });

  test('emits tool call events for tool-only response', () => {
    const stream = createMockStream();
    const toolCalls = [
      { type: 'toolCall' as const, id: 'tc1', name: 'read_file', arguments: { path: '/a' } },
    ];
    emitStreamEvents(stream as any, mockMsg, '', toolCalls, 'toolUse');
    expect(stream.events.map((e: any) => e.type)).toEqual([
      'start', 'toolcall_start', 'toolcall_delta', 'toolcall_end', 'done',
    ]);
    expect(stream.events[1].contentIndex).toBe(0);
    expect(stream.events[3].toolCall).toBe(toolCalls[0]);
    expect(stream.events[4].reason).toBe('toolUse');
  });

  test('emits text + tool call events with correct offset indices', () => {
    const stream = createMockStream();
    const toolCalls = [
      { type: 'toolCall' as const, id: 'tc1', name: 'read_file', arguments: { path: '/a' } },
    ];
    emitStreamEvents(stream as any, mockMsg, 'thinking...', toolCalls, 'toolUse');
    expect(stream.events.map((e: any) => e.type)).toEqual([
      'start', 'text_start', 'text_delta', 'text_end',
      'toolcall_start', 'toolcall_delta', 'toolcall_end', 'done',
    ]);
    // Text events at contentIndex 0
    expect(stream.events[1].contentIndex).toBe(0);
    // Tool call events at contentIndex 1 (offset by text)
    expect(stream.events[4].contentIndex).toBe(1);
  });

  test('emits multiple tool calls with sequential indices', () => {
    const stream = createMockStream();
    const toolCalls = [
      { type: 'toolCall' as const, id: 'tc1', name: 'read_file', arguments: { path: '/a' } },
      { type: 'toolCall' as const, id: 'tc2', name: 'write_file', arguments: { path: '/b', content: 'x' } },
    ];
    emitStreamEvents(stream as any, mockMsg, '', toolCalls, 'toolUse');
    const starts = stream.events.filter((e: any) => e.type === 'toolcall_start');
    expect(starts).toHaveLength(2);
    expect(starts[0].contentIndex).toBe(0);
    expect(starts[1].contentIndex).toBe(1);
  });

  test('serializes tool call arguments in delta', () => {
    const stream = createMockStream();
    const toolCalls = [
      { type: 'toolCall' as const, id: 'tc1', name: 'run', arguments: { cmd: 'ls', cwd: '/tmp' } },
    ];
    emitStreamEvents(stream as any, mockMsg, '', toolCalls, 'toolUse');
    const delta = stream.events.find((e: any) => e.type === 'toolcall_delta');
    expect(delta.delta).toBe(JSON.stringify({ cmd: 'ls', cwd: '/tmp' }));
  });

  test('skips text events when fullText is empty', () => {
    const stream = createMockStream();
    emitStreamEvents(stream as any, mockMsg, '', [], 'stop');
    expect(stream.events.map((e: any) => e.type)).toEqual(['start', 'done']);
  });
});

// ── loadContext / loadSkills ──────────────────────────────────────────

describe('loadContext', () => {
  const tmpDir = join(tmpdir(), 'ax-test-stream-utils-ctx-' + Date.now());

  beforeEach(() => mkdirSync(tmpDir, { recursive: true }));
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  test('reads CONTEXT.md from workspace', () => {
    writeFileSync(join(tmpDir, 'CONTEXT.md'), 'test context');
    expect(loadContext(tmpDir)).toBe('test context');
  });

  test('returns empty string when CONTEXT.md is missing', () => {
    expect(loadContext(tmpDir)).toBe('');
  });
});

describe('loadSkills', () => {
  const tmpDir = join(tmpdir(), 'ax-test-stream-utils-skills-' + Date.now());

  beforeEach(() => mkdirSync(tmpDir, { recursive: true }));
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  test('reads .md files from skills directory', () => {
    writeFileSync(join(tmpDir, 'skill1.md'), 'skill one');
    writeFileSync(join(tmpDir, 'skill2.md'), 'skill two');
    writeFileSync(join(tmpDir, 'readme.txt'), 'not a skill');
    const skills = loadSkills(tmpDir);
    expect(skills).toHaveLength(2);
    expect(skills).toContain('skill one');
    expect(skills).toContain('skill two');
  });

  test('returns empty array when directory does not exist', () => {
    expect(loadSkills('/nonexistent/path')).toEqual([]);
  });
});
