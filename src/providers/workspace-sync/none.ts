/**
 * No-op workspace sync provider.
 *
 * Default for local-only setups. All methods are no-ops with zero overhead.
 */
import type { WorkspaceSyncProvider, SyncResult } from './types.js';
import type { Config } from '../../types.js';

const EMPTY_RESULT: SyncResult = {
  filesUpdated: 0,
  filesDeleted: 0,
  bytesTransferred: 0,
  durationMs: 0,
};

export async function create(_config: Config): Promise<WorkspaceSyncProvider> {
  return {
    async pull(): Promise<SyncResult> { return EMPTY_RESULT; },
    async uploadFile(): Promise<void> {},
    async pushAll(): Promise<SyncResult> { return EMPTY_RESULT; },
    async deleteFile(): Promise<void> {},
  };
}
