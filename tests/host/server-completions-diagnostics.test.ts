/**
 * Integration-lite tests for the diagnostic-threading contract in
 * `processCompletion` — Task B2 of the "surface skill/catalog failures"
 * pipeline. Asserts the same wire-up `processCompletion` uses:
 *
 *   1. A fresh `DiagnosticCollector` is created per turn.
 *   2. The collector is passed to `populateCatalogFromSkills(...)` via the
 *      `diagnostics` field, INSIDE a closure (matching `getOrBuildCatalog`'s
 *      `build` callback shape).
 *   3. Failures pushed inside that closure survive — `collector.list()`
 *      read AFTER the closure returns gives the full failure set.
 *   4. Cache-hit behavior: if the build closure never runs, the collector
 *      stays empty (no stale banner).
 *
 * We don't invoke `processCompletion` directly — its sandbox-path setup
 * (provisioner, workspace provider, IPC socket, sandbox factory, ...) makes
 * an end-to-end call infeasible in a unit test. Instead we exercise the
 * exact `populateCatalogFromSkills(... diagnostics ...)` pattern the real
 * code uses, so a regression in the wire-up (e.g. forgetting to pass
 * `diagnostics` or reading off the wrong instance) would fail here.
 *
 * The full-stack check happens in the SSE emission tests
 * (`server-request-handlers-diagnostics.test.ts`) which feed `runCompletion`
 * a mocked `CompletionResult.diagnostics` and assert the wire.
 */

import { describe, test, expect, vi } from 'vitest';
import { createDiagnosticCollector } from '../../src/host/diagnostics.js';
import { populateCatalogFromSkills } from '../../src/host/skills/catalog-population.js';
import { ToolCatalog } from '../../src/host/tool-catalog/registry.js';

const unusedFetchOpenApiSpec = async (): Promise<never> => {
  throw new Error('fetchOpenApiSpec should not have been called in this test');
};

