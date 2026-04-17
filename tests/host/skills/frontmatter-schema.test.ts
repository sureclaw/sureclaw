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

  it('normalizes domains to lowercase and trims whitespace', () => {
    const parsed = SkillFrontmatterSchema.parse({
      name: 'x',
      description: 'y',
      domains: ['  API.Linear.App  '],
    });
    expect(parsed.domains).toEqual(['api.linear.app']);
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
