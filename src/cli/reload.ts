// src/cli/reload.ts
import { watchFile, unwatchFile } from 'node:fs';
import type { AxServer } from '../host/server.js';
import type { Config } from '../types.js';
import type { Logger } from '../logger.js';

export interface ReloadContext {
  getServer(): AxServer;
  setServer(server: AxServer): void;
  loadConfig(): Config;
  createServer(config: Config): Promise<AxServer>;
  logger: Logger;
  configPath: string;
}

export interface ReloadHandle {
  reload(reason: string): Promise<void>;
  onFileChange(): void;
  cleanup(): void;
}

const DEBOUNCE_MS = 500;
const POLL_INTERVAL_MS = 1000;

export function setupConfigReload(ctx: ReloadContext): ReloadHandle {
  let reloading = false;
  let pendingReload = false;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let cleaned = false;

  async function reload(reason: string): Promise<void> {
    if (reloading) {
      pendingReload = true;
      return;
    }
    reloading = true;

    ctx.logger.info('config_reload_triggered', { reason });

    // Validate new config before tearing anything down
    let newConfig: Config;
    try {
      newConfig = ctx.loadConfig();
    } catch (err) {
      ctx.logger.error('config_reload_invalid', { error: (err as Error).message });
      reloading = false;
      return;
    }

    // Stop old server (waits for in-flight requests)
    ctx.logger.info('config_reload_stopping');
    await ctx.getServer().stop();

    // Create and start new server
    ctx.logger.info('config_reload_starting', { profile: newConfig.profile });
    const newServer = await ctx.createServer(newConfig);
    await newServer.start();
    ctx.setServer(newServer);

    ctx.logger.info('config_reload_complete');
    reloading = false;

    if (pendingReload) {
      pendingReload = false;
      await reload('queued');
    }
  }

  function onFileChange(): void {
    if (debounceTimer !== undefined) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => { reload('file_change'); }, DEBOUNCE_MS);
  }

  // Watch config file
  watchFile(ctx.configPath, { interval: POLL_INTERVAL_MS }, onFileChange);

  // SIGHUP handler (Unix only)
  function onSighup(): void { reload('sighup'); }
  if (process.platform !== 'win32') {
    process.on('SIGHUP', onSighup);
  }

  function cleanup(): void {
    if (cleaned) return;
    cleaned = true;
    if (debounceTimer !== undefined) clearTimeout(debounceTimer);
    unwatchFile(ctx.configPath);
    if (process.platform !== 'win32') {
      process.removeListener('SIGHUP', onSighup);
    }
  }

  return { reload, onFileChange, cleanup };
}
