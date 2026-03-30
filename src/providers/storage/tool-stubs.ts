/**
 * Tool stub CRUD operations for database-cached generated stubs.
 *
 * Stubs are generated from MCP tool schemas and cached in DocumentStore.
 * On sandbox spin-up, the host loads cached stubs and sends them via
 * stdin payload (same flow as skills). The agent runner writes them to
 * /tools/ in the workspace.
 *
 * Collection: 'tool-stubs'
 * Key format: '{agentName}'
 * Value: JSON ToolStubCache
 *
 * Regeneration is triggered when the schema hash changes (MCP tools
 * added/removed, tool schemas updated, skill install adds new tools).
 */

import { createHash } from 'node:crypto';
import type { DocumentStore } from './types.js';
import type { McpToolSchema } from '../mcp/types.js';

export interface ToolStubFile {
  path: string;
  content: string;
}

export interface ToolStubCache {
  /** SHA-256 of the canonical tool schema JSON. */
  schemaHash: string;
  /** Generated TypeScript files. */
  files: ToolStubFile[];
  /** ISO timestamp of generation. */
  generatedAt: string;
}

/**
 * Compute a deterministic hash of MCP tool schemas.
 * Used to detect when stubs need regeneration.
 */
export function computeSchemaHash(tools: McpToolSchema[]): string {
  // Sort by server+name for determinism, then hash the canonical JSON
  const sorted = [...tools].sort((a, b) =>
    (`${a.server ?? ''}:${a.name}`).localeCompare(`${b.server ?? ''}:${b.name}`)
  );
  const canonical = JSON.stringify(sorted.map(t => ({
    server: t.server,
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  })));
  return createHash('sha256').update(canonical).digest('hex');
}

export async function getToolStubs(
  documents: DocumentStore,
  agentName: string,
): Promise<ToolStubCache | null> {
  const raw = await documents.get('tool-stubs', agentName);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof (parsed as any).schemaHash !== 'string' ||
      typeof (parsed as any).generatedAt !== 'string' ||
      !Array.isArray((parsed as any).files)
    ) return null;
    return parsed as ToolStubCache;
  } catch {
    return null;
  }
}

export async function putToolStubs(
  documents: DocumentStore,
  agentName: string,
  cache: ToolStubCache,
): Promise<void> {
  await documents.put('tool-stubs', agentName, JSON.stringify(cache));
}

/**
 * Get cached stubs if the schema hash matches, or return null to
 * signal that regeneration is needed.
 */
export async function getCachedOrNull(
  documents: DocumentStore,
  agentName: string,
  currentHash: string,
): Promise<ToolStubCache | null> {
  const cached = await getToolStubs(documents, agentName);
  if (cached && cached.schemaHash === currentHash) return cached;
  return null;
}
