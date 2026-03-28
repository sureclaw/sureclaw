/**
 * Orchestrates tool stub generation with DB caching.
 *
 * Called when preparing a sandbox. If the agent's MCP tool schemas haven't
 * changed (same hash), returns cached stubs from DB. Otherwise regenerates,
 * caches, and returns.
 *
 * The returned files are sent via stdin payload (same as skills) and written
 * to /tools/ in the agent workspace by applyPayload().
 */

import { tmpdir } from 'node:os';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { DocumentStore } from '../../providers/storage/types.js';
import type { McpToolSchema } from '../../providers/mcp/types.js';
import {
  computeSchemaHash,
  getCachedOrNull,
  putToolStubs,
  type ToolStubFile,
  type ToolStubCache,
} from '../../providers/storage/tool-stubs.js';
import { generateToolStubs, groupToolsByServer } from './codegen.js';
import { getLogger } from '../../logger.js';

const logger = getLogger().child({ component: 'tool-stubs' });

export interface PrepareToolStubsOptions {
  /** DocumentStore for caching (may be absent in local dev). */
  documents?: DocumentStore;
  /** Agent name for cache key scoping. */
  agentName: string;
  /** MCP tools configured for this agent. */
  tools: McpToolSchema[];
}

/**
 * Get or generate tool stubs for an agent's configured MCP tools.
 *
 * Returns null if no tools are configured.
 */
export async function prepareToolStubs(
  opts: PrepareToolStubsOptions,
): Promise<ToolStubFile[] | null> {
  const { documents, agentName, tools } = opts;

  if (tools.length === 0) return null;

  const hash = computeSchemaHash(tools);

  // Try cache first
  if (documents) {
    const cached = await getCachedOrNull(documents, agentName, hash);
    if (cached) {
      logger.debug('tool_stubs_cache_hit', { agentName, hash: hash.slice(0, 8), fileCount: cached.files.length });
      return cached.files;
    }
  }

  // Generate into temp dir, read back as file array
  logger.info('tool_stubs_generating', { agentName, toolCount: tools.length });
  const tempDir = mkdtempSync(join(tmpdir(), 'ax-tool-stubs-'));
  try {
    const groups = groupToolsByServer(tools);
    await generateToolStubs({ outputDir: tempDir, groups });

    // Collect all generated files
    const files = collectFiles(tempDir);

    // Cache for next time
    if (documents) {
      const cache: ToolStubCache = {
        schemaHash: hash,
        files,
        generatedAt: new Date().toISOString(),
      };
      await putToolStubs(documents, agentName, cache);
      logger.debug('tool_stubs_cached', { agentName, hash: hash.slice(0, 8), fileCount: files.length });
    }

    return files;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

/** Recursively collect all files in a directory as { path, content } pairs. */
function collectFiles(dir: string): ToolStubFile[] {
  const { readdirSync, statSync } = require('node:fs') as typeof import('node:fs');
  const files: ToolStubFile[] = [];

  function walk(current: string) {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else {
        files.push({
          path: relative(dir, full),
          content: readFileSync(full, 'utf8'),
        });
      }
    }
  }

  walk(dir);
  return files;
}
