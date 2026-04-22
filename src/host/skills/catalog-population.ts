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

import type { OpenAPIV3 } from 'openapi-types';
import { getLogger } from '../../logger.js';
import { buildMcpCatalogTools } from '../tool-catalog/adapters/mcp.js';
import { buildOpenApiCatalogTools } from '../tool-catalog/adapters/openapi.js';
import type { ToolCatalog } from '../tool-catalog/registry.js';
import type { SkillMcpServer, SkillOpenApiSource } from '../../skills/frontmatter-schema.js';
import type { DiagnosticCollector } from '../diagnostics.js';
import type { SkillSnapshotEntry } from './types.js';

const logger = getLogger().child({ component: 'catalog-population' });

/** Thresholds for the wide-surface advisory. A skill author who leaves
 *  `include:` off for a server/source that exceeds the threshold gets an
 *  informational diagnostic nudging them to scope the surface. The
 *  numbers come from the tool-dispatch-unification plan — proportionally
 *  higher for OpenAPI since REST specs tend to be chunkier than MCP
 *  servers, and an unfiltered catalog bloats prompt budget on every turn. */
export const WIDE_MCP_THRESHOLD = 20;
export const WIDE_OPENAPI_THRESHOLD = 30;

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
  /** Factory that fetches + dereferences an OpenAPI v3 spec. Returns the
   *  resolved document; throws on fetch/parse failure or unsupported spec
   *  version (v2). Called once per declared `openapi[]` source. Real wiring
   *  in `server-completions.ts` passes a closure built by
   *  `makeDefaultFetchOpenApiSpec` (see `openapi-spec-fetcher.ts`); unit
   *  tests pass a `vi.fn()` with a pre-built `OpenAPIV3.Document`.
   *
   *  Required — symmetry with `getMcpClient`. A missing factory on a skill
   *  with `openapi[]` would surface as a silent runtime failure (every
   *  openapi-declaring skill produces zero tools + one log line); the
   *  compile-time guarantee is worth more than the test-fixture cost. For
   *  tests that don't exercise the openapi path, pass a throwing stub —
   *  the type-checker keeps the wiring honest, the stub never fires. */
  fetchOpenApiSpec(
    skillName: string,
    source: SkillOpenApiSource,
  ): Promise<OpenAPIV3.Document>;
  /** Destination catalog. Mutated in place. Not frozen by this function — the
   *  caller (session bootstrap) is responsible for `catalog.freeze()`. */
  catalog: ToolCatalog;
  /** Optional per-turn diagnostic collector. When present, user-surfacable
   *  failures (MCP listTools rejections, OpenAPI spec fetch/parse failures)
   *  are ALSO pushed here as structured diagnostics so the chat UI can
   *  render them as a banner. Log lines stay exactly as they are — this is
   *  a parallel signal, not a replacement. Optional because unit tests
   *  don't all need one, and because a host without diagnostics wiring
   *  should still function. Tool-register duplicate-name failures are
   *  deliberately NOT pushed — that's a skill-author concern, not
   *  end-user-actionable. */
  diagnostics?: DiagnosticCollector;
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
  /** Number of `openapi[]` sources whose fetch/parse/dereference threw
   *  (including v2 rejection). `catalog_populate_openapi_parse_failed`
   *  fired once per. Same cache-safety story as `serverFailures`: a
   *  partial build must NOT be cached, or a transient network hiccup
   *  sticks as "no tools" until HEAD changes. Counted separately from
   *  `serverFailures` because MCP and OpenAPI have distinct debugging
   *  paths and mixing the counters makes partial-build logs less useful. */
  openApiSourceFailures: number;
  /** Number of individual tools that failed `catalog.register` (duplicate
   *  names across skills). Separate counter because "some tools skipped
   *  due to dupes" is a deterministic, cache-safe outcome — we've picked
   *  a winner and we don't want to keep rebuilding forever. */
  toolRegisterFailures: number;
}

