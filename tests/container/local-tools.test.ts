import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLocalTools } from '../../src/container/local-tools.js';
import type { AgentTool } from '@mariozechner/pi-agent-core';

describe('local-tools', () => {
  let workspace: string;
  let tools: AgentTool[];

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'local-tools-test-'));
    tools = createLocalTools(workspace);
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  function findTool(name: string): AgentTool {
    const tool = tools.find((t) => t.name === name);
    if (!tool) throw new Error(`Tool not found: ${name}`);
    return tool;
  }

  test('exports bash, read_file, write_file, edit_file tools', () => {
    const names = tools.map((t) => t.name);
    expect(names).toContain('bash');
    expect(names).toContain('read_file');
    expect(names).toContain('write_file');
    expect(names).toContain('edit_file');
  });

  // ── bash ──

  test('bash: executes a command and returns output', async () => {
    const bash = findTool('bash');
    const result = await bash.execute('tc1', { command: 'echo hello' });
    expect(result.content[0]).toEqual({ type: 'text', text: expect.stringContaining('hello') });
  });

  test('bash: runs in workspace directory', async () => {
    const bash = findTool('bash');
    const result = await bash.execute('tc2', { command: 'pwd' });
    expect(result.content[0]).toEqual({ type: 'text', text: expect.stringContaining(workspace) });
  });

  test('bash: returns stderr on error', async () => {
    const bash = findTool('bash');
    const result = await bash.execute('tc3', { command: 'ls /nonexistent-path-xyz' });
    const text = result.content[0];
    expect(text.type).toBe('text');
    // Should contain some error output or exit code info
    expect((text as { type: 'text'; text: string }).text).toBeTruthy();
  });

  // ── read_file ──

  test('read_file: reads an existing file', async () => {
    writeFileSync(join(workspace, 'test.txt'), 'file content');
    const readFile = findTool('read_file');
    const result = await readFile.execute('tc4', { path: 'test.txt' });
    expect(result.content[0]).toEqual({ type: 'text', text: 'file content' });
  });

  test('read_file: returns error for missing file', async () => {
    const readFile = findTool('read_file');
    const result = await readFile.execute('tc5', { path: 'no-such-file.txt' });
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).toMatch(/error|not found|no such/i);
  });

  test('read_file: blocks path traversal', async () => {
    const readFile = findTool('read_file');
    const result = await readFile.execute('tc6', { path: '../../../etc/passwd' });
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).toMatch(/error|denied|blocked|outside/i);
  });

  // ── write_file ──

  test('write_file: creates a new file', async () => {
    const writeFile = findTool('write_file');
    const result = await writeFile.execute('tc7', { path: 'new.txt', content: 'new content' });
    expect((result.content[0] as { type: 'text'; text: string }).text).toMatch(/written|created|success/i);
    expect(readFileSync(join(workspace, 'new.txt'), 'utf-8')).toBe('new content');
  });

  test('write_file: blocks path traversal', async () => {
    const writeFile = findTool('write_file');
    const result = await writeFile.execute('tc8', { path: '../../escape.txt', content: 'bad' });
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).toMatch(/error|denied|blocked|outside/i);
  });

  // ── edit_file ──

  test('edit_file: replaces text in a file', async () => {
    writeFileSync(join(workspace, 'edit.txt'), 'hello world');
    const editFile = findTool('edit_file');
    const result = await editFile.execute('tc9', {
      path: 'edit.txt',
      old_string: 'hello',
      new_string: 'goodbye',
    });
    expect((result.content[0] as { type: 'text'; text: string }).text).toMatch(/edited|replaced|success/i);
    expect(readFileSync(join(workspace, 'edit.txt'), 'utf-8')).toBe('goodbye world');
  });

  test('edit_file: returns error when old_string not found', async () => {
    writeFileSync(join(workspace, 'edit2.txt'), 'hello world');
    const editFile = findTool('edit_file');
    const result = await editFile.execute('tc10', {
      path: 'edit2.txt',
      old_string: 'xyz',
      new_string: 'abc',
    });
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).toMatch(/error|not found/i);
  });
});
