import { describe, it, expect } from 'vitest';
import { parseSkillFile } from '../../../src/host/skills/parser.js';

describe('parseSkillFile', () => {
  it('parses valid frontmatter and body', () => {
    const content = `---
name: linear
description: Query Linear.
domains:
  - api.linear.app
---

# Linear
Body goes here.`;
    const result = parseSkillFile(content);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.frontmatter.name).toBe('linear');
    expect(result.frontmatter.domains).toEqual(['api.linear.app']);
    expect(result.body).toContain('# Linear');
  });

  it('reports missing frontmatter', () => {
    const result = parseSkillFile('# Just a heading\nNo frontmatter.');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toMatch(/frontmatter/i);
  });

  it('reports unterminated frontmatter', () => {
    const result = parseSkillFile('---\nname: x\n# no closing ---');
    expect(result.ok).toBe(false);
  });

  it('reports invalid YAML', () => {
    const result = parseSkillFile('---\n: : : not valid\n---\n');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toMatch(/yaml/i);
  });

  it('reports schema validation errors', () => {
    const result = parseSkillFile('---\nname: x\n---\nno description');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toMatch(/description/i);
  });

  it('handles CRLF line endings', () => {
    const content = '---\r\nname: x\r\ndescription: y\r\n---\r\nbody';
    const result = parseSkillFile(content);
    expect(result.ok).toBe(true);
  });
});
