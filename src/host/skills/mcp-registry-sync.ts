/**
 * Register MCP servers declared by a skill's frontmatter with
 * `McpConnectionManager`. The host-global registry is the source the tool
 * router + `discoverAllTools` reads from; without registration, a freshly
 * approved skill's servers are invisible and no tool discovery happens.
 *
 * Lazy model: this runs piggybacked on `loadSnapshot` (per-session, cached
 * per-HEAD SHA) and on the approval path (before `discoverAllTools` fires).
 * No startup scan over every agent — work is proportional to traffic, not
 * to the total agent population.
 *
 * Source tag `skill` distinguishes these entries from admin-added
 * (`database`) and plugin-added (`plugin:<name>`) servers. Additions are
 * idempotent (Map keyed on server name); no removals on the lazy path —
 * stale `skill`-tagged entries after a skill deletion leak until process
 * restart, which is harmless because no agent's `toolServerMap` routes to
 * them.
 */

import type { McpConnectionManager } from '../../plugins/mcp-manager.js';
import type { SkillSnapshotEntry } from './types.js';

export function registerMcpServersFromSnapshot(
  agentId: string,
  snapshot: SkillSnapshotEntry[],
  mcpManager: McpConnectionManager,
): void {
  for (const entry of snapshot) {
    if (!entry.ok) continue;
    for (const s of entry.frontmatter.mcpServers) {
      mcpManager.addServer(
        agentId,
        { name: s.name, type: 'http', url: s.url, transport: s.transport },
        { source: 'skill' },
      );
    }
  }
}
