/**
 * Populate a per-session `ToolCatalog` from the agent's active skill snapshot
 * by walking each skill's declared MCP servers, fetching their advertised
 * tools via the injected MCP client factory, and registering the mapped
 * `CatalogTool` entries. Sibling of `mcp-registry-sync.ts`, which handles
 * the server-endpoint registry; this file handles the catalog that the
 * unified tool router + renderer will read from.
 *
 * Shape:
 *   - `skills` — the `SkillSnapshotEntry[]` from `loadSnapshot`. Entries with
 *     `ok: false` are skipped (no frontmatter to walk).
 *   - `getMcpClient(skill, serverName)` — caller-supplied factory. Real wiring
 *     passes a closure over `McpConnectionManager`; unit tests pass a vi.fn().
 *     The returned object must have `.listTools()` that resolves to
 *     `Array<{name, description?, inputSchema?}>`.
 *   - `catalog` — the `ToolCatalog` instance to populate. This function does
 *     NOT freeze the catalog; that is the session lifecycle's job.
 *
 * Per-server failures are swallowed and logged — one flaky server must not
 * poison an agent's whole tool catalog. Matches the philosophy of
 * `McpConnectionManager.discoverAllTools` which also runs best-effort.
 */

import { getLogger } from '../../logger.js';
import { buildMcpCatalogTools } from '../tool-catalog/adapters/mcp.js';
import type { ToolCatalog } from '../tool-catalog/registry.js';
import type { SkillMcpServer } from '../../skills/frontmatter-schema.js';
import type { SkillSnapshotEntry } from './types.js';

const logger = getLogger().child({ component: 'catalog-population' });

/** Minimal shape the caller's MCP client must expose — `listTools` only. */
export interface CatalogMcpClient {
  listTools(): Promise<Array<{
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
  }>>;
}

export interface PopulateCatalogFromSkillsInput {
  /** The agent's live skill snapshot. Invalid entries (`ok: false`) are skipped. */
  skills: SkillSnapshotEntry[];
  /** Factory that returns a listTools-capable MCP client for the given
   *  (skill, serverName). Called once per declared server. */
  getMcpClient(skillName: string, serverName: string): CatalogMcpClient;
  /** Destination catalog. Mutated in place. Not frozen by this function — the
   *  caller (session bootstrap) is responsible for `catalog.freeze()`. */
  catalog: ToolCatalog;
}

/**
 * Count of per-server failures during a build. `serverFailures > 0` means
 * the resulting catalog is PARTIAL — at least one declared MCP server
 * failed `listTools`. Callers should NOT cache a partial result: a
 * transient 401 / 5xx would otherwise stick as "no tools" for the agent
 * until HEAD sha changes. The sibling `getOrBuildCatalog` helper
 * consumes this to skip its cache write.
 */
export interface PopulateCatalogResult {
  /** Number of servers whose `listTools` threw. `catalog_populate_server_failed`
   *  fired once per. */
  serverFailures: number;
  /** Number of individual tools that failed `catalog.register` (duplicate
   *  names across skills). Separate counter because "some tools skipped
   *  due to dupes" is a deterministic, cache-safe outcome — we've picked
   *  a winner and we don't want to keep rebuilding forever. */
  toolRegisterFailures: number;
}

export async function populateCatalogFromSkills(
  input: PopulateCatalogFromSkillsInput,
): Promise<PopulateCatalogResult> {
  const { skills, getMcpClient, catalog } = input;
  let serverFailures = 0;
  let toolRegisterFailures = 0;

  for (const entry of skills) {
    // Skip parse-failure entries (`ok: false`); entries with `ok: true` or
    // an absent `ok` field (test fixtures) both have a frontmatter object.
    if (entry.ok === false) continue;
    const frontmatter = (entry as { frontmatter?: { mcpServers?: SkillMcpServer[] } }).frontmatter;
    const servers = frontmatter?.mcpServers ?? [];
    for (const server of servers) {
      try {
        const client = getMcpClient(entry.name, server.name);
        const mcpTools = await client.listTools();
        const catalogTools = buildMcpCatalogTools({
          skill: entry.name,
          server: server.name,
          tools: mcpTools,
          include: server.include,
          exclude: server.exclude,
        });
        for (const tool of catalogTools) {
          try {
            catalog.register(tool);
          } catch (err) {
            // Duplicate name (same tool from two skills, or a hand-assembled
            // clash) — log and keep going. Later registrants lose, which is
            // deterministic because snapshot iteration order is stable.
            toolRegisterFailures += 1;
            logger.warn('catalog_register_failed', {
              skill: entry.name,
              server: server.name,
              tool: tool.name,
              error: (err as Error).message,
            });
          }
        }
      } catch (err) {
        // One bad server (network, auth, malformed listTools) does not
        // break the rest — agent gets a partial catalog this turn. The
        // caller is responsible for NOT caching a partial result so the
        // next turn retries; otherwise a transient 401 sticks forever.
        serverFailures += 1;
        logger.warn('catalog_populate_server_failed', {
          skill: entry.name,
          server: server.name,
          error: (err as Error).message,
        });
      }
    }
  }

  return { serverFailures, toolRegisterFailures };
}
