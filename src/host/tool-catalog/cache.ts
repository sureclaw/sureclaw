/**
 * Per-turn catalog cache — keyed on (agentId, userId, HEAD-sha).
 *
 * Motivation
 * ──────────
 * `populateCatalogFromSkills` hits every skill's MCP server with a `listTools`
 * round-trip. On a typical workspace that's 200–400 ms of network work that
 * we were paying every single turn, even though the answer only changes when
 * the skill snapshot or the user's credentials change.
 *
 * This cache makes the first turn after a skill HEAD change pay the full
 * build cost (same as before), and every subsequent turn at the same HEAD
 * hit the cache instead — O(1), no network, no O(tools) work.
 *
 * Key shape: `${agentId}:${userId}:${headSha}`
 *   - `agentId` — workspace identity (per-agent git repo).
 *   - `userId`  — included because `resolveMcpAuthHeaders` is user-scoped.
 *     Two users looking at the same skill HEAD can see different tool
 *     lists (different Linear workspace, different Slack team, etc.).
 *     Leaking one user's tool list to another would be a correctness bug.
 *   - `headSha` — git sha of the skills repo at turn start; what actually
 *     determines which MCP servers are declared.
 *
 * Invalidation is explicit. There's no TTL and no LRU — skill HEAD changes
 * are infrequent, entries are ~KB of JSON, and a stale entry has real blast
 * radius (wrong tools in the catalog). Invalidation is wired to the same
 * triggers that drop the sibling `snapshotCache`:
 *   1. `hook-endpoint.ts`   — post-receive hook fired on every push.
 *   2. `admin-oauth-flow.ts` — after an admin-initiated OAuth callback
 *      lands new credentials (headers for the MCP `listTools` call change).
 *
 * Value shape: `CatalogTool[]`, NOT `ToolCatalog`. Instance identity can't
 * cross turn boundaries safely (mutation risk on the frozen-flag, shared
 * `Map` references). The array is a pure value — safe to cache and reuse.
 *
 * Race safety: the store never shrinks on its own — an entry persists until
 * its agent is invalidated or the process exits. In practice that's a
 * handful of KB per user per agent, accumulating by 1 on each skill push or
 * OAuth callback — the same small leak `snapshotCache` has. If a deployment
 * ever starts seeing measurable RSS growth, add a bounded LRU the way
 * `snapshotCache` does; we intentionally held off because skill HEAD
 * changes are infrequent and the correctness cost of evicting a hot entry
 * (one extra listTools round-trip) is low.
 *
 * A per-agent generation counter guards against a subtler race: an
 * invalidation that fires WHILE a build is in flight. Without the counter,
 * the build's `store.set()` would write a stale entry AFTER the invalidate
 * cleared the key, and subsequent turns would serve stale tools until the
 * next HEAD change / OAuth callback. The counter is captured before the
 * build awaits and re-checked after; if it moved, we skip the write.
 */

import type { CatalogTool } from '../../types/catalog.js';

export interface GetOrBuildCatalogInput {
  agentId: string;
  /** The user this turn is running for. `resolveMcpAuthHeaders` uses this
   *  to pick the right `skill_credentials` row, so the resulting tool list
   *  is user-scoped and must be cached per-user. Use the same sentinel the
   *  caller already uses for "no authenticated user" (typically
   *  `'anonymous'`). */
  userId: string;
  /** The git HEAD sha of the skills repo for this turn. Any change to the
   *  skill frontmatter changes this sha, which is exactly when the catalog
   *  needs a rebuild. */
  headSha: string;
  /** Invoked only on cache miss. Return `{tools, partial}` — when
   *  `partial: true` (one or more MCP servers failed `listTools`), the
   *  helper returns the tools to this turn's caller but skips the cache
   *  write so the next turn retries the flaky server. Without this, a
   *  single transient 401 sticks as "no tools" until HEAD changes. */
  build(): Promise<BuildResult>;
}

/** Shape returned by `build`. `partial: true` tells the cache not to
 *  persist, because the result reflects a transient failure. */
export interface BuildResult {
  tools: CatalogTool[];
  partial: boolean;
}

