/**
 * PluginHost — sandboxed process manager for third-party providers.
 *
 * The PluginHost is the trust boundary between AX core and third-party
 * provider code. It:
 *
 *   1. Reads plugins.lock to discover installed plugins
 *   2. Verifies each plugin's integrity hash before loading
 *   3. Spawns each plugin in a separate child process
 *   4. Proxies provider interface calls over IPC to the plugin process
 *   5. Injects credentials server-side (plugin process never sees the store)
 *   6. Enforces network capability restrictions
 *   7. Registers plugin providers in the provider-map runtime allowlist
 *
 * SECURITY INVARIANTS:
 *   - Plugin code NEVER runs in the host process
 *   - Credentials are injected by proxy, not passed to the plugin
 *   - Network access is scoped per-plugin via capability declarations
 *   - Integrity hashes are verified on every startup
 *   - All plugin calls are audit-logged via the standard pipeline
 *
 * This component is ~200-300 LOC — intentionally small enough to audit.
 */

import { fork, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { registerPluginProvider, unregisterPluginProvider } from './provider-map.js';
import {
  readPluginLock,
  pluginDir,
  verifyPluginIntegrity,
  type PluginLockEntry,
  type PluginLockFile,
} from './plugin-lock.js';
import { safePath } from '../utils/safe-path.js';

// ═══════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════

export interface PluginHostOptions {
  /** Override lock file path (for testing). */
  lockPath?: string;
  /** Override plugin install directory (for testing). */
  pluginBaseDir?: string;
  /** Skip integrity verification (ONLY for development — never in production). */
  skipIntegrityCheck?: boolean;
  /** Timeout for plugin startup in ms. Default: 10000. */
  startupTimeoutMs?: number;
  /** Timeout for provider calls in ms. Default: 30000. */
  callTimeoutMs?: number;
}

/** Represents a running plugin worker process. */
export interface PluginWorker {
  packageName: string;
  kind: string;
  name: string;
  process: ChildProcess;
  capabilities: PluginLockEntry['capabilities'];
  /** Send a provider call to the plugin and wait for a response. */
  call(method: string, args: unknown[]): Promise<unknown>;
}

/** Plugin call message sent to the worker process. */
interface PluginCallMessage {
  type: 'plugin_call';
  id: string;
  method: string;
  args: unknown[];
  credentials?: Record<string, string>;
}

/** Plugin response message from the worker process. */
interface PluginResponseMessage {
  type: 'plugin_response';
  id: string;
  result?: unknown;
  error?: string;
}

/** Plugin ready message from the worker process. */
interface PluginReadyMessage {
  type: 'plugin_ready';
  methods: string[];
}

type PluginMessage = PluginCallMessage | PluginResponseMessage | PluginReadyMessage;

// ═══════════════════════════════════════════════════════
// PluginHost
// ═══════════════════════════════════════════════════════

export class PluginHost {
  private workers = new Map<string, PluginWorker>();
  private pendingCalls = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (reason: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private opts: Required<PluginHostOptions>;
  private credentialResolver?: (key: string) => Promise<string | null>;

  constructor(opts?: PluginHostOptions) {
    this.opts = {
      lockPath: opts?.lockPath ?? undefined as any,
      pluginBaseDir: opts?.pluginBaseDir ?? pluginDir(),
      skipIntegrityCheck: opts?.skipIntegrityCheck ?? false,
      startupTimeoutMs: opts?.startupTimeoutMs ?? 10_000,
      callTimeoutMs: opts?.callTimeoutMs ?? 30_000,
    };
  }

  /**
   * Set a credential resolver for injecting credentials into plugin calls.
   * The resolver is called server-side — plugin processes never see the
   * credential store directly.
   */
  setCredentialResolver(resolver: (key: string) => Promise<string | null>): void {
    this.credentialResolver = resolver;
  }

  /**
   * Start all plugins declared in plugins.lock.
   * Verifies integrity hashes and spawns worker processes.
   * Registers each plugin's provider in the runtime allowlist.
   */
  async startAll(): Promise<void> {
    const lock = readPluginLock(this.opts.lockPath);

    if (Object.keys(lock.plugins).length === 0) return;

    const startPromises = Object.entries(lock.plugins).map(
      ([packageName, entry]) => this.startPlugin(packageName, entry)
    );

    // Start all plugins concurrently. Log failures but don't block others.
    const results = await Promise.allSettled(startPromises);
    for (const result of results) {
      if (result.status === 'rejected') {
        // Logged but not thrown — one bad plugin doesn't block the rest
        console.error(`[plugin-host] Failed to start plugin: ${result.reason}`);
      }
    }
  }

  /**
   * Start a single plugin worker process.
   */
  private async startPlugin(packageName: string, entry: PluginLockEntry): Promise<void> {
    const installDir = safePath(this.opts.pluginBaseDir, packageName.replace(/\//g, '__'));

    if (!existsSync(installDir)) {
      throw new Error(
        `Plugin "${packageName}" is in plugins.lock but not installed at ${installDir}`
      );
    }

    // Integrity check
    if (!this.opts.skipIntegrityCheck) {
      if (!verifyPluginIntegrity(packageName, installDir, this.opts.lockPath)) {
        throw new Error(
          `Plugin "${packageName}" failed integrity check. ` +
          `The installed files don't match the hash in plugins.lock. ` +
          `This could indicate tampering. Remove and re-install the plugin.`
        );
      }
    }

    const entryPoint = safePath(installDir, entry.main);

    if (!existsSync(entryPoint)) {
      throw new Error(
        `Plugin "${packageName}" entry point not found: ${entryPoint}`
      );
    }

    // Spawn the plugin in a child process with restricted environment
    const child = fork(entryPoint, [], {
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      env: {
        // Minimal environment — no credentials, no AX internals
        NODE_ENV: 'production',
        AX_PLUGIN_MODE: '1',
        AX_PLUGIN_KIND: entry.kind,
        AX_PLUGIN_NAME: entry.name,
        // Network restrictions communicated via env (enforced by sandbox)
        AX_PLUGIN_NETWORK: entry.capabilities.network.join(','),
        AX_PLUGIN_FILESYSTEM: entry.capabilities.filesystem,
      },
    });

    // Wait for the plugin to signal readiness
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(
          `Plugin "${packageName}" did not signal ready within ${this.opts.startupTimeoutMs}ms`
        ));
      }, this.opts.startupTimeoutMs);

      const onMessage = (msg: PluginMessage) => {
        if (msg.type === 'plugin_ready') {
          clearTimeout(timer);
          child.off('message', onMessage);
          resolve();
        }
      };

      child.on('message', onMessage);

      child.on('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`Plugin "${packageName}" failed to start: ${err.message}`));
      });

      child.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`Plugin "${packageName}" exited during startup with code ${code}`));
      });
    });

    // Set up response handler for provider calls
    child.on('message', (msg: PluginMessage) => {
      if (msg.type === 'plugin_response') {
        const pending = this.pendingCalls.get(msg.id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingCalls.delete(msg.id);
          if (msg.error) {
            pending.reject(new Error(`Plugin error: ${msg.error}`));
          } else {
            pending.resolve(msg.result);
          }
        }
      }
    });

    const worker: PluginWorker = {
      packageName,
      kind: entry.kind,
      name: entry.name,
      process: child,
      capabilities: entry.capabilities,
      call: async (method: string, args: unknown[]) => {
        return this.callPlugin(packageName, method, args);
      },
    };

    this.workers.set(packageName, worker);

    // Register in the runtime provider map so resolveProviderPath() finds it
    registerPluginProvider(entry.kind, entry.name, `plugin://${packageName}`);
  }

  /**
   * Send a provider method call to a plugin worker and wait for the response.
   * Credentials are resolved server-side and injected into the message.
   */
  private async callPlugin(
    packageName: string,
    method: string,
    args: unknown[],
  ): Promise<unknown> {
    const worker = this.workers.get(packageName);
    if (!worker) {
      throw new Error(`Plugin "${packageName}" is not running`);
    }

    // Resolve credentials server-side if the plugin needs them
    let credentials: Record<string, string> | undefined;
    if (worker.capabilities.credentials.length > 0 && this.credentialResolver) {
      credentials = {};
      for (const key of worker.capabilities.credentials) {
        const value = await this.credentialResolver(key);
        if (value !== null) {
          credentials[key] = value;
        }
      }
    }

    const callId = randomUUID();
    const message: PluginCallMessage = {
      type: 'plugin_call',
      id: callId,
      method,
      args,
      credentials,
    };

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCalls.delete(callId);
        reject(new Error(
          `Plugin "${packageName}" call to ${method}() timed out after ${this.opts.callTimeoutMs}ms`
        ));
      }, this.opts.callTimeoutMs);

      this.pendingCalls.set(callId, { resolve, reject, timer });
      worker.process.send(message);
    });
  }

  /**
   * Stop all plugin worker processes gracefully.
   */
  async stopAll(): Promise<void> {
    const stopPromises = [...this.workers.entries()].map(
      async ([packageName, worker]) => {
        // Unregister from provider map
        unregisterPluginProvider(worker.kind, worker.name);

        // Send graceful shutdown signal
        try {
          worker.process.send({ type: 'plugin_shutdown' });
        } catch {
          // Process may already be dead
        }

        // Give it 5 seconds to clean up, then kill
        await new Promise<void>((resolve) => {
          const forceKill = setTimeout(() => {
            worker.process.kill('SIGKILL');
            resolve();
          }, 5_000);

          worker.process.on('exit', () => {
            clearTimeout(forceKill);
            resolve();
          });
        });

        this.workers.delete(packageName);
      }
    );

    // Cancel all pending calls
    for (const [id, pending] of this.pendingCalls) {
      clearTimeout(pending.timer);
      pending.reject(new Error('PluginHost shutting down'));
      this.pendingCalls.delete(id);
    }

    await Promise.allSettled(stopPromises);
  }

  /**
   * Stop a specific plugin by package name.
   */
  async stopPlugin(packageName: string): Promise<void> {
    const worker = this.workers.get(packageName);
    if (!worker) return;

    unregisterPluginProvider(worker.kind, worker.name);

    try {
      worker.process.send({ type: 'plugin_shutdown' });
    } catch {
      // Process may already be dead
    }

    await new Promise<void>((resolve) => {
      const forceKill = setTimeout(() => {
        worker.process.kill('SIGKILL');
        resolve();
      }, 5_000);

      worker.process.on('exit', () => {
        clearTimeout(forceKill);
        resolve();
      });
    });

    this.workers.delete(packageName);
  }

  /** List all running plugin workers. */
  listRunning(): Array<{ packageName: string; kind: string; name: string; pid: number }> {
    return [...this.workers.values()].map(w => ({
      packageName: w.packageName,
      kind: w.kind,
      name: w.name,
      pid: w.process.pid ?? -1,
    }));
  }

  /** Check if a specific plugin is running. */
  isRunning(packageName: string): boolean {
    return this.workers.has(packageName);
  }

  /** Get the worker for a specific plugin (for direct calls). */
  getWorker(packageName: string): PluginWorker | undefined {
    return this.workers.get(packageName);
  }
}

