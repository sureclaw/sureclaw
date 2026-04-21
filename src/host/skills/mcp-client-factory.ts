/**
 * Build the `getMcpClient` closure that `populateCatalogFromSkills` needs,
 * closed over the per-turn snapshot + host-side dependencies. Extracted from
 * `processCompletion` so the orchestration there stays readable and the
 * closure is independently unit-testable.
 *
 * Design:
 *   - URL lookup is O(1) — a `Map<serverName, url>` is built once at factory
 *     construction by walking the snapshot, and every `listTools()` call
 *     reads from it. Previously the closure walked the snapshot per call,
 *     which was O(n_skills × n_servers) per tool probe.
 *   - Headers are resolved per call (not cached) because credentials can
 *     change between the `listTools` of one server and the next, and a
 *     stale header is worse than one extra lookup.
 *   - The auth resolver is injected, not imported, so the factory stays
 *     decoupled from `server-completions.ts` (where `resolveMcpAuthHeaders`
 *     currently lives). Real callers pass a closure over that helper; unit
 *     tests pass a `vi.fn()`.
 *   - An absent server in the URL map returns `[]`, not an exception. This
 *     matches the posture of `populateCatalogFromSkills` (per-server
 *     try/catch) — a server that never got registered should make its tools
 *     invisible, not abort the whole catalog build.
 */

import type { McpConnectionManager } from '../../plugins/mcp-manager.js';
import { connectAndListTools } from '../../plugins/mcp-client.js';
import { applyUrlRewrite, type UrlRewriteMap } from '../../plugins/url-rewrite.js';
import { getLogger } from '../../logger.js';
import type { SkillSnapshotEntry } from './types.js';
import type { CatalogMcpClient } from './catalog-population.js';

const logger = getLogger().child({ component: 'mcp-client-factory' });

export interface BuildTurnMcpClientFactoryInput {
  mcpManager: McpConnectionManager;
  agentId: string;
  /** The per-turn skill snapshot. Used once at construction to build the
   *  server-name → URL map; never re-walked afterwards. */
  snapshot: SkillSnapshotEntry[];
  /** Resolve auth headers for a named MCP server. Called only when the
   *  registered server entry carries no explicit headers AND the server's
   *  frontmatter didn't declare a `credential` ref. Signature takes the
   *  server name so legacy pattern-match resolvers (`<SERVER>_API_KEY`,
   *  etc.) keep working. */
  resolveAuthHeaders(serverName: string): Promise<Record<string, string> | undefined>;
  /** Resolve auth headers for an explicit `mcpServers[].credential` envName
   *  ref. When the skill's frontmatter pins a credential — e.g.
   *  `credential: LINEAR_API_KEY` — we look it up directly in the skill
   *  credential store under that name and scope, matching the path the
   *  admin-side Test-&-Enable probe uses. Absent = no ref was declared;
   *  fall through to the legacy pattern resolver. */
  resolveAuthHeadersByCredential?(envName: string): Promise<Record<string, string> | undefined>;
  /** Optional `config.url_rewrites` map applied to the MCP URL before the
   *  host's fetch. `undefined` (production default) is a no-op pass-through.
   *  The e2e harness populates this so skill frontmatter can point at
   *  `https://mock-target.test/...` while the actual request lands on the
   *  mock server's dynamic port. */
  urlRewrites?: UrlRewriteMap;
}

export type TurnMcpClientFactory = (skillName: string, serverName: string) => CatalogMcpClient;

export function buildTurnMcpClientFactory(
  input: BuildTurnMcpClientFactoryInput,
): TurnMcpClientFactory {
  const {
    mcpManager,
    agentId,
    snapshot,
    resolveAuthHeaders,
    resolveAuthHeadersByCredential,
    urlRewrites,
  } = input;

  // Build the server-name → (URL, credentialRef) index once. `credentialRef`
  // is the bare envName from `mcpServers[].credential` when the skill author
  // pinned a specific credential — e.g. `credential: LINEAR_API_KEY`. We
  // prefer that lookup over the legacy serverName-prefix pattern match when
  // both are available, because the ref is authoritative: the admin-side
  // Test-&-Enable probe uses it, and if the probe succeeded we know the
  // value stored under that envName works. Without this, a skill whose
  // serverName doesn't match `<CRED_PREFIX>_*` (e.g. server "linear-mcp-server"
  // + envName "LINEAR_API_KEY") silently 401s on every turn even though
  // the admin just tested it successfully.
  interface ServerEntry {
    url: string;
    transport: 'http' | 'sse';
    credentialRef?: string;
  }
  const serverIndex = new Map<string, ServerEntry>();
  for (const entry of snapshot) {
    if (!entry.ok) continue;
    for (const server of entry.frontmatter.mcpServers) {
      serverIndex.set(server.name, {
        url: server.url,
        transport: server.transport,
        ...(server.credential ? { credentialRef: server.credential } : {}),
      });
    }
  }

  return (_skillName, serverName) => ({
    async listTools() {
      const server = serverIndex.get(serverName);
      if (!server) return [];
      const meta = mcpManager.getServerMeta(agentId, serverName);
      // Resolve headers with this precedence:
      //   1. Explicit headers on the registered McpConnectionManager entry
      //      (admin-added DB servers, tested plugin registrations).
      //   2. The skill's `mcpServers[].credential` ref, when declared —
      //      authoritative, and the same lookup the Test-&-Enable probe
      //      uses. Closes the asymmetric-auth bug where admin-approved
      //      skills still 401 at turn time because the legacy resolver
      //      couldn't find the envName from the server's name prefix.
      //   3. Legacy pattern-based lookup by serverName prefix
      //      (`<SERVER>_API_KEY`, `<SERVER>_TOKEN`, …) for servers whose
      //      frontmatter didn't pin a credential.
      let headers: Record<string, string> | undefined = meta?.headers;
      let authSource: 'meta' | 'credential_ref' | 'pattern' | 'none' =
        headers ? 'meta' : 'none';
      if (!headers && server.credentialRef && resolveAuthHeadersByCredential) {
        headers = await resolveAuthHeadersByCredential(server.credentialRef);
        if (headers) authSource = 'credential_ref';
      }
      if (!headers) {
        headers = await resolveAuthHeaders(serverName);
        if (headers) authSource = 'pattern';
      }
      // Diagnostic signal — when catalog population returns empty tools
      // for a server, the next question is always "did we send an auth
      // header?" This log answers it at the source so the operator can
      // grep for `auth_resolved` rather than tracing through the probe
      // path. Header VALUE never logged, only presence + resolution path.
      logger.debug('auth_resolved', {
        agentId,
        serverName,
        credentialRef: server.credentialRef,
        authSource,
        hasHeader: !!headers,
      });
      const dispatchUrl = applyUrlRewrite(server.url, urlRewrites);
      // Transport precedence: registered meta (admin override) wins over
      // frontmatter — but when meta carries no transport, the skill's
      // own declaration is authoritative. Without this the factory fell
      // back to the connectAndListTools default ('http') whenever the
      // McpConnectionManager hadn't been warmed with the skill's entry,
      // breaking any skill whose frontmatter said `transport: sse`.
      const transport = meta?.transport ?? server.transport;
      return connectAndListTools(dispatchUrl, {
        ...(headers ? { headers } : {}),
        transport,
      });
    },
  });
}
