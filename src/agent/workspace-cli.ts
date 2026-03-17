#!/usr/bin/env node
// src/agent/workspace-cli.ts — CLI for container provision/cleanup/release phases.
//
// Invoked as: node dist/agent/workspace-cli.js provision|cleanup|release [options]
//
// provision: GCS restore / git clone / scope provisioning / hash snapshot
// cleanup:   diff scopes / upload changes to GCS / git push / delete workspace
// release:   diff scopes / gzip / upload to host staging endpoint (k8s NATS mode)

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { provisionWorkspace, provisionScope, diffScope, releaseWorkspace } from './workspace.js';
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

/** Snapshot file: stores scope hashes for diff on cleanup. */
const HASH_SNAPSHOT_FILE = '.ax-hashes.json';

interface HashSnapshot {
  agent?: [string, string][];
  user?: [string, string][];
  session?: [string, string][];
}

async function provision(args: Record<string, string>): Promise<void> {
  const workspace = args.workspace ?? '/workspace';
  const session = args.session ?? 'default';

  // Provision workspace (GCS cache → git clone → empty)
  const wsResult = await provisionWorkspace(workspace, session, {
    gitUrl: args['git-url'],
    ref: args.ref,
    cacheKey: args['cache-key'],
  });
  console.log(`[provision] workspace ready: ${wsResult.source} (${wsResult.durationMs}ms)`);

  // Provision scopes
  const snapshot: HashSnapshot = {};

  if (args['agent-gcs-prefix']) {
    const agentPath = join(workspace, session, 'agent');
    const agentReadOnly = args['agent-read-only'] === 'true';
    const result = await provisionScope(agentPath, args['agent-gcs-prefix'], agentReadOnly);
    snapshot.agent = [...result.hashes.entries()];
    console.log(`[provision] agent scope: ${result.source} (${result.fileCount} files)`);
  }

  if (args['user-gcs-prefix']) {
    const userPath = join(workspace, session, 'user');
    const userReadOnly = args['user-read-only'] === 'true';
    const result = await provisionScope(userPath, args['user-gcs-prefix'], userReadOnly);
    snapshot.user = [...result.hashes.entries()];
    console.log(`[provision] user scope: ${result.source} (${result.fileCount} files)`);
  }

  if (args['session-gcs-prefix']) {
    const sessionPath = join(workspace, session, 'scratch');
    const result = await provisionScope(sessionPath, args['session-gcs-prefix'], false);
    snapshot.session = [...result.hashes.entries()];
    console.log(`[provision] session scope: ${result.source} (${result.fileCount} files)`);
  }

  // Write hash snapshot for cleanup phase
  const snapshotPath = join(workspace, session, HASH_SNAPSHOT_FILE);
  writeFileSync(snapshotPath, JSON.stringify(snapshot), 'utf-8');
  console.log('[provision] hash snapshot written');
}

async function cleanup(args: Record<string, string>): Promise<void> {
  const workspace = args.workspace ?? '/workspace';
  const session = args.session ?? 'default';
  const wsPath = join(workspace, session);

  // Read hash snapshot
  const snapshotPath = join(wsPath, HASH_SNAPSHOT_FILE);
  let snapshot: HashSnapshot = {};
  if (existsSync(snapshotPath)) {
    try {
      snapshot = JSON.parse(readFileSync(snapshotPath, 'utf-8'));
    } catch {
      console.warn('[cleanup] failed to read hash snapshot');
    }
  }

  // Diff each scope
  const changes: Record<string, any[]> = {};

  if (snapshot.agent) {
    const agentPath = join(wsPath, 'agent');
    const baseHashes: FileHashMap = new Map(snapshot.agent);
    changes.agent = diffScope(agentPath, baseHashes);
    console.log(`[cleanup] agent scope: ${changes.agent.length} changes`);
  }

  if (snapshot.user) {
    const userPath = join(wsPath, 'user');
    const baseHashes: FileHashMap = new Map(snapshot.user);
    changes.user = diffScope(userPath, baseHashes);
    console.log(`[cleanup] user scope: ${changes.user.length} changes`);
  }

  if (snapshot.session) {
    const scratchPath = join(wsPath, 'scratch');
    const baseHashes: FileHashMap = new Map(snapshot.session);
    changes.session = diffScope(scratchPath, baseHashes);
    console.log(`[cleanup] session scope: ${changes.session.length} changes`);
  }

  // Release workspace (git push, GCS cache update, cleanup)
  await releaseWorkspace(wsPath, {
    pushChanges: args['push-changes'] === 'true',
    updateCache: args['update-cache'] === 'true',
    cacheKey: args['cache-key'],
  });

  console.log('[cleanup] workspace released');
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

  for (const scope of scopeNames) {
    const mountPath = scopePaths[scope];
    if (!mountPath || !existsSync(mountPath)) {
      console.error(`[release] skipping ${scope}: ${mountPath} does not exist`);
      continue;
    }

    // Empty baseline — pod starts with empty emptyDir volumes, so every file is new
    const baseHashes: FileHashMap = new Map();
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

if (command === 'provision') {
  provision(parseArgs(rawArgs)).catch(err => {
    console.error(`[provision] fatal: ${(err as Error).message}`);
    process.exit(1);
  });
} else if (command === 'cleanup') {
  cleanup(parseArgs(rawArgs)).catch(err => {
    console.error(`[cleanup] fatal: ${(err as Error).message}`);
    process.exit(1);
  });
} else if (command === 'release') {
  release(parseArgs(rawArgs)).catch(err => {
    console.error(`[release] fatal: ${(err as Error).message}`);
    process.exit(1);
  });
} else {
  console.error(`Usage: workspace-cli.js <provision|cleanup|release> [options]`);
  console.error(`  provision: --workspace --session --git-url --ref --cache-key --agent-gcs-prefix --user-gcs-prefix --session-gcs-prefix`);
  console.error(`  cleanup:   --workspace --session --push-changes --update-cache --cache-key`);
  console.error(`  release:   --host-url <url> [--scopes session,agent,user]`);
  process.exit(1);
}
