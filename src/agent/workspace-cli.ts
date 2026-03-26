#!/usr/bin/env node
// src/agent/workspace-cli.ts — CLI for workspace release phase.
//
// Invoked as: node dist/agent/workspace-cli.js release [options]
//
// release: diff scopes / gzip / upload to host via HTTP

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { diffScope } from './workspace.js';
import type { FileHashMap } from './workspace.js';

/** Parse CLI args into a key/value map. Expects --key=value or --key value. */
function parseArgs(argv: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const eqIdx = arg.indexOf('=');
    if (eqIdx !== -1) {
      result[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1);
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      result[arg.slice(2)] = argv[++i];
    } else {
      result[arg.slice(2)] = 'true';
    }
  }
  return result;
}

interface HashSnapshot {
  agent?: [string, string][];
  user?: [string, string][];
  session?: [string, string][];
}

// ═══════════════════════════════════════════════════════
// Release: diff workspace scopes, gzip, upload to host
// ═══════════════════════════════════════════════════════

interface ChangeEntry {
  scope: 'agent' | 'user' | 'session';
  path: string;
  type: 'added' | 'modified' | 'deleted';
  content_base64?: string;
  size: number;
}

/**
 * Release workspace changes to the host via HTTP.
 *
 * Two modes:
 *   1. Direct release (--token): POST gzipped changes to /internal/workspace/release
 *      with bearer token auth. Single HTTP call, no staging key round-trip.
 *   2. Staging (legacy): POST to /internal/workspace-staging, get back staging_key,
 *      caller sends workspace_release IPC with the key.
 *
 * Usage: workspace-cli.js release --host-url <url> [--token <token>] [--scopes session,agent,user]
 *
 * Canonical workspace paths:
 *   /workspace/scratch → session scope
 *   /workspace/agent   → agent scope
 *   /workspace/user    → user scope
 */
async function release(args: Record<string, string>): Promise<void> {
  const hostUrl = args['host-url'];
  if (!hostUrl) {
    console.error('[release] --host-url is required');
    process.exit(1);
  }

  const token = args.token;
  const scopeNames = (args.scopes ?? 'session,agent,user').split(',') as Array<'session' | 'agent' | 'user'>;

  const scopePaths: Record<string, string> = {
    session: '/workspace/scratch',
    agent: '/workspace/agent',
    user: '/workspace/user',
  };

  const allChanges: ChangeEntry[] = [];

  // Read provisioned hash baselines if available (written by runner.ts provisionWorkspaceFromPayload).
  // When present, diffs are accurate (only actual changes). When absent (non-k8s, first run),
  // falls back to empty baseline (treats all files as "added").
  let hashSnapshot: HashSnapshot = {};
  const hashSnapshotPath = '/tmp/.ax-hashes.json';
  if (existsSync(hashSnapshotPath)) {
    try {
      hashSnapshot = JSON.parse(readFileSync(hashSnapshotPath, 'utf-8'));
      console.error(`[release] using provisioned baselines: ${Object.keys(hashSnapshot).join(', ')}`);
    } catch {
      console.error('[release] failed to read hash snapshot, using empty baselines');
    }
  }

  for (const scope of scopeNames) {
    const mountPath = scopePaths[scope];
    if (!mountPath || !existsSync(mountPath)) {
      console.error(`[release] skipping ${scope}: ${mountPath} does not exist`);
      continue;
    }

    // Use provisioned hashes as baseline (accurate diff) or empty map (all files = added)
    const snapshotEntries = hashSnapshot[scope];
    const baseHashes: FileHashMap = snapshotEntries ? new Map(snapshotEntries) : new Map();
    const diffs = diffScope(mountPath, baseHashes);
    if (diffs.length === 0) continue;

    console.error(`[release] ${scope}: ${diffs.length} changes`);

    for (const diff of diffs) {
      const entry: ChangeEntry = {
        scope,
        path: diff.path,
        type: diff.type,
        size: diff.size,
      };

      if (diff.type !== 'deleted') {
        const fullPath = join(mountPath, diff.path);
        const content = readFileSync(fullPath);
        entry.content_base64 = content.toString('base64');
        entry.size = content.length;
      }

      allChanges.push(entry);
    }
  }

  if (allChanges.length === 0) {
    console.error('[release] no changes detected');
    process.stdout.write('');
    return;
  }

  // Create gzipped JSON payload
  const json = JSON.stringify({ changes: allChanges });
  const gzipped = gzipSync(Buffer.from(json));
  console.error(`[release] payload: ${allChanges.length} changes, ${json.length} bytes raw, ${gzipped.length} bytes gzipped`);

  if (token) {
    // Direct release: single HTTP POST with auth token
    const url = `${hostUrl}/internal/workspace/release`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/gzip',
        'Content-Length': String(gzipped.length),
        'Authorization': `Bearer ${token}`,
      },
      body: gzipped,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`workspace release failed: ${response.status} ${text}`);
    }

    const result = await response.json() as { ok: boolean; changeCount: number };
    console.error(`[release] complete: ${result.changeCount} changes`);
    // Output 'direct' to signal no staging_key needed
    process.stdout.write('direct');
  } else {
    // Legacy staging mode: upload, get staging_key
    const url = `${hostUrl}/internal/workspace-staging`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/gzip',
        'Content-Length': String(gzipped.length),
      },
      body: gzipped,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`staging upload failed: ${response.status} ${text}`);
    }

    const result = await response.json() as { staging_key: string };
    if (!result.staging_key) {
      throw new Error('staging upload response missing staging_key');
    }

    console.error(`[release] staged: ${result.staging_key}`);
    process.stdout.write(result.staging_key);
  }
}

// ── CLI entry point ──

const [,, command, ...rawArgs] = process.argv;

if (command === 'release') {
  release(parseArgs(rawArgs)).catch(err => {
    console.error(`[release] fatal: ${(err as Error).message}`);
    process.exit(1);
  });
} else {
  console.error(`Usage: workspace-cli.js release --host-url <url> [--token <token>] [--scopes session,agent,user]`);
  process.exit(1);
}
