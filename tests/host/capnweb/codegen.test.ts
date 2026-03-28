/**
 * Tests for Cap'n Web TypeScript stub generation.
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
  it('should group tools by underscore-separated prefix', () => {
    const tools: McpToolSchema[] = [
      { name: 'linear_getIssues', description: 'Get issues', inputSchema: {} },
      { name: 'linear_getTeams', description: 'Get teams', inputSchema: {} },
      { name: 'github_getRepository', description: 'Get repo', inputSchema: {} },
    ];

    const groups = groupToolsByServer(tools);

    expect(groups).toHaveLength(2);
    const linear = groups.find((g) => g.server === 'linear');
    const github = groups.find((g) => g.server === 'github');
    expect(linear?.tools).toHaveLength(2);
    expect(github?.tools).toHaveLength(1);
  });

  it('should group tools by slash-separated prefix', () => {
    const tools: McpToolSchema[] = [
      { name: 'linear/getIssues', description: 'Get issues', inputSchema: {} },
      { name: 'linear/getTeams', description: 'Get teams', inputSchema: {} },
    ];

    const groups = groupToolsByServer(tools);
    expect(groups).toHaveLength(1);
    expect(groups[0].server).toBe('linear');
    expect(groups[0].tools).toHaveLength(2);
  });

  it('should put unprefixed tools in default group', () => {
    const tools: McpToolSchema[] = [
      { name: 'search', description: 'Search', inputSchema: {} },
    ];

    const groups = groupToolsByServer(tools);
    expect(groups[0].server).toBe('default');
  });
});

describe('generateToolStubs', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'ax-codegen-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should generate _runtime.ts with socket path', () => {
    const outputDir = join(tempDir, 'tools');
    generateToolStubs({
      outputDir,
      groups: [],
      socketPath: '/tmp/test.sock',
    });

    const runtime = readFileSync(join(outputDir, '_runtime.ts'), 'utf8');
    expect(runtime).toContain('/tmp/test.sock');
    expect(runtime).toContain('RpcSession');
    expect(runtime).toContain('SocketRpcTransport');
    expect(runtime).toContain('export const tools');
  });

  it('should generate per-server directories with tool files', () => {
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
                properties: {
                  teamId: { type: 'string' },
                  limit: { type: 'number' },
                },
                required: ['teamId'],
              },
            },
            {
              name: 'getTeams',
              description: 'Get Linear teams',
              inputSchema: { type: 'object', properties: {} },
            },
          ],
        },
        {
          server: 'github',
          tools: [
            {
              name: 'getRepository',
              description: 'Get GitHub repository',
              inputSchema: {
                type: 'object',
                properties: {
                  owner: { type: 'string' },
                  name: { type: 'string' },
                },
                required: ['owner', 'name'],
              },
            },
          ],
        },
      ],
      socketPath: '/tmp/capnweb.sock',
    });

    // Verify file structure
    expect(existsSync(join(outputDir, '_runtime.ts'))).toBe(true);
    expect(existsSync(join(outputDir, 'linear', 'getIssues.ts'))).toBe(true);
    expect(existsSync(join(outputDir, 'linear', 'getTeams.ts'))).toBe(true);
    expect(existsSync(join(outputDir, 'linear', 'index.ts'))).toBe(true);
    expect(existsSync(join(outputDir, 'github', 'getRepository.ts'))).toBe(true);
    expect(existsSync(join(outputDir, 'github', 'index.ts'))).toBe(true);

    // Verify tool stub content
    const getIssues = readFileSync(join(outputDir, 'linear', 'getIssues.ts'), 'utf8');
    expect(getIssues).toContain('export function getIssues');
    expect(getIssues).toContain('teamId: string');
    expect(getIssues).toContain('limit?: number');
    expect(getIssues).toContain("tools.getIssues(params)");
    expect(getIssues).toContain('MCP server: linear');

    // Verify barrel export
    const barrel = readFileSync(join(outputDir, 'linear', 'index.ts'), 'utf8');
    expect(barrel).toContain("export { getIssues } from './getIssues.js'");
    expect(barrel).toContain("export { getTeams } from './getTeams.js'");

    // Verify metadata
    expect(result.toolCount).toBe(3);
    expect(result.files.length).toBeGreaterThan(3); // runtime + stubs + barrels
  });

  it('should handle complex input schemas', () => {
    const outputDir = join(tempDir, 'tools');
    generateToolStubs({
      outputDir,
      groups: [
        {
          server: 'api',
          tools: [
            {
              name: 'createItem',
              description: 'Create an item',
              inputSchema: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  tags: { type: 'array', items: { type: 'string' } },
                  nested: {
                    type: 'object',
                    properties: {
                      deep: { type: 'boolean' },
                    },
                  },
                },
                required: ['name'],
              },
            },
          ],
        },
      ],
      socketPath: '/tmp/capnweb.sock',
    });

    const content = readFileSync(join(outputDir, 'api', 'createItem.ts'), 'utf8');
    expect(content).toContain('name: string');
    expect(content).toContain('tags?: Array<string>');
    expect(content).toContain('deep?: boolean');
  });

  it('should sanitize tool names to valid TS identifiers', () => {
    const outputDir = join(tempDir, 'tools');
    generateToolStubs({
      outputDir,
      groups: [
        {
          server: 'test',
          tools: [
            {
              name: 'get-items',
              description: 'Hyphenated name',
              inputSchema: {},
            },
          ],
        },
      ],
      socketPath: '/tmp/capnweb.sock',
    });

    // Hyphen converted to camelCase
    expect(existsSync(join(outputDir, 'test', 'getItems.ts'))).toBe(true);
    const content = readFileSync(join(outputDir, 'test', 'getItems.ts'), 'utf8');
    expect(content).toContain('export function getItems');
  });
});