export async function populateCatalogFromSkills(
  input: PopulateCatalogFromSkillsInput,
): Promise<PopulateCatalogResult> {
  const { skills, getMcpClient, fetchOpenApiSpec, catalog, diagnostics } = input;
  let serverFailures = 0;
  let openApiSourceFailures = 0;
  let toolRegisterFailures = 0;

  for (const entry of skills) {
    // Skip parse-failure entries (`ok: false`); entries with `ok: true` or
    // an absent `ok` field (test fixtures) both have a frontmatter object.
    if (entry.ok === false) continue;
    const frontmatter = (entry as {
      frontmatter?: { mcpServers?: SkillMcpServer[]; openapi?: SkillOpenApiSource[] };
    }).frontmatter;
    const servers = frontmatter?.mcpServers ?? [];
    const sources = frontmatter?.openapi ?? [];

    for (const server of servers) {
      try {
        const client = getMcpClient(entry.name, server.name);
        const mcpTools = await client.listTools();
        // Wide-surface advisory: a server that exposes >20 tools without
        // any `include:` filter bloats the catalog + prompt budget for
        // every turn this skill is active. Surface an informational
        // diagnostic so the skill author can scope. Exclude-only skills
        // still count as unscoped (the author may have removed a few
        // mutations but kept 40 read-ops; they probably still want a
        // stricter include). Does NOT affect population — the catalog
        // still gets every tool; this is purely an advisory nudge.
        if (mcpTools.length > WIDE_MCP_THRESHOLD && !server.include) {
          diagnostics?.push({
            severity: 'info',
            kind: 'catalog_wide_mcp_server',
            message:
              `Skill "${entry.name}" MCP server "${server.name}" exposes ` +
              `${mcpTools.length} tools without an \`include:\` filter. ` +
              `Consider scoping the surface in the skill's frontmatter to ` +
              `keep the prompt budget small and the LLM focused.`,
            context: {
              skill: entry.name,
              server: server.name,
              toolCount: mcpTools.length,
            },
          });
        }
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
        const errMessage = (err as Error).message;
        logger.warn('catalog_populate_server_failed', {
          skill: entry.name,
          server: server.name,
          error: errMessage,
        });
        // Parallel user-facing signal: the log line is for host operators,
        // the diagnostic is for the end user who'd otherwise see "my skill
        // just stopped working" with no hint why.
        diagnostics?.push({
          severity: 'warn',
          kind: 'catalog_populate_server_failed',
          message: `Skill "${entry.name}" MCP server "${server.name}" failed to list tools: ${errMessage}`,
          context: {
            skill: entry.name,
            server: server.name,
            error: errMessage,
          },
        });
      }
    }

    // ── OpenAPI sources ── parallel to the MCP loop. Each source's fetch
    // and parse is isolated: a bad spec (network timeout, v2 rejection,
    // traversal attempt on a workspace-relative path) counts as one
    // `openApiSourceFailures` and does NOT abort the rest of the skill's
    // sources or the rest of the snapshot. Duplicate tool names (two
    // sources that both produce `api_<skill>_<op>`) count as
    // `toolRegisterFailures`, same cache-safety story as the MCP loop.
    for (const source of sources) {
      try {
        const spec = await fetchOpenApiSpec(entry.name, source);
        const catalogTools = buildOpenApiCatalogTools({
          skill: entry.name,
          spec,
          baseUrl: source.baseUrl,
          auth: source.auth,
          include: source.include,
          exclude: source.exclude,
        });
        // Wide-surface advisory (parallel to the MCP threshold, higher
        // cutoff because OpenAPI specs tend to be chunkier than MCP
        // servers). `!source.include` means the author relied on the
        // spec's full surface — nudge them to scope it. When include is
        // set, trust the author's choice even if the resulting set is
        // still large.
        if (catalogTools.length > WIDE_OPENAPI_THRESHOLD && !source.include) {
          diagnostics?.push({
            severity: 'info',
            kind: 'catalog_wide_openapi_source',
            message:
              `Skill "${entry.name}" OpenAPI source "${source.spec}" ` +
              `exposes ${catalogTools.length} operations without an ` +
              `\`include:\` filter. Consider scoping the surface in the ` +
              `skill's frontmatter to keep the prompt budget small and ` +
              `the LLM focused.`,
            context: {
              skill: entry.name,
              source: source.spec,
              operationCount: catalogTools.length,
            },
          });
        }
        for (const tool of catalogTools) {
          try {
            catalog.register(tool);
          } catch (err) {
            toolRegisterFailures += 1;
            logger.warn('catalog_register_failed', {
              skill: entry.name,
              source: source.spec,
              tool: tool.name,
              error: (err as Error).message,
            });
          }
        }
      } catch (err) {
        // Fetch/parse/dereference threw, or the adapter rejected v2.
        // Skill authors need the spec pointer + error message to
        // diagnose from logs alone; hence the specific event name.
        openApiSourceFailures += 1;
        const errMessage = (err as Error).message;
        logger.warn('catalog_populate_openapi_parse_failed', {
          skill: entry.name,
          source: source.spec,
          baseUrl: source.baseUrl,
          error: errMessage,
        });
        // User-facing signal: name the skill AND the spec URL in the
        // message so "petstore skill is broken because https://…/openapi.json
        // timed out" shows up in the chat UI without a log grep. Note the
        // diagnostic kind (`_openapi_source_failed`) is distinct from the
        // log event name (`_openapi_parse_failed`): the log focuses on the
        // diagnostic root cause (parse/fetch/dereference all land here),
        // the diagnostic kind matches the user's mental model ("the
        // OpenAPI source failed").
        diagnostics?.push({
          severity: 'warn',
          kind: 'catalog_populate_openapi_source_failed',
          message: `Skill "${entry.name}" OpenAPI spec "${source.spec}" failed to load: ${errMessage}`,
          context: {
            skill: entry.name,
            source: source.spec,
            error: errMessage,
          },
        });
      }
    }
  }

  return { serverFailures, openApiSourceFailures, toolRegisterFailures };
}
