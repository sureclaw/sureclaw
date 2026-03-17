// src/agent/workspace-release.ts — Agent-side workspace file release for k8s pods.
//
// Delegates the heavy work (diff, gzip, HTTP upload) to workspace-cli.ts
// running as a subprocess. Two modes:
//
// HTTP mode (AX_IPC_TRANSPORT=http):
//   workspace-cli.ts posts directly to /internal/workspace/release with auth token.
//   No IPC call needed — single HTTP round-trip.
//
// Legacy NATS mode:
//   workspace-cli.ts uploads to /internal/workspace-staging → gets staging_key.
//   This module sends workspace_release IPC with the staging_key via NATS.

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import type { IIPCClient } from './runner.js';
import { getLogger } from '../logger.js';

const logger = getLogger().child({ component: 'workspace-release' });

/** Timeout for the workspace-cli.ts release subprocess (2 minutes). */
const RELEASE_TIMEOUT_MS = 120_000;

/**
 * Release workspace changes to the host via the workspace-cli.ts sidecar.
 */
export async function releaseWorkspaceScopes(
  hostUrl: string,
  client: IIPCClient,
  scopes?: string,
): Promise<void> {
  // Resolve the workspace-cli.js path — in production it's compiled to dist/
  const cliPath = join(__dirname, 'workspace-cli.js');

  const args = ['release', '--host-url', hostUrl];
  if (scopes) {
    args.push('--scopes', scopes);
  }

  // In HTTP mode, pass the per-turn token so workspace-cli posts directly
  // to /internal/workspace/release — no staging key + IPC round-trip needed.
  const token = process.env.AX_IPC_TOKEN;
  const isDirectRelease = process.env.AX_IPC_TRANSPORT === 'http' && !!token;
  if (isDirectRelease) {
    args.push('--token', token);
  }

  logger.info('workspace_release_start', { hostUrl, cliPath, direct: isDirectRelease });

  let result: string;
  try {
    // nosemgrep: javascript.lang.security.detect-child-process — workspace-cli.js is internal
    const stdout = execFileSync('node', [cliPath, ...args], {
      timeout: RELEASE_TIMEOUT_MS,
      maxBuffer: 1024,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    result = stdout.trim();
  } catch (err: unknown) {
    const error = err as { stderr?: string; message: string };
    const stderr = error.stderr ?? '';
    if (stderr) {
      for (const line of stderr.split('\n').filter(l => l.trim())) {
        logger.debug('workspace_cli_stderr', { line });
      }
    }
    throw new Error(`workspace-cli release failed: ${error.message}`);
  }

  if (!result) {
    logger.debug('workspace_release_empty');
    return;
  }

  if (isDirectRelease) {
    // Direct release mode — workspace-cli already posted changes via HTTP.
    // No IPC call needed.
    logger.info('workspace_release_complete', { mode: 'direct' });
    return;
  }

  // Legacy staging mode — send workspace_release IPC with the staging key
  logger.info('workspace_release_staged', { stagingKey: result });
  await client.call({ action: 'workspace_release', staging_key: result });
  logger.info('workspace_release_complete', { stagingKey: result });
}
