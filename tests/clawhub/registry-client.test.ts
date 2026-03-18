import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';

// Must be set before importing registry-client so axHome() resolves to the temp dir
let tmpHome: string;
tmpHome = mkdtempSync(join(tmpdir(), 'ax-clawhub-test-'));
process.env.AX_HOME = tmpHome;

import * as client from '../../src/clawhub/registry-client.js';

// Mock fetch globally
const mockFetch = vi.fn();

/**
 * Build a minimal valid ZIP containing stored (uncompressed) file entries.
 * Enough for extractFileFromZip() to parse correctly.
 */
function buildStoredZip(files: Record<string, string>): Buffer {
  const parts: Buffer[] = [];
  const entries: Array<{ name: Buffer; data: Buffer; offset: number }> = [];

  for (const [name, content] of Object.entries(files)) {
    const nameBuf = Buffer.from(name, 'utf8');
    const dataBuf = Buffer.from(content, 'utf8');
    const offset = parts.reduce((sum, p) => sum + p.length, 0);

    const lh = Buffer.alloc(30 + nameBuf.length);
    lh.writeUInt32LE(0x04034b50, 0);       // local file header signature
    lh.writeUInt16LE(20, 4);               // version needed
    lh.writeUInt16LE(0, 6);               // flags
    lh.writeUInt16LE(0, 8);               // method: stored
    lh.writeUInt32LE(0, 14);              // CRC-32 (zeroed; not validated)
    lh.writeUInt32LE(dataBuf.length, 18); // compressed size
    lh.writeUInt32LE(dataBuf.length, 22); // uncompressed size
    lh.writeUInt16LE(nameBuf.length, 26); // filename length
    lh.writeUInt16LE(0, 28);              // extra length
    nameBuf.copy(lh, 30);

    parts.push(lh, dataBuf);
    entries.push({ name: nameBuf, data: dataBuf, offset });
  }

  const cdOffset = parts.reduce((sum, p) => sum + p.length, 0);

  for (const entry of entries) {
    const cd = Buffer.alloc(46 + entry.name.length);
    cd.writeUInt32LE(0x02014b50, 0);       // central directory signature
    cd.writeUInt16LE(20, 4);               // version made by
    cd.writeUInt16LE(20, 6);               // version needed
    cd.writeUInt32LE(0, 16);              // CRC-32
    cd.writeUInt32LE(entry.data.length, 20); // compressed size
    cd.writeUInt32LE(entry.data.length, 24); // uncompressed size
    cd.writeUInt16LE(entry.name.length, 28); // filename length
    cd.writeUInt16LE(0, 30);              // extra length
    cd.writeUInt16LE(0, 32);              // comment length
    cd.writeUInt32LE(entry.offset, 42);   // local header offset
    entry.name.copy(cd, 46);
    parts.push(cd);
  }

  const cdSize = parts.reduce((sum, p) => sum + p.length, 0) - cdOffset;

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);     // EOCD signature
  eocd.writeUInt16LE(entries.length, 8); // entries on this disk
  eocd.writeUInt16LE(entries.length, 10);// total entries
  eocd.writeUInt32LE(cdSize, 12);        // CD size
  eocd.writeUInt32LE(cdOffset, 16);      // CD offset
  parts.push(eocd);

  return Buffer.concat(parts);
}

