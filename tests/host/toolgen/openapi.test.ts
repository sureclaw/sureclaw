import { describe, it, expect } from 'vitest';
import { openApiToToolSchemas } from '../../../src/host/toolgen/openapi.js';
import { initLogger } from '../../../src/logger.js';

initLogger({ file: false, level: 'silent' });

describe('openApiToToolSchemas', () => {
  it('converts GET endpoints to tool schemas', () => {
    const spec = {
      openapi: '3.0.0',
      info: { title: 'Billing API', version: '1.0.0' },
      paths: {
        '/invoices': {
          get: {
            operationId: 'listInvoices',
            summary: 'List all invoices',
            parameters: [
              { name: 'customer', in: 'query', schema: { type: 'string' }, description: 'Filter by customer' },
              { name: 'limit', in: 'query', schema: { type: 'integer' }, description: 'Max results' },
            ],
          },
        },
      },
    };

    const tools = openApiToToolSchemas(spec, 'billing');
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('listInvoices');
    expect(tools[0].server).toBe('billing');
    expect(tools[0].description).toBe('List all invoices');
    expect(tools[0].inputSchema.properties).toHaveProperty('customer');
    expect(tools[0].inputSchema.properties).toHaveProperty('limit');
  });

  it('converts POST endpoints with request body', () => {
    const spec = {
      openapi: '3.0.0',
      info: { title: 'API', version: '1.0.0' },
      paths: {
        '/invoices': {
          post: {
            operationId: 'createInvoice',
            summary: 'Create invoice',
            requestBody: {
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      customer: { type: 'string' },
                      amount: { type: 'number' },
                    },
                    required: ['customer', 'amount'],
                  },
                },
              },
            },
          },
        },
      },
    };

    const tools = openApiToToolSchemas(spec, 'billing');
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('createInvoice');
    expect(tools[0].inputSchema.required).toEqual(['customer', 'amount']);
  });

  it('generates operationId from method + path when missing', () => {
    const spec = {
      openapi: '3.0.0',
      info: { title: 'API', version: '1.0.0' },
      paths: {
        '/users/{id}': {
          get: { summary: 'Get user by ID', parameters: [{ name: 'id', in: 'path', schema: { type: 'string' }, required: true }] },
        },
      },
    };

    const tools = openApiToToolSchemas(spec, 'users');
    expect(tools[0].name).toMatch(/get.*user/i);
  });
});
