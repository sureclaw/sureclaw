// tests/providers/mcp/database.test.ts
import { describe, it, expect } from 'vitest';

describe('database MCP provider', () => {
  it('exports a create function', async () => {
    const mod = await import('../../../src/providers/mcp/database.js');
    expect(typeof mod.create).toBe('function');
  });

  describe('resolveHeaders', () => {
    it('resolves {CRED_NAME} placeholders via credential provider', async () => {
      const { resolveHeaders } = await import('../../../src/providers/mcp/database.js');
      const creds = {
        get: async (key: string) => key === 'MY_TOKEN' ? 'secret123' : null,
        set: async () => {},
        delete: async () => {},
        list: async () => [],
        listScopePrefix: async () => [],
      };
      const result = await resolveHeaders(
        JSON.stringify({ Authorization: 'Bearer {MY_TOKEN}' }),
        creds,
      );
      expect(result).toEqual({ Authorization: 'Bearer secret123' });
    });

    it('leaves placeholder if credential not found', async () => {
      const { resolveHeaders } = await import('../../../src/providers/mcp/database.js');
      const creds = {
        get: async () => null,
        set: async () => {},
        delete: async () => {},
        list: async () => [],
        listScopePrefix: async () => [],
      };
      const result = await resolveHeaders(
        JSON.stringify({ Authorization: 'Bearer {MISSING_KEY}' }),
        creds,
      );
      expect(result).toEqual({ Authorization: 'Bearer {MISSING_KEY}' });
    });

    it('handles credential values containing $ characters', async () => {
      const { resolveHeaders } = await import('../../../src/providers/mcp/database.js');
      const creds = {
        get: async (key: string) => key === 'MY_TOKEN' ? 'pa$$word$&test' : null,
        set: async () => {},
        delete: async () => {},
        list: async () => [],
        listScopePrefix: async () => [],
      };
      const result = await resolveHeaders(
        JSON.stringify({ Authorization: 'Bearer {MY_TOKEN}' }),
        creds,
      );
      expect(result).toEqual({ Authorization: 'Bearer pa$$word$&test' });
    });

    it('returns empty object for null/undefined headers', async () => {
      const { resolveHeaders } = await import('../../../src/providers/mcp/database.js');
      const creds = {
        get: async () => null,
        set: async () => {},
        delete: async () => {},
        list: async () => [],
        listScopePrefix: async () => [],
      };
      expect(await resolveHeaders(null, creds)).toEqual({});
      expect(await resolveHeaders(undefined, creds)).toEqual({});
    });
  });

  describe('parseServerFromToolName', () => {
    it('extracts server name and tool name from server__tool format', async () => {
      const { parseServerFromToolName } = await import('../../../src/providers/mcp/database.js');
      const result = parseServerFromToolName('myserver__some_tool');
      expect(result).toEqual({ server: 'myserver', tool: 'some_tool' });
    });

    it('returns undefined for unprefixed names', async () => {
      const { parseServerFromToolName } = await import('../../../src/providers/mcp/database.js');
      expect(parseServerFromToolName('just_a_tool')).toBeUndefined();
    });

    it('handles double underscores within the tool name', async () => {
      const { parseServerFromToolName } = await import('../../../src/providers/mcp/database.js');
      const result = parseServerFromToolName('srv__tool__with__underscores');
      expect(result).toEqual({ server: 'srv', tool: 'tool__with__underscores' });
    });
  });
});
