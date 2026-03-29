import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fetchPluginFiles, parsePluginSource } from '../../src/plugins/fetcher.js';

describe('parsePluginSource', () => {
  it('parses GitHub org/repo/path', () => {
    const result = parsePluginSource('anthropics/knowledge-work-plugins/sales');
    expect(result.type).toBe('github');
    if (result.type === 'github') {
      expect(result.owner).toBe('anthropics');
      expect(result.repo).toBe('knowledge-work-plugins');
      expect(result.subdir).toBe('sales');
    }
  });

  it('parses GitHub org/repo (no subdir)', () => {
    const result = parsePluginSource('my-org/my-plugin');
    expect(result.type).toBe('github');
    if (result.type === 'github') {
      expect(result.owner).toBe('my-org');
      expect(result.repo).toBe('my-plugin');
      expect(result.subdir).toBeUndefined();
    }
  });

  it('parses local path starting with ./', () => {
    const result = parsePluginSource('./plugins/my-plugin');
    expect(result.type).toBe('local');
  });

  it('parses absolute path', () => {
    const result = parsePluginSource('/home/user/plugins/my-plugin');
    expect(result.type).toBe('local');
  });

  it('parses https URL', () => {
    const result = parsePluginSource('https://github.com/anthropics/knowledge-work-plugins');
    expect(result.type).toBe('url');
  });
});

describe('fetchPluginFiles (local)', () => {
  it('reads files from a local directory', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'ax-plugin-test-'));
    mkdirSync(join(tmp, '.claude-plugin'), { recursive: true });
    writeFileSync(join(tmp, '.claude-plugin', 'plugin.json'), '{"name":"test","version":"1.0.0","description":"t"}');
    mkdirSync(join(tmp, 'skills', 'foo'), { recursive: true });
    writeFileSync(join(tmp, 'skills', 'foo', 'SKILL.md'), '# Foo skill');

    const files = await fetchPluginFiles({ type: 'local', path: tmp });
    expect(files.has('.claude-plugin/plugin.json')).toBe(true);
    expect(files.has('skills/foo/SKILL.md')).toBe(true);
  });

  it('skips .git and node_modules', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'ax-plugin-test-'));
    mkdirSync(join(tmp, '.claude-plugin'), { recursive: true });
    writeFileSync(join(tmp, '.claude-plugin', 'plugin.json'), '{}');
    mkdirSync(join(tmp, '.git'), { recursive: true });
    writeFileSync(join(tmp, '.git', 'config'), 'git config');
    mkdirSync(join(tmp, 'node_modules', 'foo'), { recursive: true });
    writeFileSync(join(tmp, 'node_modules', 'foo', 'index.js'), 'module');

    const files = await fetchPluginFiles({ type: 'local', path: tmp });
    expect(files.has('.git/config')).toBe(false);
    expect(files.has('node_modules/foo/index.js')).toBe(false);
  });

  it('throws for nonexistent directory', async () => {
    await expect(fetchPluginFiles({ type: 'local', path: '/nonexistent-ax-plugin-dir' })).rejects.toThrow();
  });
});
