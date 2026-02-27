import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PluginHost } from '../../src/host/plugin-host.js';
import {
  writePluginLock,
  computeIntegrity,
  type PluginLockFile,
} from '../../src/host/plugin-lock.js';
import { clearPluginProviders, listPluginProviders } from '../../src/host/provider-map.js';

describe('PluginHost', () => {
  let tmpDir: string;
  let lockPath: string;
  let pluginBaseDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ax-plugin-host-test-'));
    lockPath = join(tmpDir, 'plugins.lock');
    pluginBaseDir = join(tmpDir, 'plugins');
    mkdirSync(pluginBaseDir, { recursive: true });
    clearPluginProviders();
  });

  afterEach(() => {
    clearPluginProviders();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('startAll does nothing with empty lock file', async () => {
    const host = new PluginHost({ lockPath, pluginBaseDir });
    await host.startAll();
    expect(host.listRunning()).toHaveLength(0);
  });

  test('startAll does nothing when lock file does not exist', async () => {
    const host = new PluginHost({
      lockPath: join(tmpDir, 'nonexistent.lock'),
      pluginBaseDir,
    });
    await host.startAll();
    expect(host.listRunning()).toHaveLength(0);
  });

  test('startAll fails gracefully for missing plugin directory', async () => {
    const lock: PluginLockFile = {
      version: 1,
      plugins: {
        '@test/missing-plugin': {
          version: '1.0.0',
          integrity: 'sha512-abc==',
          kind: 'memory',
          name: 'missing',
          main: 'index.js',
          capabilities: { network: [], filesystem: 'none', credentials: [] },
          installedAt: new Date().toISOString(),
        },
      },
    };
    writePluginLock(lock, lockPath);

    const host = new PluginHost({ lockPath, pluginBaseDir });
    // Should not throw — logs error but continues
    await host.startAll();
    expect(host.listRunning()).toHaveLength(0);
  });

  test('startAll fails gracefully for integrity check failure', async () => {
    // Create a plugin directory with content that doesn't match the hash
    const pluginDir = join(pluginBaseDir, '@test__bad-integrity');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, 'index.js'), 'console.log("tampered")');

    const lock: PluginLockFile = {
      version: 1,
      plugins: {
        '@test/bad-integrity': {
          version: '1.0.0',
          integrity: 'sha512-WRONG_HASH==',
          kind: 'memory',
          name: 'bad',
          main: 'index.js',
          capabilities: { network: [], filesystem: 'none', credentials: [] },
          installedAt: new Date().toISOString(),
        },
      },
    };
    writePluginLock(lock, lockPath);

    const host = new PluginHost({ lockPath, pluginBaseDir });
    await host.startAll();
    expect(host.listRunning()).toHaveLength(0);
  });

  test('stopAll is safe to call with no running plugins', async () => {
    const host = new PluginHost({ lockPath, pluginBaseDir });
    await host.stopAll(); // Should not throw
  });

  test('isRunning returns false for unknown package', () => {
    const host = new PluginHost({ lockPath, pluginBaseDir });
    expect(host.isRunning('@test/unknown')).toBe(false);
  });

  test('getWorker returns undefined for unknown package', () => {
    const host = new PluginHost({ lockPath, pluginBaseDir });
    expect(host.getWorker('@test/unknown')).toBeUndefined();
  });

  test('starts and registers a valid plugin worker', async () => {
    // Create a minimal plugin that signals ready
    const pluginContent = `
      process.send({ type: 'plugin_ready', methods: ['write', 'read'] });
      process.on('message', (msg) => {
        if (msg.type === 'plugin_call') {
          process.send({
            type: 'plugin_response',
            id: msg.id,
            result: { ok: true, method: msg.method },
          });
        }
        if (msg.type === 'plugin_shutdown') {
          process.exit(0);
        }
      });
    `;

    const pluginDirName = join(pluginBaseDir, '@test__valid-plugin');
    mkdirSync(pluginDirName, { recursive: true });
    writeFileSync(join(pluginDirName, 'index.js'), pluginContent);

    const integrity = computeIntegrity(pluginContent);
    const lock: PluginLockFile = {
      version: 1,
      plugins: {
        '@test/valid-plugin': {
          version: '1.0.0',
          integrity,
          kind: 'memory',
          name: 'testmem',
          main: 'index.js',
          capabilities: { network: [], filesystem: 'none', credentials: [] },
          installedAt: new Date().toISOString(),
        },
      },
    };
    writePluginLock(lock, lockPath);

    const host = new PluginHost({
      lockPath,
      pluginBaseDir,
      startupTimeoutMs: 5000,
    });

    await host.startAll();

    expect(host.isRunning('@test/valid-plugin')).toBe(true);
    expect(host.listRunning()).toHaveLength(1);
    expect(host.listRunning()[0].kind).toBe('memory');
    expect(host.listRunning()[0].name).toBe('testmem');

    // Check it was registered in the provider map
    const registered = listPluginProviders();
    expect(registered).toContainEqual({
      kind: 'memory',
      name: 'testmem',
      modulePath: 'plugin://@test/valid-plugin',
    });

    // Test a provider call
    const worker = host.getWorker('@test/valid-plugin');
    expect(worker).toBeDefined();
    const result = await worker!.call('write', [{ scope: 'test', content: 'hello' }]);
    expect(result).toEqual({ ok: true, method: 'write' });

    // Stop and verify cleanup
    await host.stopAll();
    expect(host.listRunning()).toHaveLength(0);
    expect(listPluginProviders()).toHaveLength(0);
  });

  test('handles plugin startup timeout', async () => {
    // Create a plugin that never signals ready
    const pluginContent = `
      // Never send plugin_ready — should timeout
      setInterval(() => {}, 60000);
    `;

    const pluginDirName = join(pluginBaseDir, '@test__slow-plugin');
    mkdirSync(pluginDirName, { recursive: true });
    writeFileSync(join(pluginDirName, 'index.js'), pluginContent);

    const integrity = computeIntegrity(pluginContent);
    const lock: PluginLockFile = {
      version: 1,
      plugins: {
        '@test/slow-plugin': {
          version: '1.0.0',
          integrity,
          kind: 'memory',
          name: 'slow',
          main: 'index.js',
          capabilities: { network: [], filesystem: 'none', credentials: [] },
          installedAt: new Date().toISOString(),
        },
      },
    };
    writePluginLock(lock, lockPath);

    const host = new PluginHost({
      lockPath,
      pluginBaseDir,
      startupTimeoutMs: 500, // Very short timeout for test
    });

    // Should not throw — logs error but continues
    await host.startAll();
    expect(host.isRunning('@test/slow-plugin')).toBe(false);
  });

  test('credential resolver injects credentials into plugin calls', async () => {
    const pluginContent = `
      process.send({ type: 'plugin_ready', methods: [] });
      process.on('message', (msg) => {
        if (msg.type === 'plugin_call') {
          process.send({
            type: 'plugin_response',
            id: msg.id,
            result: { receivedCredentials: msg.credentials },
          });
        }
        if (msg.type === 'plugin_shutdown') process.exit(0);
      });
    `;

    const pluginDirName = join(pluginBaseDir, '@test__cred-plugin');
    mkdirSync(pluginDirName, { recursive: true });
    writeFileSync(join(pluginDirName, 'index.js'), pluginContent);

    const integrity = computeIntegrity(pluginContent);
    const lock: PluginLockFile = {
      version: 1,
      plugins: {
        '@test/cred-plugin': {
          version: '1.0.0',
          integrity,
          kind: 'memory',
          name: 'credtest',
          main: 'index.js',
          capabilities: { network: [], filesystem: 'none', credentials: ['DB_URL'] },
          installedAt: new Date().toISOString(),
        },
      },
    };
    writePluginLock(lock, lockPath);

    const host = new PluginHost({ lockPath, pluginBaseDir, startupTimeoutMs: 5000 });
    host.setCredentialResolver(async (key) => {
      if (key === 'DB_URL') return 'postgres://localhost/test';
      return null;
    });

    await host.startAll();

    const worker = host.getWorker('@test/cred-plugin');
    const result = await worker!.call('connect', []) as any;
    expect(result.receivedCredentials).toEqual({ DB_URL: 'postgres://localhost/test' });

    await host.stopAll();
  });
});
