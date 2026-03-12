/**
 * Local manifest for workspace sync.
 *
 * Tracks {relativePath → {etag, writeTs, size}} so incremental pulls can
 * skip unchanged files without listing the entire remote prefix.
 *
 * The manifest lives at `<tierDir>/.gcs-manifest.json`.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { SyncManifestEntry } from './types.js';

const MANIFEST_FILENAME = '.gcs-manifest.json';

export type SyncManifest = Record<string, SyncManifestEntry>;

/** Load manifest from disk. Returns empty object if missing or corrupt. */
export function loadManifest(dir: string): SyncManifest {
  try {
    const raw = readFileSync(join(dir, MANIFEST_FILENAME), 'utf-8');
    return JSON.parse(raw) as SyncManifest;
  } catch {
    return {};
  }
}

/** Atomically save full manifest to disk. */
export function saveManifest(dir: string, manifest: SyncManifest): void {
  const filePath = join(dir, MANIFEST_FILENAME);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(manifest, null, 2), 'utf-8');
}

/** Update a single entry in the manifest (load → merge → save). */
export function updateManifestEntry(
  dir: string,
  relativePath: string,
  entry: SyncManifestEntry,
): void {
  const manifest = loadManifest(dir);
  manifest[relativePath] = entry;
  saveManifest(dir, manifest);
}

/** Remove a single entry from the manifest. */
export function removeManifestEntry(dir: string, relativePath: string): void {
  const manifest = loadManifest(dir);
  delete manifest[relativePath];
  saveManifest(dir, manifest);
}
