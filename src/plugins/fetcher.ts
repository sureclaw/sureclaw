import { readdirSync, readFileSync, statSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

export type PluginSource =
  | { type: 'github'; owner: string; repo: string; subdir?: string; ref?: string }
  | { type: 'local'; path: string }
  | { type: 'url'; url: string };

export function parsePluginSource(input: string): PluginSource {
  // Local paths: starts with ./ or / or ../
  if (input.startsWith('./') || input.startsWith('/') || input.startsWith('../')) {
    return { type: 'local', path: input };
  }
  // URLs
  if (input.startsWith('https://') || input.startsWith('http://')) {
    return { type: 'url', url: input };
  }
  // GitHub: owner/repo or owner/repo/subdir
  const parts = input.split('/');
  if (parts.length >= 2) {
    return {
      type: 'github',
      owner: parts[0],
      repo: parts[1],
      subdir: parts.length > 2 ? parts.slice(2).join('/') : undefined,
    };
  }
  throw new Error(`Cannot parse plugin source: "${input}". Use owner/repo/path, ./local-dir, or https://url`);
}

const SKIP_DIRS = new Set(['.git', 'node_modules', '.DS_Store']);
const SKIP_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.svg', '.woff', '.woff2', '.ttf', '.eot']);

function readDirRecursive(baseDir: string, currentDir: string, files: Map<string, string>): void {
  for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const fullPath = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      readDirRecursive(baseDir, fullPath, files);
    } else if (entry.isFile()) {
      const ext = entry.name.substring(entry.name.lastIndexOf('.'));
      if (SKIP_EXTENSIONS.has(ext)) continue;
      const relPath = relative(baseDir, fullPath);
      try {
        files.set(relPath, readFileSync(fullPath, 'utf-8'));
      } catch { /* skip binary/unreadable */ }
    }
  }
}

export async function fetchPluginFiles(source: PluginSource): Promise<Map<string, string>> {
  switch (source.type) {
    case 'local': return fetchLocal(source.path);
    case 'github': return fetchGitHub(source);
    case 'url': return fetchUrl(source.url);
  }
}

function fetchLocal(dirPath: string): Promise<Map<string, string>> {
  const resolved = resolve(dirPath);
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    throw new Error(`Plugin directory not found: ${resolved}`);
  }
  const files = new Map<string, string>();
  readDirRecursive(resolved, resolved, files);
  return Promise.resolve(files);
}

async function fetchGitHub(source: { owner: string; repo: string; subdir?: string; ref?: string }): Promise<Map<string, string>> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'ax-plugin-gh-'));
  try {
    const repoUrl = `https://github.com/${source.owner}/${source.repo}.git`;
    const args = ['clone', '--depth', '1', '--single-branch'];
    if (source.ref) args.push('--branch', source.ref);
    args.push(repoUrl, tmpDir);
    execFileSync('git', args, { stdio: 'pipe', timeout: 60_000 });

    const pluginDir = source.subdir ? join(tmpDir, source.subdir) : tmpDir;
    if (!existsSync(pluginDir)) {
      throw new Error(`Subdirectory "${source.subdir}" not found in ${source.owner}/${source.repo}`);
    }
    const files = new Map<string, string>();
    readDirRecursive(pluginDir, pluginDir, files);
    return files;
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function fetchUrl(url: string): Promise<Map<string, string>> {
  const ghMatch = url.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/tree\/([^/]+)\/(.+))?$/);
  if (ghMatch) {
    return fetchGitHub({
      owner: ghMatch[1],
      repo: ghMatch[2],
      ref: ghMatch[3],
      subdir: ghMatch[4],
    });
  }
  throw new Error(`Unsupported plugin URL format: ${url}. Currently only GitHub URLs are supported.`);
}
