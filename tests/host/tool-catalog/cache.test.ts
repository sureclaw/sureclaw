import { describe, test, expect, beforeEach, vi } from 'vitest';
import {
  getOrBuildCatalog,
  invalidateCatalog,
  invalidateAllCatalogs,
  catalogCacheSize,
  type BuildResult,
} from '../../../src/host/tool-catalog/cache.js';
import type { CatalogTool } from '../../../src/types/catalog.js';

const sampleTool = (name: string): CatalogTool => ({
  name,
  skill: 'linear',
  summary: 'sample',
  schema: { type: 'object' },
  dispatch: { kind: 'mcp', server: 'linear', toolName: name.replace(/^mcp_/, '') },
});

/** Shorthand — build result for a fully successful build. */
const ok = (tools: CatalogTool[]): BuildResult => ({ tools, partial: false });
/** Shorthand — build result from a transient failure (at least one MCP
 *  server failed listTools). The cache must SKIP writing these. */
const partial = (tools: CatalogTool[]): BuildResult => ({ tools, partial: true });

describe('catalog cache', () => {
  beforeEach(() => {
    invalidateAllCatalogs();
  });

  test('cache miss → build is called and result is cached', async () => {
    const build = vi.fn(async () => ok([sampleTool('mcp_list_issues')]));

    const result = await getOrBuildCatalog({
      agentId: 'agent-a',
      userId: 'user-1',
      headSha: 'sha-1',
      build,
    });

    expect(build).toHaveBeenCalledTimes(1);
    expect(result).toEqual([sampleTool('mcp_list_issues')]);
    expect(catalogCacheSize()).toBe(1);
  });

  test('cache hit → build is NOT called, same array returned', async () => {
    const firstBuild = vi.fn(async () => ok([sampleTool('mcp_list_issues')]));
    const first = await getOrBuildCatalog({
      agentId: 'agent-a',
      userId: 'user-1',
      headSha: 'sha-1',
      build: firstBuild,
    });

    const secondBuild = vi.fn(async () => ok([sampleTool('mcp_other')]));
    const second = await getOrBuildCatalog({
      agentId: 'agent-a',
      userId: 'user-1',
      headSha: 'sha-1',
      build: secondBuild,
    });

    expect(firstBuild).toHaveBeenCalledTimes(1);
    expect(secondBuild).not.toHaveBeenCalled();
    // Same reference — the cache returns the stored array as-is.
    expect(second).toBe(first);
  });

  test('different headSha → separate cache entries', async () => {
    const buildSha1 = vi.fn(async () => ok([sampleTool('mcp_list_issues')]));
    const buildSha2 = vi.fn(async () => ok([sampleTool('mcp_get_issue')]));

    const r1 = await getOrBuildCatalog({
      agentId: 'agent-a',
      userId: 'user-1',
      headSha: 'sha-1',
      build: buildSha1,
    });
    const r2 = await getOrBuildCatalog({
      agentId: 'agent-a',
      userId: 'user-1',
      headSha: 'sha-2',
      build: buildSha2,
    });

    expect(buildSha1).toHaveBeenCalledTimes(1);
    expect(buildSha2).toHaveBeenCalledTimes(1);
    expect(r1).not.toBe(r2);
    expect(r1[0].name).toBe('mcp_list_issues');
    expect(r2[0].name).toBe('mcp_get_issue');
    expect(catalogCacheSize()).toBe(2);
  });

  test('different userId → separate cache entries (per-user scoping)', async () => {
    // Two users on the same agent + HEAD — their tool lists may differ
    // because MCP auth headers are user-scoped. The cache must not leak
    // one user's catalog to the other.
    const buildForUser1 = vi.fn(async () => ok([sampleTool('mcp_user1_tool')]));
    const buildForUser2 = vi.fn(async () => ok([sampleTool('mcp_user2_tool')]));

    const r1 = await getOrBuildCatalog({
      agentId: 'agent-a',
      userId: 'user-1',
      headSha: 'sha-1',
      build: buildForUser1,
    });
    const r2 = await getOrBuildCatalog({
      agentId: 'agent-a',
      userId: 'user-2',
      headSha: 'sha-1',
      build: buildForUser2,
    });

    expect(buildForUser1).toHaveBeenCalledTimes(1);
    expect(buildForUser2).toHaveBeenCalledTimes(1);
    expect(r1[0].name).toBe('mcp_user1_tool');
    expect(r2[0].name).toBe('mcp_user2_tool');
  });

  test('different agentId → separate cache entries', async () => {
    const buildA = vi.fn(async () => ok([sampleTool('mcp_a')]));
    const buildB = vi.fn(async () => ok([sampleTool('mcp_b')]));

    await getOrBuildCatalog({
      agentId: 'agent-a',
      userId: 'user-1',
      headSha: 'sha-1',
      build: buildA,
    });
    await getOrBuildCatalog({
      agentId: 'agent-b',
      userId: 'user-1',
      headSha: 'sha-1',
      build: buildB,
    });

    expect(buildA).toHaveBeenCalledTimes(1);
    expect(buildB).toHaveBeenCalledTimes(1);
    expect(catalogCacheSize()).toBe(2);
  });

  test('invalidateCatalog(agentId) → next call with same key rebuilds', async () => {
    const build1 = vi.fn(async () => ok([sampleTool('mcp_before')]));
    await getOrBuildCatalog({
      agentId: 'agent-a',
      userId: 'user-1',
      headSha: 'sha-1',
      build: build1,
    });

    const dropped = invalidateCatalog('agent-a');
    expect(dropped).toBe(1);

    const build2 = vi.fn(async () => ok([sampleTool('mcp_after')]));
    const result = await getOrBuildCatalog({
      agentId: 'agent-a',
      userId: 'user-1',
      headSha: 'sha-1',
      build: build2,
    });

    expect(build1).toHaveBeenCalledTimes(1);
    expect(build2).toHaveBeenCalledTimes(1);
    expect(result[0].name).toBe('mcp_after');
  });

  test('invalidateCatalog(agentId) drops every user+head combo for that agent', async () => {
    const build = vi.fn(async () => ok([sampleTool('mcp_x')]));
    await getOrBuildCatalog({ agentId: 'agent-a', userId: 'user-1', headSha: 'sha-1', build });
    await getOrBuildCatalog({ agentId: 'agent-a', userId: 'user-2', headSha: 'sha-1', build });
    await getOrBuildCatalog({ agentId: 'agent-a', userId: 'user-1', headSha: 'sha-2', build });
    await getOrBuildCatalog({ agentId: 'agent-b', userId: 'user-1', headSha: 'sha-1', build });
    expect(catalogCacheSize()).toBe(4);

    const dropped = invalidateCatalog('agent-a');
    expect(dropped).toBe(3);
    expect(catalogCacheSize()).toBe(1);
  });

  test('invalidateCatalog is prefix-safe — does not drop other agents', async () => {
    // If the prefix were just `${agentId}`, `agent-a-extra` would collide
    // with `agent-a`. The delimiter `:` prevents that.
    const build = vi.fn(async () => ok([sampleTool('mcp_x')]));
    await getOrBuildCatalog({ agentId: 'agent-a', userId: 'u', headSha: 'h', build });
    await getOrBuildCatalog({ agentId: 'agent-a-extra', userId: 'u', headSha: 'h', build });

    const dropped = invalidateCatalog('agent-a');
    expect(dropped).toBe(1);
    expect(catalogCacheSize()).toBe(1);
  });

  test('invalidateAllCatalogs → empties the cache', async () => {
    const build = vi.fn(async () => ok([sampleTool('mcp_x')]));
    await getOrBuildCatalog({ agentId: 'agent-a', userId: 'u', headSha: '1', build });
    await getOrBuildCatalog({ agentId: 'agent-b', userId: 'u', headSha: '1', build });
    expect(catalogCacheSize()).toBe(2);

    invalidateAllCatalogs();
    expect(catalogCacheSize()).toBe(0);
  });

  test('concurrent misses on the same key → build runs twice, last writer wins', async () => {
    // The cache has no in-flight dedup — two misses on the same key that
    // overlap in time both invoke `build`. This test locks that behavior in
    // so a future change that adds dedup (or accidentally breaks this one)
    // shows up as a deliberate test update. Adding dedup is a valid follow-up
    // and should come with a rewrite of this test to expect a single call.
    let resolveFirst!: (v: BuildResult) => void;
    let resolveSecond!: (v: BuildResult) => void;
    const firstBuild = vi.fn(
      () => new Promise<BuildResult>((r) => { resolveFirst = r; }),
    );
    const secondBuild = vi.fn(
      () => new Promise<BuildResult>((r) => { resolveSecond = r; }),
    );

    // Fire both lookups before either build settles — they share a key,
    // both miss (the store is empty), so both must invoke their build.
    const p1 = getOrBuildCatalog({
      agentId: 'agent-a',
      userId: 'u',
      headSha: 'h',
      build: firstBuild,
    });
    const p2 = getOrBuildCatalog({
      agentId: 'agent-a',
      userId: 'u',
      headSha: 'h',
      build: secondBuild,
    });

    expect(firstBuild).toHaveBeenCalledTimes(1);
    expect(secondBuild).toHaveBeenCalledTimes(1);

    // Resolve in reverse order — `secondBuild` settles first, then
    // `firstBuild`. Each caller gets its own build's output. The last
    // `store.set` wins, so the cached entry is whichever resolved last.
    resolveSecond(ok([sampleTool('mcp_second')]));
    resolveFirst(ok([sampleTool('mcp_first')]));
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1[0].name).toBe('mcp_first');
    expect(r2[0].name).toBe('mcp_second');

    // Cached entry is whichever wrote last; because we awaited Promise.all,
    // the second `store.set` (from `firstBuild`'s resolution) is the last
    // writer. A third lookup hits the cache and returns the first-build's
    // array — no new `build` call.
    const thirdBuild = vi.fn(async () => ok([sampleTool('mcp_third')]));
    const r3 = await getOrBuildCatalog({
      agentId: 'agent-a',
      userId: 'u',
      headSha: 'h',
      build: thirdBuild,
    });
    expect(thirdBuild).not.toHaveBeenCalled();
    expect(r3[0].name).toBe('mcp_first');
  });

  test('invalidate during in-flight build → build result is NOT cached', async () => {
    // The OAuth-callback race: credentials land mid-build, invalidate fires
    // against an empty key (nothing cached yet), the build resolves with
    // stale headers, and without the generation counter the cache would
    // accept the stale array. Turn N+1 would then serve pre-OAuth tools
    // until the next push / OAuth event.
    let resolveBuild!: (v: BuildResult) => void;
    const racyBuild = vi.fn(
      () => new Promise<BuildResult>((r) => { resolveBuild = r; }),
    );

    const inFlight = getOrBuildCatalog({
      agentId: 'agent-a',
      userId: 'u',
      headSha: 'h',
      build: racyBuild,
    });

    // Fire invalidation while the build is still pending. Nothing is in the
    // store yet (first build hasn't resolved), so the return value is 0 —
    // the generation bump is what does the work.
    const dropped = invalidateCatalog('agent-a');
    expect(dropped).toBe(0);

    // Now let the pre-invalidate build resolve. This caller still gets its
    // (now-stale) value — we've already committed to this turn's answer —
    // but the cache slot must NOT be populated.
    resolveBuild(ok([sampleTool('mcp_stale')]));
    const r1 = await inFlight;
    expect(r1[0].name).toBe('mcp_stale');
    expect(catalogCacheSize()).toBe(0);

    // Next call with the same key must invoke build again (the poisoned
    // write was suppressed, so the cache is still empty).
    const freshBuild = vi.fn(async () => ok([sampleTool('mcp_fresh')]));
    const r2 = await getOrBuildCatalog({
      agentId: 'agent-a',
      userId: 'u',
      headSha: 'h',
      build: freshBuild,
    });
    expect(freshBuild).toHaveBeenCalledTimes(1);
    expect(r2[0].name).toBe('mcp_fresh');
    expect(catalogCacheSize()).toBe(1);
  });

  // Regression: a flaky listTools 401 from one MCP server used to poison
  // the cache as "no tools" until HEAD changed, locking agents out of
  // tools across many turns. Build now flags itself as `partial: true`
  // on per-server failures and the cache SKIPS the write so the next
  // turn retries.
  test('build returns partial: true → result is NOT cached; next turn rebuilds', async () => {
    const flakyBuild = vi.fn(async () => partial([sampleTool('mcp_a')]));
    const r1 = await getOrBuildCatalog({
      agentId: 'agent-flaky',
      userId: 'u',
      headSha: 'h',
      build: flakyBuild,
    });

    // This turn still gets the tools we managed to gather — skip-write is
    // purely about not poisoning FUTURE turns.
    expect(r1[0].name).toBe('mcp_a');
    expect(catalogCacheSize()).toBe(0);

    // Next turn: same key, fresh build fires because the cache is empty.
    const recoveringBuild = vi.fn(async () => ok([sampleTool('mcp_a'), sampleTool('mcp_b')]));
    const r2 = await getOrBuildCatalog({
      agentId: 'agent-flaky',
      userId: 'u',
      headSha: 'h',
      build: recoveringBuild,
    });
    expect(recoveringBuild).toHaveBeenCalledTimes(1);
    expect(r2.map((t) => t.name)).toEqual(['mcp_a', 'mcp_b']);
    expect(catalogCacheSize()).toBe(1);
  });

  test('invalidateAllCatalogs during in-flight build → build result is NOT cached', async () => {
    // Same race as above, via the broader invalidation surface that clears
    // every agent. Generation must bump for every agent that has an
    // in-flight build, not just agents that happened to have a prior entry.
    let resolveBuild!: (v: BuildResult) => void;
    const racyBuild = vi.fn(
      () => new Promise<BuildResult>((r) => { resolveBuild = r; }),
    );

    const inFlight = getOrBuildCatalog({
      agentId: 'fresh-agent',
      userId: 'u',
      headSha: 'h',
      build: racyBuild,
    });

    invalidateAllCatalogs();
    resolveBuild(ok([sampleTool('mcp_stale')]));
    await inFlight;

    expect(catalogCacheSize()).toBe(0);

    const freshBuild = vi.fn(async () => ok([sampleTool('mcp_fresh')]));
    await getOrBuildCatalog({
      agentId: 'fresh-agent',
      userId: 'u',
      headSha: 'h',
      build: freshBuild,
    });
    expect(freshBuild).toHaveBeenCalledTimes(1);
  });
});
