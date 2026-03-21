/**
 * ClawHub registry client — fetches and caches skills from clawhub.ai.
 *
 * Not a provider (no create() pattern). Utility class used by IPC handlers.
 * All file paths use safePath(). Cache TTL 1 hour.
 *
 * API base: https://clawhub.ai/api/v1 (discovered via /.well-known/clawhub.json)
 * Skills are distributed as ZIP files; SKILL.md is extracted from the archive.
 */

import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { mkdir, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { safePath } from '../utils/safe-path.js';
import { axHome } from '../paths.js';

function clawHubApi(): string {
  return process.env.CLAWHUB_API_URL || 'https://clawhub.ai/api/v1';
}

function authHeaders(): Record<string, string> {
  const token = process.env.CLAWHUB_TOKEN;
  return token ? { Authorization: `Bearer ${token}` } : {};
}
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

export interface ClawHubSkillEntry {
  slug: string;
  displayName: string;
  summary: string | null;
  version: string | null;
  score?: number;
  updatedAt?: number;
}

export interface ClawHubSkillDetail {
  slug: string;
  displayName: string;
  summary: string | null;
  skillMd: string;
}

function cacheDir(): string {
  return join(axHome(), 'cache', 'clawhub');
}

async function ensureCacheDir(): Promise<string> {
  const dir = cacheDir();
  await mkdir(dir, { recursive: true });
  return dir;
}

async function readCached(key: string): Promise<string | null> {
  try {
    const dir = cacheDir();
    const path = safePath(dir, `${key}.json`);
    const meta = await stat(path);
    if (Date.now() - meta.mtimeMs > CACHE_TTL_MS) return null;
    return await readFile(path, 'utf-8');
  } catch {
    return null;
  }
}

async function writeCache(key: string, data: string): Promise<void> {
  try {
    const dir = await ensureCacheDir();
    const path = safePath(dir, `${key}.json`);
    await writeFile(path, data, 'utf-8');
  } catch {
    // Cache write failures are non-fatal
  }
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: { 'Accept': 'application/json', 'User-Agent': 'ax-agent/1.0', ...authHeaders() },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`ClawHub API error: ${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}

async function fetchBinary(url: string): Promise<Buffer> {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'ax-agent/1.0', ...authHeaders() },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`ClawHub API error: ${response.status} ${response.statusText}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

/**
 * Extract ALL text files from a ZIP buffer using the Central Directory.
 * Skips directories and binary-looking entries. Returns a map of path → content.
 * Strips a single common root prefix if all entries share one (e.g. "slug/SKILL.md" → "SKILL.md").
 */
export function extractAllFromZip(buf: Buffer): Map<string, string> {
  const files = new Map<string, string>();

  // Locate EOCD
  let eocdPos = -1;
  const searchStart = Math.max(0, buf.length - 65558);
  for (let i = buf.length - 22; i >= searchStart; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocdPos = i; break; }
  }
  if (eocdPos === -1) throw new Error('ZIP: EOCD record not found');

  const cdCount = buf.readUInt16LE(eocdPos + 10);
  const cdOffset = buf.readUInt32LE(eocdPos + 16);

  let pos = cdOffset;
  for (let i = 0; i < cdCount; i++) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) break;

    const method = buf.readUInt16LE(pos + 10);
    const compressedSize = buf.readUInt32LE(pos + 20);
    const fileNameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localHeaderOffset = buf.readUInt32LE(pos + 42);
    const fileName = buf.toString('utf8', pos + 46, pos + 46 + fileNameLen);

    pos += 46 + fileNameLen + extraLen + commentLen;

    // Skip directories and unsupported compression methods
    if (fileName.endsWith('/') || (method !== 0 && method !== 8)) continue;
    // Skip obviously binary files
    if (/\.(png|jpg|jpeg|gif|ico|woff|woff2|ttf|eot|zip|gz|tar|bin|exe|dll|so|dylib)$/i.test(fileName)) continue;

    const lhFileNameLen = buf.readUInt16LE(localHeaderOffset + 26);
    const lhExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + lhFileNameLen + lhExtraLen;
    const data = buf.subarray(dataStart, dataStart + compressedSize);
    try {
      const content = (method === 0 ? data : inflateRawSync(data)).toString('utf8');
      files.set(fileName, content);
    } catch {
      // Skip undecompressable entries
    }
  }

  // Strip common root prefix (many ZIPs have a single root directory)
  if (files.size > 0) {
    const paths = [...files.keys()];
    const firstSlash = paths[0].indexOf('/');
    if (firstSlash > 0) {
      const prefix = paths[0].slice(0, firstSlash + 1);
      if (paths.every(p => p.startsWith(prefix))) {
        const stripped = new Map<string, string>();
        for (const [p, c] of files) stripped.set(p.slice(prefix.length), c);
        return stripped;
      }
    }
  }

  return files;
}

/**
 * Extract a named file from a ZIP buffer using the Central Directory.
 * Supports stored (method 0) and deflate-compressed (method 8) entries.
 * Returns null if the file is not found.
 */
