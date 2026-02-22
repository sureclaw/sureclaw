/**
 * Server lifecycle — startup orchestration, stale workspace cleanup,
 * and graceful shutdown. Wires together channels, scheduler, HTTP server,
 * IPC server, and persistent stores.
 */

import { existsSync, readdirSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from '../paths.js';
import type { Logger } from '../logger.js';

/**
 * Clean up stale persistent workspaces (older than 7 days).
 * Handles both legacy flat UUID dirs and new nested colon-separated dirs.
 */
export function cleanStaleWorkspaces(logger: Logger): void {
  const workspacesRoot = join(dataDir(), 'workspaces');
  if (!existsSync(workspacesRoot)) return;

  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - SEVEN_DAYS_MS;

  /** Recursively find leaf workspace dirs (those containing files) and clean stale ones. */
  function cleanDir(dir: string): boolean {
    try {
      const entries = readdirSync(dir);
      if (entries.length === 0) {
        // Empty dir — prune it
        rmSync(dir, { recursive: true, force: true });
        return true; // was removed
      }

      let hasFiles = false;
      let hasSubdirs = false;
      for (const entry of entries) {
        const entryPath = join(dir, entry);
        try {
          if (statSync(entryPath).isDirectory()) {
            hasSubdirs = true;
          } else {
            hasFiles = true;
          }
        } catch {
          // stat failed, skip
        }
      }

      if (hasFiles) {
        // This is a leaf workspace — check staleness
        try {
          const stat = statSync(dir);
          if (stat.mtimeMs < cutoff) {
            const relative = dir.slice(workspacesRoot.length + 1);
            rmSync(dir, { recursive: true, force: true });
            logger.info('cleaned_stale_workspace', { sessionId: relative });
            return true;
          }
        } catch {
          // stat failed, skip
        }
        return false;
      }

      if (hasSubdirs) {
        // Intermediate dir — recurse into subdirs
        for (const entry of entries) {
          const entryPath = join(dir, entry);
          try {
            if (statSync(entryPath).isDirectory()) {
              cleanDir(entryPath);
            }
          } catch {
            // stat failed, skip
          }
        }
        // After cleaning children, prune this dir if now empty
        try {
          if (readdirSync(dir).length === 0) {
            rmSync(dir, { recursive: true, force: true });
            return true;
          }
        } catch {
          // readdir failed, skip
        }
      }

      return false;
    } catch {
      logger.debug('workspace_cleanup_failed', { dir });
      return false;
    }
  }

  try {
    for (const entry of readdirSync(workspacesRoot)) {
      const entryPath = join(workspacesRoot, entry);
      try {
        if (statSync(entryPath).isDirectory()) {
          cleanDir(entryPath);
        }
      } catch {
        logger.debug('workspace_stat_failed', { entry });
      }
    }
  } catch {
    logger.debug('workspaces_dir_read_failed');
  }
}
