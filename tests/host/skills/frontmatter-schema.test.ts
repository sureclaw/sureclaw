import { describe, it, expect } from 'vitest';
import { SkillFrontmatterSchema } from '../../../src/host/skills/frontmatter-schema.js';

describe('SkillFrontmatterSchema', () => {
  it('accepts minimal valid frontmatter', () => {
    const parsed = SkillFrontmatterSchema.parse({
      name: 'linear',
      description: 'When the user wants to query Linear.',
    });
    expect(parsed.name).toBe('linear');
    expect(parsed.credentials).toEqual([]);
    expect(parsed.mcpServers).toEqual([]);
    expect(parsed.domains).toEqual([]);
  });

  it('requires name and description', () => {
    expect(() => SkillFrontmatterSchema.parse({ name: 'x' })).toThrow();
    expect(() => SkillFrontmatterSchema.parse({ description: 'y' })).toThrow();
  });

  it('rejects unknown top-level fields (strict)', () => {
    expect(() =>
      SkillFrontmatterSchema.parse({
        name: 'x',
        description: 'y',
        extraField: true,
      }),
    ).toThrow();
  });

  it('accepts an api_key credential (authType defaults to api_key)', () => {
    const parsed = SkillFrontmatterSchema.parse({
      name: 'x',
      description: 'y',
      credentials: [{ envName: 'FOO_TOKEN' }],
    });
    expect(parsed.credentials[0].authType).toBe('api_key');
    expect(parsed.credentials[0].scope).toBe('user');
  });

  it('accepts an oauth credential with full block', () => {
    const parsed = SkillFrontmatterSchema.parse({
      name: 'x',
      description: 'y',
      credentials: [
        {
          envName: 'LINEAR_TOKEN',
          authType: 'oauth',
          scope: 'user',
          oauth: {
            provider: 'linear',
            clientId: 'pub_abc',
            authorizationUrl: 'https://linear.app/oauth/authorize',
            tokenUrl: 'https://api.linear.app/oauth/token',
            scopes: ['read'],
          },
        },
      ],
    });
    expect(parsed.credentials[0].oauth?.provider).toBe('linear');
  });

  it('rejects oauth authType without oauth block', () => {
    expect(() =>
      SkillFrontmatterSchema.parse({
        name: 'x',
        description: 'y',
        credentials: [{ envName: 'X', authType: 'oauth' }],
      }),
    ).toThrow();
  });

  it('rejects envName that is not SCREAMING_SNAKE_CASE', () => {
    expect(() =>
      SkillFrontmatterSchema.parse({
        name: 'x',
        description: 'y',
        credentials: [{ envName: 'lowercase' }],
      }),
    ).toThrow();
  });

  it('accepts mcpServers referencing a credential by envName', () => {
    const parsed = SkillFrontmatterSchema.parse({
      name: 'x',
      description: 'y',
      credentials: [{ envName: 'FOO_TOKEN' }],
      mcpServers: [
        { name: 'foo', url: 'https://mcp.foo.com/sse', credential: 'FOO_TOKEN' },
      ],
    });
    expect(parsed.mcpServers[0].credential).toBe('FOO_TOKEN');
  });

  it('defaults mcpServers.transport to http for non-sse URLs', () => {
    const parsed = SkillFrontmatterSchema.parse({
      name: 'x',
      description: 'y',
      mcpServers: [{ name: 'foo', url: 'https://mcp.foo.com/mcp' }],
    });
    expect(parsed.mcpServers[0].transport).toBe('http');
  });

  it('infers transport: sse from URL path ending in /sse when field is omitted', () => {
    // Regression: agent-authored skills often copy vendor URLs without
    // knowing to add `transport: sse`. URL-based inference catches the
    // common case (Linear's `mcp.linear.app/sse`) so the skill works
    // without the admin having to manually edit the SKILL.md.
    const parsed = SkillFrontmatterSchema.parse({
      name: 'linear',
      description: 'Query Linear.',
      mcpServers: [{ name: 'linear', url: 'https://mcp.linear.app/sse' }],
    });
    expect(parsed.mcpServers[0].transport).toBe('sse');
  });

  it('explicit transport: http overrides URL-based inference', () => {
    // Escape hatch — if a vendor has a weird URL that ends in /sse but
    // actually speaks Streamable HTTP, the skill author can force it.
    const parsed = SkillFrontmatterSchema.parse({
      name: 'x',
      description: 'y',
      mcpServers: [
        { name: 'n', url: 'https://weird.example/sse', transport: 'http' },
      ],
    });
    expect(parsed.mcpServers[0].transport).toBe('http');
  });

  it('accepts transport: sse explicitly for legacy-transport servers like Linear', () => {
    const parsed = SkillFrontmatterSchema.parse({
      name: 'linear',
      description: 'Query Linear.',
      mcpServers: [
        { name: 'linear', url: 'https://mcp.linear.app/sse', transport: 'sse' },
      ],
    });
    expect(parsed.mcpServers[0].transport).toBe('sse');
  });

  it('rejects unknown transport values', () => {
    expect(() =>
      SkillFrontmatterSchema.parse({
        name: 'x',
        description: 'y',
        mcpServers: [
          { name: 'n', url: 'https://mcp.example/sse', transport: 'websocket' },
        ],
      }),
    ).toThrow();
  });

  it('accepts domains and source', () => {
    const parsed = SkillFrontmatterSchema.parse({
      name: 'x',
      description: 'y',
      domains: ['api.linear.app'],
      source: { url: 'https://github.com/a/b', version: 'v1.0' },
    });
    expect(parsed.domains).toEqual(['api.linear.app']);
    expect(parsed.source?.version).toBe('v1.0');
  });

  it('rejects mcpServer URL that is not https', () => {
    expect(() =>
      SkillFrontmatterSchema.parse({
        name: 'x',
        description: 'y',
        mcpServers: [{ name: 'n', url: 'http://insecure.example' }],
      }),
    ).toThrow();
  });

  it('rejects domains that are not valid hostnames', () => {
    const bad = ['not a host', 'api.linear.app/path', 'https://api.linear.app', '.leading.dot', 'trailing.dot.', 'a..b'];
    for (const domain of bad) {
      expect(() =>
        SkillFrontmatterSchema.parse({ name: 'x', description: 'y', domains: [domain] }),
      ).toThrow();
    }
  });

  it('accepts leading-label wildcard domains like *.salesforce.com', () => {
    // Many multi-tenant vendors give every org a subdomain (`acme.my.salesforce.com`,
    // `coolco.my.salesforce.com`). Admins can't list them all up front — a
    // standard TLS-style `*.` wildcard covering "every subdomain of this parent"
    // is the intent.
    const parsed = SkillFrontmatterSchema.parse({
      name: 'salesforce',
      description: 'CLI skill.',
      domains: ['login.salesforce.com', '*.my.salesforce.com', '*.salesforce.com'],
    });
    expect(parsed.domains).toEqual([
      'login.salesforce.com',
      '*.my.salesforce.com',
      '*.salesforce.com',
    ]);
  });

  it('normalizes wildcard domains to lowercase and trims whitespace', () => {
    const parsed = SkillFrontmatterSchema.parse({
      name: 'x',
      description: 'y',
      domains: ['  *.My.Salesforce.Com  '],
    });
    expect(parsed.domains).toEqual(['*.my.salesforce.com']);
  });

  it('rejects overly broad / malformed wildcard patterns', () => {
    // Each of these is either too broad (`*`, `*.com`) or structurally wrong
    // (mid-label wildcards, double-star deep wildcards). A bare `*` would let
    // a single skill approve universal egress; `*.com` would match every .com
    // domain in existence. Both would be catastrophic blast radii.
    const bad = [
      '*',                  // nothing specific — blanket
      '*.com',              // public suffix — matches every .com
      '*.*.salesforce.com', // multi-label wildcards not supported
      'foo.*.com',          // mid-label wildcard
      'api*.salesforce.com',// partial-label wildcard
      '**.salesforce.com',  // Apache-style double-star
      '*.',                 // trailing nothing
    ];
    for (const domain of bad) {
      expect(() =>
        SkillFrontmatterSchema.parse({ name: 'x', description: 'y', domains: [domain] }),
      ).toThrow();
    }
  });

  it('normalizes domains to lowercase and trims whitespace', () => {
    const parsed = SkillFrontmatterSchema.parse({
      name: 'x',
      description: 'y',
      domains: ['  API.Linear.App  '],
    });
    expect(parsed.domains).toEqual(['api.linear.app']);
  });

  it('rejects mcpServers[].credential as a nested object with an actionable error message', () => {
    // Regression: agents drafting skills sometimes try to nest a full
    // credential definition inside `mcpServers[].credential`, mimicking
    // the Claude-Desktop config shape. The field is actually a STRING
    // envName reference pointing at an entry in the top-level
    // `credentials:` array. The default Zod error "expected string,
    // received object" doesn't tell the agent what to do — the custom
    // message names the mistake and points to the correct shape.
    const result = SkillFrontmatterSchema.safeParse({
      name: 'x',
      description: 'y',
      credentials: [{ envName: 'FOO_TOKEN' }],
      mcpServers: [{
        name: 'foo',
        url: 'https://mcp.foo.com/mcp',
        credential: { envName: 'FOO_TOKEN', authType: 'api_key' },
      }],
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    const credIssue = result.error.issues.find(i => i.path.join('.').endsWith('credential'));
    expect(credIssue).toBeDefined();
    // Must mention the correct shape: a string envName reference.
    expect(credIssue?.message).toMatch(/string envName/i);
    expect(credIssue?.message).toMatch(/credentials\[/);
  });

  it('accepts a CLI-only skill with credentials + domains and no mcpServers', () => {
    // Positive example of the pattern agents miss: services like the
    // Salesforce CLI don't offer an MCP endpoint — the skill just
    // declares credentials and an extra domain. `mcpServers` is
    // legitimately absent (defaults to []).
    const parsed = SkillFrontmatterSchema.parse({
      name: 'salesforce',
      description: 'Query and update Salesforce records via the sf CLI.',
      credentials: [{ envName: 'SALESFORCE_ACCESS_TOKEN' }],
      domains: ['login.salesforce.com', 'my-org.my.salesforce.com'],
    });
    expect(parsed.mcpServers).toEqual([]);
    expect(parsed.credentials).toHaveLength(1);
    expect(parsed.domains).toHaveLength(2);
  });

  it('accepts multi-label hostnames including multi-part TLDs', () => {
    const parsed = SkillFrontmatterSchema.parse({
      name: 'x',
      description: 'y',
      domains: ['api.example.co.uk', 'mcp.linear.app'],
    });
    expect(parsed.domains).toEqual(['api.example.co.uk', 'mcp.linear.app']);
  });
});