describe('clawhub-registry-client', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  afterAll(() => {
    try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  function mockJsonResponse(data: unknown, ok = true) {
    return {
      ok,
      status: ok ? 200 : 500,
      statusText: ok ? 'OK' : 'Internal Server Error',
      json: () => Promise.resolve(data),
    };
  }

  function mockBinaryResponse(buf: Buffer, ok = true) {
    return {
      ok,
      status: ok ? 200 : 500,
      statusText: ok ? 'OK' : 'Internal Server Error',
      arrayBuffer: () => Promise.resolve(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)),
    };
  }

  describe('extractFileFromZip', () => {
    test('extracts stored file by exact name', () => {
      const zip = buildStoredZip({ 'SKILL.md': '---\nname: test\n---' });
      expect(client.extractFileFromZip(zip, 'SKILL.md')).toBe('---\nname: test\n---');
    });

    test('extracts stored file by path suffix', () => {
      const zip = buildStoredZip({ 'some/nested/SKILL.md': '# nested' });
      expect(client.extractFileFromZip(zip, 'SKILL.md')).toBe('# nested');
    });

    test('returns null for missing file', () => {
      const zip = buildStoredZip({ 'README.md': 'hello' });
      expect(client.extractFileFromZip(zip, 'SKILL.md')).toBeNull();
    });
  });

  describe('search', () => {
    test('fetches skills from /api/v1/search', async () => {
      const results = [
        { slug: 'gog', displayName: 'Google Workspace CLI', summary: 'Google Workspace', version: '1.0', score: 7.2 },
      ];
      mockFetch.mockResolvedValueOnce(mockJsonResponse({ results }));

      const uniqueQuery = `google workspace ${Date.now()}`;
      const found = await client.search(uniqueQuery);
      expect(found).toHaveLength(1);
      expect(found[0].slug).toBe('gog');
      expect(found[0].displayName).toBe('Google Workspace CLI');
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch.mock.calls[0][0]).toContain('/api/v1/search?q=');
    });

    test('throws on API error', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse(null, false));
      await expect(client.search('test')).rejects.toThrow('ClawHub API error');
    });
  });

  describe('fetchSkill', () => {
    test('downloads ZIP and extracts SKILL.md', async () => {
      const skillMdContent = '---\nname: my-skill\n---\n# My Skill';
      const zip = buildStoredZip({ 'SKILL.md': skillMdContent });

      // First call: download ZIP; second call: search for metadata
      mockFetch
        .mockResolvedValueOnce(mockBinaryResponse(zip))
        .mockResolvedValueOnce(mockJsonResponse({
          results: [{ slug: 'my-skill', displayName: 'My Skill', summary: 'Does things', version: '1.0', score: 5 }],
        }));

      const uniqueSlug = `my-skill-${Date.now()}`;
      const detail = await client.fetchSkill(uniqueSlug);
      expect(detail.skillMd).toBe(skillMdContent);
    });

    test('throws when SKILL.md is missing from ZIP', async () => {
      const zip = buildStoredZip({ 'README.md': 'no skill here' });
      mockFetch
        .mockResolvedValueOnce(mockBinaryResponse(zip))
        .mockResolvedValueOnce(mockJsonResponse({ results: [] }));

      const uniqueSlug = `missing-skill-${Date.now()}`;
      await expect(client.fetchSkill(uniqueSlug)).rejects.toThrow('SKILL.md not found in zip');
    });

    test('throws on download API error', async () => {
      // fetchSkill runs fetchBinary and search concurrently via Promise.all.
      // When fetchBinary fails, search is still running in the background and
      // will call fetch once readCached resolves — register a mock for it too
      // so the floating promise doesn't consume the next test's mock.
      mockFetch
        .mockResolvedValueOnce(mockBinaryResponse(Buffer.alloc(0), false)) // download fails
        .mockResolvedValueOnce(mockJsonResponse({ results: [] }));          // search (background)

      const uniqueSlug = `error-skill-${Date.now()}`;
      await expect(client.fetchSkill(uniqueSlug)).rejects.toThrow('ClawHub API error');
      // Allow the background search promise to settle before the test ends
      await new Promise(resolve => setTimeout(resolve, 10));
    });
  });

  describe('listPopular', () => {
    test('fetches popular skills from /api/v1/skills', async () => {
      const items = [
        { slug: 'gog', displayName: 'Google Workspace', summary: 'Google CLI', latestVersion: { version: '1.0' } },
        { slug: 'mcporter', displayName: 'MCP Porter', summary: 'MCP manager', latestVersion: null },
      ];
      mockFetch.mockResolvedValueOnce(mockJsonResponse({ items, nextCursor: null }));

      const results = await client.listPopular(10);
      expect(results).toHaveLength(2);
      expect(results[0].slug).toBe('gog');
      expect(results[0].version).toBe('1.0');
      expect(results[1].version).toBeNull();
      expect(mockFetch.mock.calls[0][0]).toContain('/api/v1/skills');
    });
  });

  describe('listCached', () => {
    test('returns empty array when no cache exists', async () => {
      const results = await client.listCached();
      expect(Array.isArray(results)).toBe(true);
    });
  });
});
