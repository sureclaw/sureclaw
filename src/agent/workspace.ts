// src/agent/workspace.ts — Workspace diff utilities for workspace release.

import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

/** File change metadata for scope diffing. */
export interface FileMeta {
  path: string;
  type: 'added' | 'modified' | 'deleted';
  size: number;
}

export type FileHashMap = Map<string, string>; // relative path -> sha256

export function diffScope(
  mountPath: string,
  baseHashes: FileHashMap,
): FileMeta[] {
  const changes: FileMeta[] = [];
  const currentFiles = listFilesSync(mountPath);
  const currentSet = new Set(currentFiles);

  for (const relPath of currentFiles) {
    const content = readFileSync(join(mountPath, relPath));
    const hash = hashContent(content);
    const oldHash = baseHashes.get(relPath);
    if (!oldHash) {
      changes.push({ path: relPath, type: 'added', size: content.length });
    } else if (hash !== oldHash) {
      changes.push({ path: relPath, type: 'modified', size: content.length });
    }
  }

  for (const relPath of baseHashes.keys()) {
    if (!currentSet.has(relPath)) {
      changes.push({ path: relPath, type: 'deleted', size: 0 });
    }
  }

  return changes;
}

/** Sync helper: list all files recursively under a directory. */
function listFilesSync(baseDir: string, prefix = ''): string[] {
  const files: string[] = [];
  let entries;
  try {
    entries = readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...listFilesSync(join(baseDir, entry.name), relPath));
    } else if (entry.isFile()) {
      files.push(relPath);
    }
  }
  return files;
}

function hashContent(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}
