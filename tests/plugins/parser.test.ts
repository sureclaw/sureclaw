import { describe, it, expect } from 'vitest';
import { parsePluginManifest, parsePluginBundle } from '../../src/plugins/parser.js';

describe('parsePluginManifest', () => {
  it('parses a valid plugin.json', () => {
    const raw = { name: 'sales', version: '1.2.0', description: 'Sales plugin', author: { name: 'Anthropic' } };
    const result = parsePluginManifest(raw);
    expect(result.name).toBe('sales');
    expect(result.version).toBe('1.2.0');
    expect(result.description).toBe('Sales plugin');
    expect(result.author).toBe('Anthropic');
  });

  it('rejects manifest without name', () => {
    expect(() => parsePluginManifest({ version: '1.0.0', description: 'x' })).toThrow();
  });

  it('rejects manifest without version', () => {
    expect(() => parsePluginManifest({ name: 'x', description: 'x' })).toThrow();
  });
});

describe('parsePluginBundle', () => {
  it('extracts skills from skills/ directory', () => {
    const files = new Map<string, string>([
      ['.claude-plugin/plugin.json', JSON.stringify({ name: 'sales', version: '1.0.0', description: 'Sales' })],
      ['skills/call-prep/SKILL.md', '# Call Prep\nPrepare for sales calls.'],
      ['skills/account-research/SKILL.md', '# Account Research\nResearch accounts.'],
    ]);
    const bundle = parsePluginBundle(files);
    expect(bundle.skills).toHaveLength(2);
    expect(bundle.skills.map(s => s.name)).toContain('call-prep');
    expect(bundle.skills.map(s => s.name)).toContain('account-research');
  });

  it('extracts commands from commands/ directory', () => {
    const files = new Map<string, string>([
      ['.claude-plugin/plugin.json', JSON.stringify({ name: 'sales', version: '1.0.0', description: 'Sales' })],
      ['commands/forecast.md', '# /forecast\nGenerate weighted sales forecast.'],
    ]);
    const bundle = parsePluginBundle(files);
    expect(bundle.commands).toHaveLength(1);
    expect(bundle.commands[0].name).toBe('forecast');
  });

  it('extracts MCP servers from .mcp.json', () => {
    const files = new Map<string, string>([
      ['.claude-plugin/plugin.json', JSON.stringify({ name: 'sales', version: '1.0.0', description: 'Sales' })],
      ['.mcp.json', JSON.stringify({ mcpServers: { slack: { type: 'http', url: 'https://mcp.slack.com/mcp' } } })],
    ]);
    const bundle = parsePluginBundle(files);
    expect(bundle.mcpServers).toHaveLength(1);
    expect(bundle.mcpServers[0].name).toBe('slack');
    expect(bundle.mcpServers[0].url).toBe('https://mcp.slack.com/mcp');
  });

  it('ignores CONNECTORS.md and README.md', () => {
    const files = new Map<string, string>([
      ['.claude-plugin/plugin.json', JSON.stringify({ name: 'sales', version: '1.0.0', description: 'Sales' })],
      ['CONNECTORS.md', '# Connectors\nHuman docs only.'],
      ['README.md', '# Sales Plugin\nHuman docs.'],
    ]);
    const bundle = parsePluginBundle(files);
    expect(bundle.skills).toEqual([]);
    expect(bundle.commands).toEqual([]);
    expect(bundle.mcpServers).toEqual([]);
  });

  it('returns empty arrays when optional sections are missing', () => {
    const files = new Map<string, string>([
      ['.claude-plugin/plugin.json', JSON.stringify({ name: 'minimal', version: '1.0.0', description: 'Minimal' })],
    ]);
    const bundle = parsePluginBundle(files);
    expect(bundle.skills).toEqual([]);
    expect(bundle.commands).toEqual([]);
    expect(bundle.mcpServers).toEqual([]);
  });

  it('throws when plugin.json is missing', () => {
    const files = new Map<string, string>([['skills/foo/SKILL.md', 'some skill']]);
    expect(() => parsePluginBundle(files)).toThrow(/plugin\.json/i);
  });
});