/** `${agentId}:${userId}:${headSha}` — single delimiter keeps lookups cheap. */
function cacheKey(agentId: string, userId: string, headSha: string): string {
  return `${agentId}:${userId}:${headSha}`;
}

/** Prefix used by `invalidateCatalog` to scope to a single agent. */
function agentPrefix(agentId: string): string {
  return `${agentId}:`;
}

const store = new Map<string, CatalogTool[]>();

/**
 * Per-agent generation counter. Bumped by every `invalidateCatalog(agentId)`
 * call (and `invalidateAllCatalogs` bumps every known agent). `getOrBuildCatalog`
 * captures the value before awaiting `build`, then compares after — if it
 * moved, the build started under stale assumptions and its result must not
 * be written back to the store.
 *
 * This matters because `invalidateCatalog` is fire-and-forget: the OAuth
 * callback path bumps generation even when there's no cached entry yet
 * (because the build for this turn hasn't finished). Without this counter,
 * that path would silently lose the invalidation signal and poison the
 * cache with pre-credential-update tool lists.
 */
const generations = new Map<string, number>();

function currentGeneration(agentId: string): number {
  return generations.get(agentId) ?? 0;
}

function bumpGeneration(agentId: string): void {
  generations.set(agentId, currentGeneration(agentId) + 1);
}

/**
 * Return a cached catalog for (agentId, userId, headSha) if present; otherwise
 * invoke `build`, cache the result, and return it. On cache hit `build` is
 * not called — that's the whole point. On cache miss `build` runs exactly
 * once per key.
 *
 * Race handling: if `invalidateCatalog(agentId)` fires while `build` is in
 * flight, we still return the freshly built array to this caller (it's the
 * best value we have for this specific turn), but we skip the `store.set()`
 * so subsequent turns re-run `build` against the post-invalidate state.
 */
export async function getOrBuildCatalog(
  input: GetOrBuildCatalogInput,
): Promise<CatalogTool[]> {
  const key = cacheKey(input.agentId, input.userId, input.headSha);
  const cached = store.get(key);
  if (cached) return cached;

  // Seed the generation entry if this is the first build for the agent.
  // `invalidateAllCatalogs` iterates `generations.keys()` to bump every
  // known agent — an agent with no entry would miss that signal and write
  // stale data after a clear().
  if (!generations.has(input.agentId)) generations.set(input.agentId, 0);
  const genAtStart = currentGeneration(input.agentId);
  const built = await input.build();
  const genAtEnd = currentGeneration(input.agentId);
  // Skip the cache write on BOTH:
  //   - generation bump (invalidation raced the build — would poison future turns)
  //   - partial build (one or more servers failed — caching "no tools" sticks
  //     until HEAD changes; next turn should retry)
  if (genAtEnd === genAtStart && !built.partial) {
    store.set(key, built.tools);
  }
  // Return the built tools either way — this turn's caller asked for
  // what's available and we have it. Skip-write is purely about not
  // poisoning future turns with a transient-failure snapshot.
  return built.tools;
}

/**
 * Drop every cached catalog for the given agent. Matches the per-agent
 * invalidation surface of `snapshotCache.invalidateAgent`. Returns the
 * number of entries dropped (useful for hook logging + tests).
 *
 * Drops every user-scoped entry for the agent — a single skill push
 * should refresh the catalog for every user on that agent, not just
 * the one who triggered the push. Always bumps the per-agent generation
 * counter so any in-flight `getOrBuildCatalog` build sees it and skips
 * its cache write.
 */
export function invalidateCatalog(agentId: string): number {
  bumpGeneration(agentId);
  const prefix = agentPrefix(agentId);
  let removed = 0;
  for (const key of [...store.keys()]) {
    if (key.startsWith(prefix)) {
      store.delete(key);
      removed += 1;
    }
  }
  return removed;
}

/**
 * Drop every cached catalog across all agents. Intended for test teardown
 * and administrative refresh endpoints that want a clean slate. Bumps every
 * known agent's generation so any in-flight builds skip their cache writes.
 */
export function invalidateAllCatalogs(): void {
  for (const agentId of [...generations.keys()]) {
    bumpGeneration(agentId);
  }
  store.clear();
}

/** Current cache size — exposed for test assertions and debug logging only. */
export function catalogCacheSize(): number {
  return store.size;
}
