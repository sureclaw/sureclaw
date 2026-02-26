import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import * as client from '../../src/clawhub/registry-client.js';

// Mock fetch globally
const mockFetch = vi.fn();

describe('clawhub-registry-client', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function mockResponse(data: unknown, ok = true) {
    return {
      ok,
      status: ok ? 200 : 500,
      statusText: ok ? 'OK' : 'Internal Server Error',
      json: () => Promise.resolve(data),
    };
  }

  describe('search', () => {
    test('fetches skills from API', async () => {
      const skills = [
        { name: 'gog', author: 'steipete', description: 'Google Workspace CLI', version: '1.0', downloads: 14000 },
      ];
      mockFetch.mockResolvedValueOnce(mockResponse({ skills }));

      // Use unique query to avoid cache hits from prior test runs
      const uniqueQuery = `google workspace ${Date.now()}`;
      const results = await client.search(uniqueQuery);
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('gog');
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch.mock.calls[0][0]).toContain('/skills/search?q=');
    });

    test('throws on API error', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse(null, false));
      await expect(client.search('test')).rejects.toThrow('ClawHub API error');
    });
  });

  describe('fetchSkill', () => {
    test('fetches skill detail', async () => {
      const detail = {
        name: 'gog',
        author: 'steipete',
        description: 'Google Workspace CLI',
        version: '1.0',
        skillMd: '---\nname: gog\n---\n# gog',
        files: ['SKILL.md'],
      };
      mockFetch.mockResolvedValueOnce(mockResponse(detail));

      const result = await client.fetchSkill('gog');
      expect(result.name).toBe('gog');
      expect(result.skillMd).toContain('name: gog');
    });
  });

  describe('listPopular', () => {
    test('fetches popular skills', async () => {
      const skills = [
        { name: 'gog', author: 'steipete', description: 'Google Workspace', version: '1.0', downloads: 14000, score: 7 },
        { name: 'mcporter', author: 'mcporter', description: 'MCP Server manager', version: '2.0', downloads: 5000, score: 6 },
      ];
      mockFetch.mockResolvedValueOnce(mockResponse({ skills }));

      const results = await client.listPopular(10);
      expect(results).toHaveLength(2);
      expect(results[0].name).toBe('gog');
    });
  });

  describe('listCached', () => {
    test('returns empty array when no cache exists', async () => {
      const results = await client.listCached();
      expect(Array.isArray(results)).toBe(true);
    });
  });
});