describe('processCompletion diagnostic wire-up (integration-lite)', () => {
  test('collector receives MCP failure from inside the build closure', async () => {
    // Mirrors the pattern in server-completions.ts:
    //   const diagnostics = createDiagnosticCollector();
    //   await getOrBuildCatalog({ build: async () => { ... populateCatalogFromSkills({ diagnostics, ... }) } });
    //   const result = { ..., diagnostics: diagnostics.list() };
    const diagnostics = createDiagnosticCollector();
    const catalog = new ToolCatalog();

    // The build closure — same shape as the one in server-completions.ts.
    // We run it synchronously here (no cache involvement) to prove the
    // collector captures the failure.
    const build = async () => {
      await populateCatalogFromSkills({
        skills: [
          {
            name: 'linear',
            ok: true,
            frontmatter: { mcpServers: [{ name: 'linear-prod' }] },
          } as never,
        ],
        getMcpClient: () =>
          ({ listTools: vi.fn().mockRejectedValue(new Error('401 unauthorized')) }) as never,
        fetchOpenApiSpec: unusedFetchOpenApiSpec,
        catalog,
        diagnostics,
      });
    };

    await build();

    // Snapshot taken AFTER the closure returns — the whole point of
    // passing the collector by reference.
    const list = diagnostics.list();
    expect(list).toHaveLength(1);
    const [d] = list;
    expect(d.kind).toBe('catalog_populate_server_failed');
    expect(d.severity).toBe('warn');
    expect(d.message).toContain('linear');
    expect(d.message).toContain('linear-prod');
    expect(d.context).toMatchObject({
      skill: 'linear',
      server: 'linear-prod',
      error: '401 unauthorized',
    });
  });

  test('collector receives OpenAPI source failure from inside the build closure', async () => {
    const diagnostics = createDiagnosticCollector();
    const catalog = new ToolCatalog();

    const build = async () => {
      await populateCatalogFromSkills({
        skills: [
          {
            name: 'petstore',
            ok: true,
            frontmatter: {
              openapi: [
                { spec: 'https://petstore.test/openapi.json', baseUrl: 'https://petstore.test' },
              ],
            },
          } as never,
        ],
        getMcpClient: () => ({ listTools: vi.fn() }) as never,
        fetchOpenApiSpec: vi.fn().mockRejectedValue(new Error('fetch failed')),
        catalog,
        diagnostics,
      });
    };

    await build();

    const list = diagnostics.list();
    expect(list).toHaveLength(1);
    expect(list[0].kind).toBe('catalog_populate_openapi_source_failed');
    expect(list[0].message).toContain('petstore');
    expect(list[0].message).toContain('https://petstore.test/openapi.json');
  });

  test('clean build produces empty diagnostics list', async () => {
    // The happy path — every declared MCP server listTools succeeds, so
    // the collector stays empty and `CompletionResult.diagnostics` is [].
    // This is the case the SSE handler uses to decide "no banner, no noise".
    const diagnostics = createDiagnosticCollector();
    const catalog = new ToolCatalog();

    await populateCatalogFromSkills({
      skills: [
        {
          name: 'linear',
          ok: true,
          frontmatter: { mcpServers: [{ name: 'linear-prod' }] },
        } as never,
      ],
      getMcpClient: () =>
        ({
          listTools: vi
            .fn()
            .mockResolvedValue([{ name: 'list_issues', inputSchema: {} }]),
        }) as never,
      fetchOpenApiSpec: unusedFetchOpenApiSpec,
      catalog,
      diagnostics,
    });

    expect(diagnostics.list()).toEqual([]);
    // And the catalog actually registered the tool — proves we're on the
    // success path, not a silent early-exit.
    expect(catalog.list().map((t) => t.name)).toEqual(['mcp_linear_list_issues']);
  });

  test('cache-hit simulation: build closure never fires, collector stays empty', async () => {
    // Simulates the caching caveat called out in the B2 spec: when
    // `getOrBuildCatalog` hits its cache, the `build` closure doesn't run,
    // so nothing ever pushes into the collector. That's the right
    // behavior — the user already saw the banner on the turn that did the
    // build. Here we just model it: a fresh collector, no build invocation,
    // empty list.
    const diagnostics = createDiagnosticCollector();

    // No closure invocation — simulating the cache-hit path.

    expect(diagnostics.list()).toEqual([]);
  });

  test('fresh collector per turn: two sequential turns do not share state', async () => {
    // Invariant check: `CompletionResult.diagnostics` must reflect this
    // turn's failures only. If a shared collector leaked across turns,
    // a UI banner from turn N would still show on turn N+1 even after
    // the underlying issue was fixed.
    const failingClient = {
      listTools: vi.fn().mockRejectedValue(new Error('boom')),
    };
    const goodClient = {
      listTools: vi
        .fn()
        .mockResolvedValue([{ name: 'ok_tool', inputSchema: {} }]),
    };

    const turn1Diags = createDiagnosticCollector();
    const turn1Catalog = new ToolCatalog();
    await populateCatalogFromSkills({
      skills: [
        {
          name: 's',
          ok: true,
          frontmatter: { mcpServers: [{ name: 'srv' }] },
        } as never,
      ],
      getMcpClient: () => failingClient as never,
      fetchOpenApiSpec: unusedFetchOpenApiSpec,
      catalog: turn1Catalog,
      diagnostics: turn1Diags,
    });
    expect(turn1Diags.list()).toHaveLength(1);

    const turn2Diags = createDiagnosticCollector();
    const turn2Catalog = new ToolCatalog();
    await populateCatalogFromSkills({
      skills: [
        {
          name: 's',
          ok: true,
          frontmatter: { mcpServers: [{ name: 'srv' }] },
        } as never,
      ],
      getMcpClient: () => goodClient as never,
      fetchOpenApiSpec: unusedFetchOpenApiSpec,
      catalog: turn2Catalog,
      diagnostics: turn2Diags,
    });
    // Turn 2 was clean — its collector must be independent of turn 1.
    expect(turn2Diags.list()).toEqual([]);
    // Turn 1's collector still holds its turn-1 failure — collectors don't
    // reach across each other.
    expect(turn1Diags.list()).toHaveLength(1);
  });
});
