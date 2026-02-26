/**
 * ClawHub registry client — fetches and caches skills from the public registry.
 *
 * Not a provider (no create() pattern). Utility class used by IPC handlers.
 * All file paths use safePath(). Cache TTL 1 hour.
 */

import { join } from 'node:path';
import { mkdir, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { safePath } from '../utils/safe-path.js';
import { axHome } from '../paths.js';

const CLAWHUB_API = 'https://registry.clawhub.dev/api/v1';
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

export interface ClawHubSkillEntry {
  name: string;
  author: string;
  description: string;
  version: string;
  downloads: number;
  score?: number;
}

export interface ClawHubSkillDetail {
  name: string;
  author: string;
  description: string;
  version: string;
  skillMd: string;
  files: string[];
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
    headers: { 'Accept': 'application/json', 'User-Agent': 'ax-agent/1.0' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`ClawHub API error: ${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}

/**
 * Search ClawHub for skills matching a query.
 */
export async function search(query: string, limit = 20): Promise<ClawHubSkillEntry[]> {
  const cacheKey = `search-${query.replace(/[^a-zA-Z0-9-]/g, '_')}-${limit}`;
  const cached = await readCached(cacheKey);
  if (cached) return JSON.parse(cached);

  const url = `${CLAWHUB_API}/skills/search?q=${encodeURIComponent(query)}&limit=${limit}`;
  const results = await fetchJson<{ skills: ClawHubSkillEntry[] }>(url);
  await writeCache(cacheKey, JSON.stringify(results.skills));
  return results.skills;
}

/**
 * Fetch a specific skill by name (author/skill or just skill name).
 */
export async function fetchSkill(name: string): Promise<ClawHubSkillDetail> {
  const cacheKey = `skill-${name.replace(/[^a-zA-Z0-9-]/g, '_')}`;
  const cached = await readCached(cacheKey);
  if (cached) return JSON.parse(cached);

  const url = `${CLAWHUB_API}/skills/${encodeURIComponent(name)}`;
  const detail = await fetchJson<ClawHubSkillDetail>(url);
  await writeCache(cacheKey, JSON.stringify(detail));
  return detail;
}

/**
 * List popular skills from ClawHub.
 */
export async function listPopular(limit = 20): Promise<ClawHubSkillEntry[]> {
  const cacheKey = `popular-${limit}`;
  const cached = await readCached(cacheKey);
  if (cached) return JSON.parse(cached);

  const url = `${CLAWHUB_API}/skills/popular?limit=${limit}`;
  const results = await fetchJson<{ skills: ClawHubSkillEntry[] }>(url);
  await writeCache(cacheKey, JSON.stringify(results.skills));
  return results.skills;
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
