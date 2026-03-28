/**
 * Tests for tool stub generation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { generateToolStubs, groupToolsByServer } from '../../../src/host/capnweb/codegen.js';
import type { McpToolSchema } from '../../../src/providers/mcp/types.js';
import { initLogger } from '../../../src/logger.js';

initLogger({ file: false, level: 'silent' });

describe('groupToolsByServer', () => {
  it('should group by underscore prefix', () => {
    const groups = groupToolsByServer([
      { name: 'linear_getIssues', description: '', inputSchema: {} },
      { name: 'linear_getTeams', description: '', inputSchema: {} },
      { name: 'github_getRepo', description: '', inputSchema: {} },
    ]);
    expect(groups).toHaveLength(2);
    expect(groups.find(g => g.server === 'linear')?.tools).toHaveLength(2);
    expect(groups.find(g => g.server === 'github')?.tools).toHaveLength(1);
  });

  it('should group by slash prefix', () => {
    const groups = groupToolsByServer([
      { name: 'linear/getIssues', description: '', inputSchema: {} },
      { name: 'linear/getTeams', description: '', inputSchema: {} },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].server).toBe('linear');
  });

  it('should put unprefixed tools in default', () => {
    const groups = groupToolsByServer([
      { name: 'search', description: '', inputSchema: {} },
    ]);
    expect(groups[0].server).toBe('default');
  });
});

describe('generateToolStubs', () => {
  let tempDir: string;

  beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), 'ax-codegen-')); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it('should generate proxy-based _runtime.ts with zero deps', () => {
    const outputDir = join(tempDir, 'tools');
    generateToolStubs({ outputDir, groups: [] });

    const runtime = readFileSync(join(outputDir, '_runtime.ts'), 'utf8');
    expect(runtime).toContain('callTool');
    expect(runtime).toContain('AX_IPC_SOCKET');
    expect(runtime).toContain('tool_batch');
    expect(runtime).toContain('Proxy');
    expect(runtime).toContain('$ref');
    // No external dependencies
    expect(runtime).not.toContain('capnweb');
    expect(runtime).not.toContain('RpcSession');
  });

  it('should generate per-server tool files', () => {
    const outputDir = join(tempDir, 'tools');
    const result = generateToolStubs({
      outputDir,
      groups: [
        {
          server: 'linear',
          tools: [
            {
              name: 'getIssues',
              description: 'Get Linear issues',
              inputSchema: {
                type: 'object',
                properties: { teamId: { type: 'string' }, limit: { type: 'number' } },
                required: ['teamId'],
              },
            },
            { name: 'getTeams', description: 'Get teams', inputSchema: {} },
          ],
        },
        {
          server: 'github',
          tools: [{
            name: 'getRepository',
            description: 'Get repo',
            inputSchema: {
              type: 'object',
              properties: { owner: { type: 'string' }, name: { type: 'string' } },
              required: ['owner', 'name'],
            },
          }],
        },
      ],
    });

    expect(existsSync(join(outputDir, '_runtime.ts'))).toBe(true);
    expect(existsSync(join(outputDir, 'linear', 'getIssues.ts'))).toBe(true);
    expect(existsSync(join(outputDir, 'linear', 'getTeams.ts'))).toBe(true);
    expect(existsSync(join(outputDir, 'linear', 'index.ts'))).toBe(true);
    expect(existsSync(join(outputDir, 'github', 'getRepository.ts'))).toBe(true);

    const stub = readFileSync(join(outputDir, 'linear', 'getIssues.ts'), 'utf8');
    expect(stub).toContain('export function getIssues');
    expect(stub).toContain('teamId: string');
    expect(stub).toContain('limit?: number');
    expect(stub).toContain('callTool');

    const barrel = readFileSync(join(outputDir, 'linear', 'index.ts'), 'utf8');
    expect(barrel).toContain("export { getIssues }");
    expect(barrel).toContain("export { getTeams }");

    expect(result.toolCount).toBe(3);
  });

  it('should handle complex schemas', () => {
    const outputDir = join(tempDir, 'tools');
    generateToolStubs({
      outputDir,
      groups: [{
        server: 'api',
        tools: [{
          name: 'create',
          description: 'Create',
          inputSchema: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              tags: { type: 'array', items: { type: 'string' } },
              nested: { type: 'object', properties: { deep: { type: 'boolean' } } },
            },
            required: ['name'],
          },
        }],
      }],
    });

    const content = readFileSync(join(outputDir, 'api', 'create.ts'), 'utf8');
    expect(content).toContain('name: string');
    expect(content).toContain('tags?: Array<string>');
    expect(content).toContain('deep?: boolean');
  });

  it('should sanitize names to valid identifiers', () => {
    const outputDir = join(tempDir, 'tools');
    generateToolStubs({
      outputDir,
      groups: [{
        server: 'test',
        tools: [{ name: 'get-items', description: '', inputSchema: {} }],
      }],
    });

    expect(existsSync(join(outputDir, 'test', 'getItems.ts'))).toBe(true);
    const content = readFileSync(join(outputDir, 'test', 'getItems.ts'), 'utf8');
    expect(content).toContain('export function getItems');
  });
});
