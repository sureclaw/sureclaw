/**
 * Shared catalog-tool types for the tool-dispatch-unification work.
 *
 * This file lives in `src/types/` so both host and agent can import it.
 * The agent MUST NOT import from `src/host/`, so the type definition lives
 * here and host-side files just re-export from `src/host/tool-catalog/types.ts`
 * for backward-compat with existing host callers.
 *
 * Pure dependency: `zod`. No host/agent imports.
 */
import { z } from 'zod';

const JsonSchemaLiteral = z.record(z.string(), z.unknown());

const McpDispatch = z.object({
  kind: z.literal('mcp'),
  server: z.string().min(1),
  toolName: z.string().min(1),
});

const OpenApiDispatch = z.object({
  kind: z.literal('openapi'),
  baseUrl: z.string().url(),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  path: z.string().min(1),
  operationId: z.string().min(1),
  credential: z.string().optional(),
  authScheme: z.enum(['bearer', 'basic', 'api_key_header', 'api_key_query']).optional(),
});

export const CatalogToolSchema = z.object({
  name: z.string().regex(/^(mcp|api)_[a-z0-9_]+$/),
  skill: z.string().min(1),
  summary: z.string().min(1),
  schema: JsonSchemaLiteral,
  dispatch: z.discriminatedUnion('kind', [McpDispatch, OpenApiDispatch]),
}).strict();

export type CatalogTool = z.infer<typeof CatalogToolSchema>;

export function validateCatalogTool(input: unknown): CatalogTool {
  return CatalogToolSchema.parse(input);
}