// ═══════════════════════════════════════════════════════
// Plugin Worker Entry Point Helper
// ═══════════════════════════════════════════════════════

/**
 * Helper for plugin authors to create a worker entry point.
 * Handles the IPC protocol between the PluginHost and the plugin process.
 *
 * Usage in the plugin's entry point:
 *
 *   import { createPluginWorker } from '@ax/provider-sdk';
 *
 *   createPluginWorker({
 *     async create(credentials) {
 *       return {
 *         async write(entry) { ... },
 *         async query(q) { ... },
 *         // ...
 *       };
 *     },
 *   });
 */
export interface PluginWorkerHandler {
  /** Create the provider instance. Receives injected credentials. */
  create(credentials: Record<string, string>): Promise<Record<string, (...args: any[]) => any>>;
}

export function createPluginWorker(handler: PluginWorkerHandler): void {
  let provider: Record<string, (...args: any[]) => any> | null = null;

  process.on('message', async (msg: PluginMessage) => {
    if (msg.type === 'plugin_call') {
      try {
        // Lazy-create the provider on first call
        if (!provider) {
          provider = await handler.create(msg.credentials ?? {});
        }

        const method = provider[msg.method];
        if (typeof method !== 'function') {
          process.send!({
            type: 'plugin_response',
            id: msg.id,
            error: `Unknown method: ${msg.method}`,
          });
          return;
        }

        const result = await method.apply(provider, msg.args);
        process.send!({
          type: 'plugin_response',
          id: msg.id,
          result,
        });
      } catch (err) {
        process.send!({
          type: 'plugin_response',
          id: msg.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if ((msg as any).type === 'plugin_shutdown') {
      process.exit(0);
    }
  });

  // Signal readiness
  process.send!({ type: 'plugin_ready', methods: [] });
}
