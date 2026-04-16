/**
 * Convert an OpenAPI 3.x spec into McpToolSchema[] for the toolgen pipeline.
 *
 * Each operation (GET /invoices, POST /invoices, etc.) becomes one tool.
 * Query/path parameters + request body properties become the tool's inputSchema.
 */

import type { McpToolSchema } from '../../providers/mcp/types.js';

interface OpenApiSpec {
  paths: Record<string, Record<string, OpenApiOperation>>;
  [key: string]: unknown;
}

interface OpenApiOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  parameters?: OpenApiParam[];
  requestBody?: { content?: { 'application/json'?: { schema?: JsonSchema } } };
}

interface OpenApiParam {
  name: string;
  in: string;
  description?: string;
  required?: boolean;
  schema?: { type?: string; [key: string]: unknown };
}

interface JsonSchema {
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

/**
 * Generate an operationId from HTTP method + path when none is provided.
 * GET /users/{id} → getUsers_id
 */
function inferOperationId(method: string, path: string): string {
  const cleaned = path
    .replace(/\{([^}]+)\}/g, '_$1')
    .replace(/[^a-zA-Z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  return `${method}${cleaned.charAt(0).toUpperCase()}${cleaned.slice(1)}`;
}

export function openApiToToolSchemas(spec: OpenApiSpec, serverName: string): McpToolSchema[] {
  const tools: McpToolSchema[] = [];

  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const method of HTTP_METHODS) {
      const op = methods[method] as OpenApiOperation | undefined;
      if (!op) continue;

      const name = op.operationId ?? inferOperationId(method, path);
      const description = op.summary ?? op.description ?? `${method.toUpperCase()} ${path}`;

      // Merge parameters + request body into one inputSchema
      const properties: Record<string, unknown> = {};
      const required: string[] = [];

      // Query/path parameters
      for (const param of op.parameters ?? []) {
        properties[param.name] = {
          type: param.schema?.type ?? 'string',
          ...(param.description ? { description: param.description } : {}),
        };
        if (param.required) required.push(param.name);
      }

      // Request body (JSON)
      const bodySchema = op.requestBody?.content?.['application/json']?.schema;
      if (bodySchema?.properties) {
        Object.assign(properties, bodySchema.properties);
        if (bodySchema.required) required.push(...bodySchema.required);
      }

      tools.push({
        name,
        description,
        server: serverName,
        inputSchema: {
          type: 'object',
          properties,
          ...(required.length > 0 ? { required } : {}),
        },
      });
    }
  }

  return tools;
}