export function extractFileFromZip(buf: Buffer, targetName: string): string | null {
  // Locate End of Central Directory record (signature 0x06054b50)
  let eocdPos = -1;
  const searchStart = Math.max(0, buf.length - 65558); // max comment = 65535 bytes
  for (let i = buf.length - 22; i >= searchStart; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocdPos = i;
      break;
    }
  }
  if (eocdPos === -1) throw new Error('ZIP: EOCD record not found');

  const cdCount = buf.readUInt16LE(eocdPos + 10);
  const cdOffset = buf.readUInt32LE(eocdPos + 16);

  // Scan Central Directory entries
  let pos = cdOffset;
  for (let i = 0; i < cdCount; i++) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) break; // central directory signature

    const method = buf.readUInt16LE(pos + 10);
    const compressedSize = buf.readUInt32LE(pos + 20);
    const fileNameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localHeaderOffset = buf.readUInt32LE(pos + 42);
    const fileName = buf.toString('utf8', pos + 46, pos + 46 + fileNameLen);

    if (fileName === targetName || fileName.endsWith(`/${targetName}`)) {
      // Use local file header to find the data start
      const lhFileNameLen = buf.readUInt16LE(localHeaderOffset + 26);
      const lhExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
      const dataStart = localHeaderOffset + 30 + lhFileNameLen + lhExtraLen;
      const data = buf.subarray(dataStart, dataStart + compressedSize);
      return (method === 0 ? data : inflateRawSync(data)).toString('utf8');
    }

    pos += 46 + fileNameLen + extraLen + commentLen;
  }

  return null;
}

/**
 * Search ClawHub for skills matching a query.
 */
export async function search(query: string, limit = 20): Promise<ClawHubSkillEntry[]> {
  const cacheKey = `search-${query.replace(/[^a-zA-Z0-9-]/g, '_')}-${limit}`;
  const cached = await readCached(cacheKey);
  if (cached) return JSON.parse(cached);

  const url = `${clawHubApi()}/search?q=${encodeURIComponent(query)}&limit=${limit}`;
  const response = await fetchJson<{ results: ClawHubSkillEntry[] }>(url);
  await writeCache(cacheKey, JSON.stringify(response.results));
  return response.results;
}

/**
 * Fetch a specific skill by slug, downloading and extracting SKILL.md from the ZIP.
 */
export async function fetchSkill(slug: string): Promise<ClawHubSkillDetail> {
  const cacheKey = `skill-${slug.replace(/[^a-zA-Z0-9-]/g, '_')}`;
  const cached = await readCached(cacheKey);
  if (cached) return JSON.parse(cached);

  // Download ZIP and search for metadata concurrently
  const [zipBytes, searchResults] = await Promise.all([
    fetchBinary(`${clawHubApi()}/download?slug=${encodeURIComponent(slug)}`),
    search(slug, 1).catch(() => [] as ClawHubSkillEntry[]),
  ]);

  const skillMd = extractFileFromZip(zipBytes, 'SKILL.md');
  if (!skillMd) {
    throw new Error(`ClawHub: SKILL.md not found in zip for "${slug}"`);
  }

  const meta = searchResults[0];
  const detail: ClawHubSkillDetail = {
    slug,
    displayName: meta?.displayName ?? slug,
    summary: meta?.summary ?? null,
    skillMd,
  };

  await writeCache(cacheKey, JSON.stringify(detail));
  return detail;
}

export interface ClawHubSkillPackage {
  slug: string;
  displayName: string;
  files: Array<{ path: string; content: string }>;
  requiresEnv: string[];
}

/**
 * Download a skill package: all files from the ZIP plus parsed requires.env.
 */
export async function fetchSkillPackage(slug: string): Promise<ClawHubSkillPackage> {
  const [zipBytes, searchResults] = await Promise.all([
    fetchBinary(`${clawHubApi()}/download?slug=${encodeURIComponent(slug)}`),
    search(slug, 1).catch(() => [] as ClawHubSkillEntry[]),
  ]);

  const allFiles = extractAllFromZip(zipBytes);
  if (allFiles.size === 0) {
    throw new Error(`ClawHub: no files found in zip for "${slug}"`);
  }

  // Parse SKILL.md for requires.env
  const skillMd = allFiles.get('SKILL.md');
  let requiresEnv: string[] = [];
  if (skillMd) {
    try {
      // Dynamic import to avoid circular dep at module level
      const { parseAgentSkill } = await import('../utils/skill-format-parser.js');
      const parsed = parseAgentSkill(skillMd);
      requiresEnv = parsed.requires.env;
    } catch {
      // Best effort — if parsing fails, we still return the files
    }
  }

  const meta = searchResults[0];
  const files = [...allFiles.entries()].map(([path, content]) => ({ path, content }));

  return {
    slug,
    displayName: meta?.displayName ?? slug,
    files,
    requiresEnv,
  };
}

/**
 * List popular skills from ClawHub, sorted by downloads.
 */
export async function listPopular(limit = 20): Promise<ClawHubSkillEntry[]> {
  const cacheKey = `popular-${limit}`;
  const cached = await readCached(cacheKey);
  if (cached) return JSON.parse(cached);

  const url = `${clawHubApi()}/skills?sort=downloads&limit=${limit}`;
  const response = await fetchJson<{
    items: Array<{
      slug: string;
      displayName: string;
      summary?: string | null;
      latestVersion?: { version: string } | null;
    }>;
  }>(url);

  const entries: ClawHubSkillEntry[] = response.items.map(item => ({
    slug: item.slug,
    displayName: item.displayName,
    summary: item.summary ?? null,
    version: item.latestVersion?.version ?? null,
  }));

  await writeCache(cacheKey, JSON.stringify(entries));
  return entries;
}

/**
 * List all cached skills (available offline).
 */
export async function listCached(): Promise<string[]> {
  try {
    const dir = cacheDir();
    const files = await readdir(dir);
    return files
      .filter(f => f.startsWith('skill-') && f.endsWith('.json'))
      .map(f => f.slice('skill-'.length, -'.json'.length));
  } catch {
    return [];
  }
}
