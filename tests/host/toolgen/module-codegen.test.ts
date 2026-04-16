import { describe, it, expect } from 'vitest';
import { generateModule, generateIndex, generateCompactIndex, snakeToCamel, groupToolsByServer } from '../../../src/host/toolgen/codegen.js';
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
});

describe('generateIndex', () => {
  it('generates a barrel file re-exporting all modules', () => {
    const result = generateIndex(['linear', 'github', 'stripe']);
    expect(result).toContain("export * as linear from './linear.js'");
    expect(result).toContain("export * as github from './github.js'");
    expect(result).toContain("export * as stripe from './stripe.js'");
  });
});

describe('generateCompactIndex', () => {
  it('generates one-line-per-server compact summary', () => {
    const groups = groupToolsByServer([
      { name: 'list_issues', description: 'List issues', inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } } }, server: 'linear' },
      { name: 'create_issue', description: 'Create issue', inputSchema: { type: 'object', properties: { title: { type: 'string' }, teamId: { type: 'string' } }, required: ['title', 'teamId'] }, server: 'linear' },
    ]);
    const result = generateCompactIndex(groups);
    expect(result).toContain('linear:');
    expect(result).toContain('listIssues(query?, limit?)');
    expect(result).toContain('createIssue(title, teamId)');
  });

  it('marks required params without ? suffix', () => {
    const groups = groupToolsByServer([
      { name: 'get_invoice', description: 'Get invoice', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }, server: 'stripe' },
    ]);
    const result = generateCompactIndex(groups);
    expect(result).toContain('getInvoice(id)');
    expect(result).not.toContain('id?');
  });
});
