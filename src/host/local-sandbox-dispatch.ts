/**
 * Local sandbox dispatcher — lazy sandbox spawning for non-k8s modes.
 *
 * Mirrors NATSSandboxDispatcher's lifecycle pattern:
 * - ensureSandbox(): spawn on first call, reuse on subsequent (per requestId)
 * - release(): kill sandbox at end of turn
 * - close(): release all
 *
 * For subprocess/seatbelt: ensureSandbox() is a no-op (tools execute on host).
 * For apple/docker: spawns the container lazily on first sandbox tool call.
 */

import { getLogger } from '../logger.js';
import type {
  SandboxProvider,
  SandboxProcess,
  SandboxConfig,
} from '../providers/sandbox/types.js';

const logger = getLogger().child({ component: 'local-sandbox-dispatch' });

/** Container sandbox types that require spawning a separate process. */
const CONTAINER_SANDBOXES = new Set(['apple', 'docker']);

export interface LocalSandboxDispatcherOptions {
  provider: SandboxProvider;
  /** The configured sandbox type (e.g. 'subprocess', 'seatbelt', 'apple', 'docker'). */
  sandboxType?: string;
}

export interface LocalSandboxDispatcher {
  /** Check if a sandbox is active for the given requestId. */
  hasSandbox(requestId: string): boolean;
  /** Spawn a sandbox on first call (no-op for subprocess/seatbelt). */
  ensureSandbox(requestId: string, config: SandboxConfig): Promise<void>;
  /** Get the sandbox process for a requestId, if one exists. */
  getSandboxProcess(requestId: string): SandboxProcess | undefined;
  /** Kill and remove the sandbox for a requestId. */
  release(requestId: string): Promise<void>;
  /** Release all active sandboxes. */
  close(): Promise<void>;
}

export function createLocalSandboxDispatcher(
  opts: LocalSandboxDispatcherOptions,
): LocalSandboxDispatcher {
  const { provider, sandboxType } = opts;
  const active = new Map<string, SandboxProcess>();
  const isContainer = CONTAINER_SANDBOXES.has(sandboxType ?? '');

  const dispatcher: LocalSandboxDispatcher = {
    hasSandbox(requestId: string): boolean {
      return active.has(requestId);
    },

    async ensureSandbox(
      requestId: string,
      config: SandboxConfig,
    ): Promise<void> {
      if (active.has(requestId)) return;
      if (!isContainer) return;

      logger.info('lazy_sandbox_spawn', { requestId, sandboxType });
      const proc = await provider.spawn(config);
      active.set(requestId, proc);
      logger.info('lazy_sandbox_ready', { requestId, pid: proc.pid });
    },

    getSandboxProcess(requestId: string): SandboxProcess | undefined {
      return active.get(requestId);
    },

    async release(requestId: string): Promise<void> {
      const proc = active.get(requestId);
      if (!proc) return;

      // Delete from map first so hasSandbox returns false even if kill throws
      active.delete(requestId);
      try {
        proc.kill();
        logger.debug('sandbox_released', { requestId, pid: proc.pid });
      } catch (err) {
        logger.warn('sandbox_release_failed', {
          requestId,
          error: (err as Error).message,
        });
      }
    },

    async close(): Promise<void> {
      const releases = [...active.keys()].map((reqId) =>
        dispatcher.release(reqId),
      );
      await Promise.allSettled(releases);
    },
  };

  return dispatcher;
}
