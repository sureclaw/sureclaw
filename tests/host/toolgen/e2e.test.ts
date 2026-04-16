import { describe, it, expect } from 'vitest';
import { prepareToolModules } from '../../../src/host/toolgen/generate-and-cache.js';
import { openApiToToolSchemas } from '../../../src/host/toolgen/openapi.js';
import type { McpToolSchema } from '../../../src/providers/mcp/types.js';
import { initLogger } from '../../../src/logger.js';

initLogger({ file: false, level: 'silent' });

describe('toolgen e2e', () => {
  it('MCP tools → modules + compact index', async () => {
    const mcpTools: McpToolSchema[] = [
      { name: 'list_issues', description: 'List issues', inputSchema: { type: 'object', properties: { query: { type: 'string' } } }, server: 'linear' },
      { name: 'create_issue', description: 'Create issue', inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] }, server: 'linear' },
    ];

    const result = await prepareToolModules({ agentName: 'test', tools: mcpTools });
    expect(result).not.toBeNull();

    // Module file has importable functions
    const linearModule = result!.files.find(f => f.path === 'linear.js');
    expect(linearModule).toBeDefined();
    expect(linearModule!.content).toContain('export async function listIssues');
    expect(linearModule!.content).toContain('export async function createIssue');

    // Index file exists
    const indexFile = result!.files.find(f => f.path === 'index.js');
    expect(indexFile).toBeDefined();
    expect(indexFile!.content).toContain("export * as linear from './linear.js'");

    // Compact index is prompt-ready
    expect(result!.compactIndex).toContain('linear:');
    expect(result!.compactIndex).toContain('listIssues(query?)');
    expect(result!.compactIndex).toContain('createIssue(title)');
  });

  it('OpenAPI spec → modules + compact index', async () => {
    const spec = {
      openapi: '3.0.0',
      info: { title: 'Billing', version: '1.0.0' },
      paths: {
        '/invoices': {
          get: {
            operationId: 'list_invoices',
            summary: 'List invoices',
            parameters: [{ name: 'customer', in: 'query', schema: { type: 'string' } }],
          },
        },
        '/invoices/{id}': {
          get: {
            operationId: 'get_invoice',
            summary: 'Get invoice by ID',
            parameters: [{ name: 'id', in: 'path', schema: { type: 'string' }, required: true }],
          },
        },
      },
    };

    const tools = openApiToToolSchemas(spec, 'billing');
    expect(tools).toHaveLength(2);

    const result = await prepareToolModules({ agentName: 'test', tools });
    expect(result).not.toBeNull();

    const billingModule = result!.files.find(f => f.path === 'billing.js');
    expect(billingModule).toBeDefined();
    expect(billingModule!.content).toContain('export async function listInvoices');
    expect(billingModule!.content).toContain('export async function getInvoice');
    expect(result!.compactIndex).toContain('billing:');
    expect(result!.compactIndex).toContain('listInvoices(customer?)');
    expect(result!.compactIndex).toContain('getInvoice(id)');
  });

  it('mixed MCP + OpenAPI tools in one pipeline', async () => {
    const mcpTools: McpToolSchema[] = [
      { name: 'list_issues', description: 'List issues', inputSchema: { type: 'object', properties: { query: { type: 'string' } } }, server: 'linear' },
    ];

    const apiSpec = {
      openapi: '3.0.0',
      info: { title: 'Billing', version: '1.0.0' },
      paths: {
        '/invoices': {
          get: { operationId: 'list_invoices', summary: 'List invoices', parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer' } }] },
        },
      },
    };

    const apiTools = openApiToToolSchemas(apiSpec, 'billing');
    const allTools = [...mcpTools, ...apiTools];

    const result = await prepareToolModules({ agentName: 'test', tools: allTools });
    expect(result).not.toBeNull();
    expect(result!.files.find(f => f.path === 'linear.js')).toBeTruthy();
    expect(result!.files.find(f => f.path === 'billing.js')).toBeTruthy();
    expect(result!.compactIndex).toContain('linear:');
    expect(result!.compactIndex).toContain('billing:');
  });
});
