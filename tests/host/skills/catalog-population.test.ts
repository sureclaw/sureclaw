import { describe, test, expect, vi, beforeAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { OpenAPIV3 } from 'openapi-types';
import { ToolCatalog } from '../../../src/host/tool-catalog/registry.js';
import { populateCatalogFromSkills } from '../../../src/host/skills/catalog-population.js';
import { createDiagnosticCollector } from '../../../src/host/diagnostics.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PETSTORE_PATH = resolve(__dirname, '../../fixtures/openapi/petstore-minimal.json');

/** Throwing stub for tests whose skill fixtures don't declare `openapi[]`.
 *  The factory is required on the input type (compile-time guarantee); these
 *  tests never exercise the openapi path, so the stub never fires. */
const unusedFetchOpenApiSpec = async (): Promise<never> => {
  throw new Error('fetchOpenApiSpec should not have been called in this test');
};

describe('populateCatalogFromSkills', () => {
  test('populates catalog from skill snapshot MCP servers', async () => {
    const mcpClient = {
      listTools: vi.fn().mockResolvedValue([
        { name: 'list_issues', description: 'List', inputSchema: { type: 'object' } },
      ]),
    };
    const catalog = new ToolCatalog();
    await populateCatalogFromSkills({
      skills: [{ name: 'linear', frontmatter: { mcpServers: [{ name: 'linear' }] } } as never],
      getMcpClient: () => mcpClient as never,
      fetchOpenApiSpec: unusedFetchOpenApiSpec,
      catalog,
    });
    expect(catalog.list()).toHaveLength(1);
    expect(catalog.get('mcp_linear_list_issues')).toBeDefined();
  });

  test('applies include filter from frontmatter', async () => {
    const mcpClient = {
      listTools: vi.fn().mockResolvedValue([
        { name: 'list_issues', inputSchema: {} },
        { name: 'delete_issue', inputSchema: {} },
      ]),
    };
    const catalog = new ToolCatalog();
    await populateCatalogFromSkills({
      skills: [{ name: 'linear', frontmatter: { mcpServers: [{ name: 'linear', include: ['list_*'] }] } } as never],
      getMcpClient: () => mcpClient as never,
      fetchOpenApiSpec: unusedFetchOpenApiSpec,
      catalog,
    });
    expect(catalog.list().map(t => t.name)).toEqual(['mcp_linear_list_issues']);
  });

  test('applies exclude filter from frontmatter', async () => {
    const mcpClient = {
      listTools: vi.fn().mockResolvedValue([
        { name: 'list_issues', inputSchema: {} },
        { name: 'delete_issue', inputSchema: {} },
      ]),
    };
    const catalog = new ToolCatalog();
    await populateCatalogFromSkills({
      skills: [{ name: 'linear', frontmatter: { mcpServers: [{ name: 'linear', exclude: ['delete_*'] }] } } as never],
      getMcpClient: () => mcpClient as never,
      fetchOpenApiSpec: unusedFetchOpenApiSpec,
      catalog,
    });
    expect(catalog.list().map(t => t.name)).toEqual(['mcp_linear_list_issues']);
  });

  test('skips entries with ok: false and servers where listTools throws', async () => {
    const goodClient = {
      listTools: vi.fn().mockResolvedValue([
        { name: 'ping', inputSchema: {} },
      ]),
    };
    const badClient = {
      listTools: vi.fn().mockRejectedValue(new Error('boom')),
    };
    const catalog = new ToolCatalog();
    await populateCatalogFromSkills({
      skills: [
        { name: 'broken', ok: false, error: 'invalid' } as never,
        {
          name: 'mixed',
          ok: true,
          frontmatter: {
            mcpServers: [
              { name: 'good-server' },
              { name: 'bad-server' },
            ],
          },
        } as never,
      ],
      getMcpClient: (_skill, serverName) => (serverName === 'good-server' ? goodClient : badClient) as never,
      fetchOpenApiSpec: unusedFetchOpenApiSpec,
      catalog,
    });
    // Only the good server contributed tools; bad server's failure is swallowed.
    expect(catalog.list().map(t => t.name)).toEqual(['mcp_mixed_ping']);
  });

  test('populates multiple skills and servers without cross-contamination', async () => {
    const linearClient = {
      listTools: vi.fn().mockResolvedValue([{ name: 'list_issues', inputSchema: {} }]),
    };
    const githubClient = {
      listTools: vi.fn().mockResolvedValue([{ name: 'list_repos', inputSchema: {} }]),
    };
    const catalog = new ToolCatalog();
    await populateCatalogFromSkills({
      skills: [
        { name: 'linear', ok: true, frontmatter: { mcpServers: [{ name: 'linear' }] } } as never,
        { name: 'github', ok: true, frontmatter: { mcpServers: [{ name: 'github' }] } } as never,
      ],
      getMcpClient: (_skill, serverName) => (serverName === 'linear' ? linearClient : githubClient) as never,
      fetchOpenApiSpec: unusedFetchOpenApiSpec,
      catalog,
    });
    expect(catalog.list().map(t => t.name).sort()).toEqual([
      'mcp_github_list_repos',
      'mcp_linear_list_issues',
    ]);
  });

  test('skips entries with no mcpServers declared', async () => {
    const catalog = new ToolCatalog();
    const listTools = vi.fn();
    await populateCatalogFromSkills({
      skills: [
        { name: 'weather', ok: true, frontmatter: { mcpServers: [] } } as never,
      ],
      getMcpClient: () => ({ listTools }) as never,
      fetchOpenApiSpec: unusedFetchOpenApiSpec,
      catalog,
    });
    expect(catalog.list()).toEqual([]);
    expect(listTools).not.toHaveBeenCalled();
  });

  // Regression: a flaky 401 from one MCP server used to silently poison
  // the cache. The builder now reports per-server failures so the cache
  // can skip writes and the next turn retries.
  test('returns serverFailures > 0 when a server\'s listTools throws', async () => {
    const flaky = { listTools: vi.fn().mockRejectedValue(new Error('invalid_token')) };
    const catalog = new ToolCatalog();
    const result = await populateCatalogFromSkills({
      skills: [
        { name: 'linear', ok: true, frontmatter: { mcpServers: [{ name: 'linear' }] } } as never,
      ],
      getMcpClient: () => flaky as never,
      fetchOpenApiSpec: unusedFetchOpenApiSpec,
      catalog,
    });
    expect(result.serverFailures).toBe(1);
    expect(result.toolRegisterFailures).toBe(0);
    expect(catalog.list()).toEqual([]);
  });

  test('returns serverFailures: 0 on clean build (idempotent success signal)', async () => {
    const client = {
      listTools: vi.fn().mockResolvedValue([{ name: 'list_issues', inputSchema: {} }]),
    };
    const catalog = new ToolCatalog();
    const result = await populateCatalogFromSkills({
      skills: [
        { name: 'linear', ok: true, frontmatter: { mcpServers: [{ name: 'linear' }] } } as never,
      ],
      getMcpClient: () => client as never,
      fetchOpenApiSpec: unusedFetchOpenApiSpec,
      catalog,
    });
    expect(result.serverFailures).toBe(0);
    expect(result.toolRegisterFailures).toBe(0);
  });

  test('counts tool-register failures separately from server failures (dupes stay cache-safe)', async () => {
    // Two skills declare servers that advertise the same tool name. The
    // second registration throws — that's a deterministic clash, not a
    // transient failure. Separate counter so callers can keep caching.
    const client = {
      listTools: vi.fn().mockResolvedValue([{ name: 'shared_tool', inputSchema: {} }]),
    };
    const catalog = new ToolCatalog();
    const result = await populateCatalogFromSkills({
      skills: [
        { name: 'a', ok: true, frontmatter: { mcpServers: [{ name: 's' }] } } as never,
        { name: 'a', ok: true, frontmatter: { mcpServers: [{ name: 's' }] } } as never,
      ],
      getMcpClient: () => client as never,
      fetchOpenApiSpec: unusedFetchOpenApiSpec,
      catalog,
    });
    expect(result.serverFailures).toBe(0);
    expect(result.toolRegisterFailures).toBe(1);
    expect(result.openApiSourceFailures).toBe(0);
  });

  // ── OpenAPI wiring ──
  // The adapter is pure (tested separately). This block exercises the
  // orchestrator's openapi loop: iterating frontmatter.openapi[], calling the
  // injected fetchOpenApiSpec factory, handing the dereferenced doc to
  // buildOpenApiCatalogTools, and registering the resulting catalog tools.
  describe('openapi sources', () => {
    let petstore: OpenAPIV3.Document;

    beforeAll(async () => {
      const raw = await readFile(PETSTORE_PATH, 'utf8');
      petstore = JSON.parse(raw) as OpenAPIV3.Document;
    });

    test('populates catalog from skill frontmatter openapi[] sources', async () => {
      const fetchOpenApiSpec = vi.fn().mockResolvedValue(petstore);
      const catalog = new ToolCatalog();
      const result = await populateCatalogFromSkills({
        skills: [
          {
            name: 'petstore',
            ok: true,
            frontmatter: {
              openapi: [{ spec: 'https://petstore.test/openapi.json', baseUrl: 'https://petstore.test' }],
            },
          } as never,
        ],
        getMcpClient: () => ({ listTools: vi.fn() }) as never,
        fetchOpenApiSpec,
        catalog,
      });
      expect(fetchOpenApiSpec).toHaveBeenCalledTimes(1);
      expect(fetchOpenApiSpec).toHaveBeenCalledWith('petstore', expect.objectContaining({
        spec: 'https://petstore.test/openapi.json',
        baseUrl: 'https://petstore.test',
      }));
      expect(result.openApiSourceFailures).toBe(0);
      expect(result.serverFailures).toBe(0);
      expect(result.toolRegisterFailures).toBe(0);
      expect(catalog.list()).toHaveLength(4);
      expect(catalog.list().map(t => t.name).sort()).toEqual([
        'api_petstore_create_pet',
        'api_petstore_delete_pet',
        'api_petstore_get_pet_by_id',
        'api_petstore_list_pets',
      ]);
    });

    test('applies include filter from openapi source', async () => {
      const fetchOpenApiSpec = vi.fn().mockResolvedValue(petstore);
      const catalog = new ToolCatalog();
      await populateCatalogFromSkills({
        skills: [
          {
            name: 'petstore',
            ok: true,
            frontmatter: {
              openapi: [{
                spec: 'https://petstore.test/openapi.json',
                baseUrl: 'https://petstore.test',
                include: ['list*', 'get*'],
              }],
            },
          } as never,
        ],
        getMcpClient: () => ({ listTools: vi.fn() }) as never,
        fetchOpenApiSpec,
        catalog,
      });
      expect(catalog.list().map(t => t.name).sort()).toEqual([
        'api_petstore_get_pet_by_id',
        'api_petstore_list_pets',
      ]);
    });

    test('applies exclude filter from openapi source', async () => {
      const fetchOpenApiSpec = vi.fn().mockResolvedValue(petstore);
      const catalog = new ToolCatalog();
      await populateCatalogFromSkills({
        skills: [
          {
            name: 'petstore',
            ok: true,
            frontmatter: {
              openapi: [{
                spec: 'https://petstore.test/openapi.json',
                baseUrl: 'https://petstore.test',
                exclude: ['delete*'],
              }],
            },
          } as never,
        ],
        getMcpClient: () => ({ listTools: vi.fn() }) as never,
        fetchOpenApiSpec,
        catalog,
      });
      expect(catalog.list().map(t => t.name).sort()).toEqual([
        'api_petstore_create_pet',
        'api_petstore_get_pet_by_id',
        'api_petstore_list_pets',
      ]);
    });

    test('passes auth block through to the adapter dispatch', async () => {
      const fetchOpenApiSpec = vi.fn().mockResolvedValue(petstore);
      const catalog = new ToolCatalog();
      await populateCatalogFromSkills({
        skills: [
          {
            name: 'petstore',
            ok: true,
            frontmatter: {
              openapi: [{
                spec: 'https://petstore.test/openapi.json',
                baseUrl: 'https://petstore.test',
                auth: { scheme: 'bearer', credential: 'PETSTORE_API_KEY' },
              }],
            },
          } as never,
        ],
        getMcpClient: () => ({ listTools: vi.fn() }) as never,
        fetchOpenApiSpec,
        catalog,
      });
      const tool = catalog.get('api_petstore_list_pets')!;
      expect(tool.dispatch).toMatchObject({
        kind: 'openapi',
        authScheme: 'bearer',
        credential: 'PETSTORE_API_KEY',
      });
    });

    test('multiple openapi sources in one skill: all register', async () => {
      // Two sources with disjoint paths → all operations surface.
      const secondSpec = JSON.parse(JSON.stringify(petstore)) as OpenAPIV3.Document;
      // Rename operationIds so the catalog tool names don't collide with
      // the first source. Keep it simple: prefix with "v2".
      for (const pathItem of Object.values(secondSpec.paths ?? {})) {
        if (!pathItem) continue;
        for (const method of ['get', 'post', 'put', 'patch', 'delete'] as const) {
          const op = (pathItem as Record<string, OpenAPIV3.OperationObject | undefined>)[method];
          if (op?.operationId) op.operationId = `v2_${op.operationId}`;
        }
      }
      const fetchOpenApiSpec = vi.fn()
        .mockImplementation((_skill: string, source: { spec: string }) =>
          Promise.resolve(source.spec.includes('v1') ? petstore : secondSpec));
      const catalog = new ToolCatalog();
      const result = await populateCatalogFromSkills({
        skills: [
          {
            name: 'petstore',
            ok: true,
            frontmatter: {
              openapi: [
                { spec: 'https://petstore.test/v1.json', baseUrl: 'https://petstore.test' },
                { spec: 'https://petstore.test/v2.json', baseUrl: 'https://petstore.test/v2' },
              ],
            },
          } as never,
        ],
        getMcpClient: () => ({ listTools: vi.fn() }) as never,
        fetchOpenApiSpec,
        catalog,
      });
      expect(result.openApiSourceFailures).toBe(0);
      expect(catalog.list()).toHaveLength(8); // 4 + 4
    });

    test('one bad openapi source does not poison the rest', async () => {
      // Source A parses fine; source B throws. Catalog should have A's tools
      // and count B as openApiSourceFailures=1.
      const fetchOpenApiSpec = vi.fn()
        .mockImplementation((_skill: string, source: { spec: string }) => {
          if (source.spec.includes('bad')) return Promise.reject(new Error('parse failed'));
          return Promise.resolve(petstore);
        });
      const catalog = new ToolCatalog();
      const result = await populateCatalogFromSkills({
        skills: [
          {
            name: 'petstore',
            ok: true,
            frontmatter: {
              openapi: [
                { spec: 'https://petstore.test/good.json', baseUrl: 'https://petstore.test' },
                { spec: 'https://petstore.test/bad.json', baseUrl: 'https://petstore.test' },
              ],
            },
          } as never,
        ],
        getMcpClient: () => ({ listTools: vi.fn() }) as never,
        fetchOpenApiSpec,
        catalog,
      });
      expect(result.openApiSourceFailures).toBe(1);
      expect(result.serverFailures).toBe(0);
      expect(catalog.list()).toHaveLength(4); // A's tools only
    });

    test('counts toolRegisterFailures across openapi sources (duplicate names)', async () => {
      // Two sources on the same skill produce colliding tool names — second
      // registration fails deterministically.
      const fetchOpenApiSpec = vi.fn().mockResolvedValue(petstore);
      const catalog = new ToolCatalog();
      const result = await populateCatalogFromSkills({
        skills: [
          {
            name: 'petstore',
            ok: true,
            frontmatter: {
              openapi: [
                { spec: 'https://petstore.test/a.json', baseUrl: 'https://petstore.test' },
                { spec: 'https://petstore.test/b.json', baseUrl: 'https://petstore.test' },
              ],
            },
          } as never,
        ],
        getMcpClient: () => ({ listTools: vi.fn() }) as never,
        fetchOpenApiSpec,
        catalog,
      });
      expect(result.openApiSourceFailures).toBe(0);
      expect(result.toolRegisterFailures).toBe(4); // all 4 names collide the second time
      expect(catalog.list()).toHaveLength(4);
    });

    test('MCP + OpenAPI in the same skill: both populate', async () => {
      const mcpClient = {
        listTools: vi.fn().mockResolvedValue([{ name: 'ping', inputSchema: {} }]),
      };
      const fetchOpenApiSpec = vi.fn().mockResolvedValue(petstore);
      const catalog = new ToolCatalog();
      await populateCatalogFromSkills({
        skills: [
          {
            name: 'mixed',
            ok: true,
            frontmatter: {
              mcpServers: [{ name: 'pinger' }],
              openapi: [{ spec: 'https://petstore.test/openapi.json', baseUrl: 'https://petstore.test' }],
            },
          } as never,
        ],
        getMcpClient: () => mcpClient as never,
        fetchOpenApiSpec,
        catalog,
      });
      const names = catalog.list().map(t => t.name).sort();
      expect(names).toEqual([
        'api_mixed_create_pet',
        'api_mixed_delete_pet',
        'api_mixed_get_pet_by_id',
        'api_mixed_list_pets',
        'mcp_mixed_ping',
      ]);
    });

    test('skips openapi sources when skill entry is ok: false', async () => {
      const fetchOpenApiSpec = vi.fn().mockResolvedValue(petstore);
      const catalog = new ToolCatalog();
      await populateCatalogFromSkills({
        skills: [
          { name: 'broken', ok: false, error: 'invalid' } as never,
        ],
        getMcpClient: () => ({ listTools: vi.fn() }) as never,
        fetchOpenApiSpec,
        catalog,
      });
      expect(fetchOpenApiSpec).not.toHaveBeenCalled();
      expect(catalog.list()).toEqual([]);
    });
  });

  // ── Diagnostic wiring (Task B1) ──
  // Each end-user-surfacable failure path MUST push a structured diagnostic
  // into the optional collector, so the chat UI can surface the failure
  // instead of forcing the user to grep host logs. Log lines stay; these
  // diagnostics are an ADDITIONAL parallel signal.
  describe('diagnostics', () => {
    let petstore: OpenAPIV3.Document;

    beforeAll(async () => {
      const raw = await readFile(PETSTORE_PATH, 'utf8');
      petstore = JSON.parse(raw) as OpenAPIV3.Document;
    });

    test('MCP listTools failure pushes a catalog_populate_server_failed diagnostic', async () => {
      const flaky = { listTools: vi.fn().mockRejectedValue(new Error('invalid_token')) };
      const catalog = new ToolCatalog();
      const diagnostics = createDiagnosticCollector();
      const result = await populateCatalogFromSkills({
        skills: [
          { name: 'linear', ok: true, frontmatter: { mcpServers: [{ name: 'linear-prod' }] } } as never,
        ],
        getMcpClient: () => flaky as never,
        fetchOpenApiSpec: unusedFetchOpenApiSpec,
        catalog,
        diagnostics,
      });
      // Counter behaviour unchanged — diagnostics are additive.
      expect(result.serverFailures).toBe(1);
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
        error: 'invalid_token',
      });
    });

    test('OpenAPI fetch failure pushes a catalog_populate_openapi_source_failed diagnostic', async () => {
      const fetchOpenApiSpec = vi.fn().mockRejectedValue(new Error('network timeout'));
      const catalog = new ToolCatalog();
      const diagnostics = createDiagnosticCollector();
      const result = await populateCatalogFromSkills({
        skills: [
          {
            name: 'petstore',
            ok: true,
            frontmatter: {
              openapi: [{ spec: 'https://petstore.test/openapi.json', baseUrl: 'https://petstore.test' }],
            },
          } as never,
        ],
        getMcpClient: () => ({ listTools: vi.fn() }) as never,
        fetchOpenApiSpec,
        catalog,
        diagnostics,
      });
      expect(result.openApiSourceFailures).toBe(1);
      const list = diagnostics.list();
      expect(list).toHaveLength(1);
      const [d] = list;
      expect(d.kind).toBe('catalog_populate_openapi_source_failed');
      expect(d.severity).toBe('warn');
      // Message must name BOTH the skill and the spec URL so the user
      // knows which skill + which spec blew up without grepping logs.
      expect(d.message).toContain('petstore');
      expect(d.message).toContain('https://petstore.test/openapi.json');
      expect(d.context).toMatchObject({
        skill: 'petstore',
        source: 'https://petstore.test/openapi.json',
        error: 'network timeout',
      });
    });

    test('no collector passed: function still behaves correctly and does not throw', async () => {
      const flaky = { listTools: vi.fn().mockRejectedValue(new Error('nope')) };
      const fetchOpenApiSpec = vi.fn().mockRejectedValue(new Error('nope')) as never;
      const catalog = new ToolCatalog();
      // No `diagnostics` field — optional.
      const result = await populateCatalogFromSkills({
        skills: [
          { name: 'a', ok: true, frontmatter: { mcpServers: [{ name: 's' }] } } as never,
          {
            name: 'b',
            ok: true,
            frontmatter: {
              openapi: [{ spec: 'https://x.test/spec.json', baseUrl: 'https://x.test' }],
            },
          } as never,
        ],
        getMcpClient: () => flaky as never,
        fetchOpenApiSpec,
        catalog,
      });
      // Counters still populated — just no diagnostic side-channel.
      expect(result.serverFailures).toBe(1);
      expect(result.openApiSourceFailures).toBe(1);
    });

    test('both kinds of failure in one call: both diagnostic entries land', async () => {
      const flaky = { listTools: vi.fn().mockRejectedValue(new Error('mcp boom')) };
      const fetchOpenApiSpec = vi.fn().mockRejectedValue(new Error('openapi boom'));
      const catalog = new ToolCatalog();
      const diagnostics = createDiagnosticCollector();
      await populateCatalogFromSkills({
        skills: [
          {
            name: 'skill-a',
            ok: true,
            frontmatter: { mcpServers: [{ name: 'server-a' }] },
          } as never,
          {
            name: 'skill-b',
            ok: true,
            frontmatter: {
              openapi: [{ spec: 'https://b.test/spec.json', baseUrl: 'https://b.test' }],
            },
          } as never,
        ],
        getMcpClient: () => flaky as never,
        fetchOpenApiSpec,
        catalog,
        diagnostics,
      });
      const list = diagnostics.list();
      expect(list).toHaveLength(2);
      const kinds = list.map((d) => d.kind).sort();
      expect(kinds).toEqual([
        'catalog_populate_openapi_source_failed',
        'catalog_populate_server_failed',
      ]);
      const mcp = list.find((d) => d.kind === 'catalog_populate_server_failed')!;
      expect(mcp.context).toMatchObject({ skill: 'skill-a', server: 'server-a' });
      const api = list.find((d) => d.kind === 'catalog_populate_openapi_source_failed')!;
      expect(api.context).toMatchObject({ skill: 'skill-b', source: 'https://b.test/spec.json' });
    });

    test('tool-register failures (duplicate names) do NOT push diagnostics', async () => {
      // Duplicate tool names are a skill-author concern, not end-user.
      // Deliberately NOT surfaced via diagnostics — keeps the UI noise-free
      // for a deterministic clash that a skill author can fix upstream.
      const mcpClient = {
        listTools: vi.fn().mockResolvedValue([{ name: 'shared_tool', inputSchema: {} }]),
      };
      const catalog = new ToolCatalog();
      const diagnostics = createDiagnosticCollector();
      const result = await populateCatalogFromSkills({
        skills: [
          { name: 'a', ok: true, frontmatter: { mcpServers: [{ name: 's' }] } } as never,
          { name: 'a', ok: true, frontmatter: { mcpServers: [{ name: 's' }] } } as never,
        ],
        getMcpClient: () => mcpClient as never,
        fetchOpenApiSpec: unusedFetchOpenApiSpec,
        catalog,
        diagnostics,
      });
      expect(result.toolRegisterFailures).toBe(1);
      expect(diagnostics.list()).toEqual([]);
    });
  });

  // Wide-surface advisory (Phase 8 Task 8.1). A skill author who leaves
  // `include:` off for a server/source that exceeds the threshold gets
  // an informational diagnostic nudging them to scope. Does NOT affect
  // catalog population — every tool still lands.
  describe('wide-surface advisory', () => {
    test('MCP server with >20 tools and no include filter pushes a catalog_wide_mcp_server diagnostic', async () => {
      const tools = Array.from({ length: 25 }, (_, i) => ({
        name: `tool_${i}`,
        description: `t${i}`,
        inputSchema: { type: 'object' as const },
      }));
      const mcpClient = { listTools: vi.fn().mockResolvedValue(tools) };
      const catalog = new ToolCatalog();
      const diagnostics = createDiagnosticCollector();
      await populateCatalogFromSkills({
        skills: [
          { name: 'linear', ok: true, frontmatter: { mcpServers: [{ name: 'linear' }] } } as never,
        ],
        getMcpClient: () => mcpClient as never,
        fetchOpenApiSpec: unusedFetchOpenApiSpec,
        catalog,
        diagnostics,
      });
      // Population still succeeded — 25 tools registered.
      expect(catalog.list()).toHaveLength(25);
      // And the advisory fired.
      const wide = diagnostics.list().filter(d => d.kind === 'catalog_wide_mcp_server');
      expect(wide).toHaveLength(1);
      expect(wide[0].severity).toBe('info');
      expect(wide[0].message).toContain('linear');
      expect(wide[0].message).toContain('25 tools');
      expect(wide[0].message).toMatch(/include:/);
      expect(wide[0].context).toMatchObject({
        skill: 'linear',
        server: 'linear',
        toolCount: 25,
      });
    });

    test('MCP server at exactly the threshold (20) does NOT push the advisory', async () => {
      const tools = Array.from({ length: 20 }, (_, i) => ({
        name: `tool_${i}`, inputSchema: { type: 'object' as const },
      }));
      const mcpClient = { listTools: vi.fn().mockResolvedValue(tools) };
      const catalog = new ToolCatalog();
      const diagnostics = createDiagnosticCollector();
      await populateCatalogFromSkills({
        skills: [
          { name: 's', ok: true, frontmatter: { mcpServers: [{ name: 'srv' }] } } as never,
        ],
        getMcpClient: () => mcpClient as never,
        fetchOpenApiSpec: unusedFetchOpenApiSpec,
        catalog,
        diagnostics,
      });
      expect(diagnostics.list().filter(d => d.kind === 'catalog_wide_mcp_server')).toHaveLength(0);
    });

    test('MCP server with >20 tools AND an include filter does NOT push the advisory', async () => {
      // Include filter = author explicitly scoped. Trust them — don't nag.
      const tools = Array.from({ length: 25 }, (_, i) => ({
        name: `tool_${i}`, inputSchema: { type: 'object' as const },
      }));
      const mcpClient = { listTools: vi.fn().mockResolvedValue(tools) };
      const catalog = new ToolCatalog();
      const diagnostics = createDiagnosticCollector();
      await populateCatalogFromSkills({
        skills: [
          {
            name: 's',
            ok: true,
            frontmatter: { mcpServers: [{ name: 'srv', include: ['tool_1', 'tool_2'] }] },
          } as never,
        ],
        getMcpClient: () => mcpClient as never,
        fetchOpenApiSpec: unusedFetchOpenApiSpec,
        catalog,
        diagnostics,
      });
      expect(diagnostics.list().filter(d => d.kind === 'catalog_wide_mcp_server')).toHaveLength(0);
    });

    test('OpenAPI source with >30 operations and no include filter pushes a catalog_wide_openapi_source diagnostic', async () => {
      // Build a synthetic spec with 35 GET operations.
      const paths: Record<string, unknown> = {};
      for (let i = 0; i < 35; i++) {
        paths[`/op${i}`] = {
          get: { operationId: `op${i}`, responses: { '200': { description: 'ok' } } },
        };
      }
      const fakeSpec = {
        openapi: '3.0.0',
        info: { title: 'wide', version: '1.0.0' },
        paths,
      } as unknown as OpenAPIV3.Document;
      const fetchOpenApiSpec = vi.fn().mockResolvedValue(fakeSpec);
      const catalog = new ToolCatalog();
      const diagnostics = createDiagnosticCollector();
      await populateCatalogFromSkills({
        skills: [
          {
            name: 'wide',
            ok: true,
            frontmatter: {
              openapi: [{ spec: 'https://wide.test/spec.json', baseUrl: 'https://wide.test' }],
            },
          } as never,
        ],
        getMcpClient: () => ({ listTools: vi.fn() }) as never,
        fetchOpenApiSpec,
        catalog,
        diagnostics,
      });
      expect(catalog.list()).toHaveLength(35);
      const wide = diagnostics.list().filter(d => d.kind === 'catalog_wide_openapi_source');
      expect(wide).toHaveLength(1);
      expect(wide[0].severity).toBe('info');
      expect(wide[0].message).toContain('wide');
      expect(wide[0].message).toContain('35 operations');
      expect(wide[0].message).toContain('https://wide.test/spec.json');
      expect(wide[0].context).toMatchObject({
        skill: 'wide',
        source: 'https://wide.test/spec.json',
        operationCount: 35,
      });
    });

    test('OpenAPI source with >30 operations AND an include filter does NOT push the advisory', async () => {
      const paths: Record<string, unknown> = {};
      for (let i = 0; i < 35; i++) {
        paths[`/op${i}`] = {
          get: { operationId: `op${i}`, responses: { '200': { description: 'ok' } } },
        };
      }
      const fakeSpec = {
        openapi: '3.0.0',
        info: { title: 'scoped', version: '1.0.0' },
        paths,
      } as unknown as OpenAPIV3.Document;
      const fetchOpenApiSpec = vi.fn().mockResolvedValue(fakeSpec);
      const catalog = new ToolCatalog();
      const diagnostics = createDiagnosticCollector();
      await populateCatalogFromSkills({
        skills: [
          {
            name: 'scoped',
            ok: true,
            frontmatter: {
              openapi: [{
                spec: 'https://scoped.test/spec.json',
                baseUrl: 'https://scoped.test',
                include: ['op1', 'op2'],
              }],
            },
          } as never,
        ],
        getMcpClient: () => ({ listTools: vi.fn() }) as never,
        fetchOpenApiSpec,
        catalog,
        diagnostics,
      });
      expect(diagnostics.list().filter(d => d.kind === 'catalog_wide_openapi_source')).toHaveLength(0);
    });
  });
});
