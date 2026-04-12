import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import {
  resolveProviderPath,
  registerPluginProvider,
  unregisterPluginProvider,
  listPluginProviders,
  clearPluginProviders,
  PROVIDER_MAP,
} from '../../src/host/provider-map.js';

describe('Plugin provider registration (SC-SEC-002)', () => {
  beforeEach(() => {
    clearPluginProviders();
  });

  afterEach(() => {
    clearPluginProviders();
  });

  test('registerPluginProvider makes provider resolvable', () => {
    registerPluginProvider('memory', 'postgres', 'plugin://@community/memory-postgres');
    const path = resolveProviderPath('memory', 'postgres');
    expect(path).toBe('plugin://@community/memory-postgres');
  });

  test('unregisterPluginProvider removes provider', () => {
    registerPluginProvider('memory', 'redis', 'plugin://@community/memory-redis');
    expect(resolveProviderPath('memory', 'redis')).toBe('plugin://@community/memory-redis');

    const removed = unregisterPluginProvider('memory', 'redis');
    expect(removed).toBe(true);

    expect(() => resolveProviderPath('memory', 'redis')).toThrow('Unknown memory provider');
  });

  test('unregisterPluginProvider returns false for unknown', () => {
    const removed = unregisterPluginProvider('memory', 'nonexistent');
    expect(removed).toBe(false);
  });

  test('registerPluginProvider rejects overwriting built-in providers', () => {
    expect(() => {
      registerPluginProvider('llm', 'anthropic', 'plugin://@evil/override');
    }).toThrow('conflicts with built-in provider');
  });

  test('listPluginProviders returns registered plugins', () => {
    registerPluginProvider('memory', 'mongo', 'plugin://@test/mongo');
    registerPluginProvider('security', 'ml', 'plugin://@test/ml-scanner');

    const list = listPluginProviders();
    expect(list).toHaveLength(2);
    expect(list).toContainEqual({
      kind: 'memory',
      name: 'mongo',
      modulePath: 'plugin://@test/mongo',
    });
    expect(list).toContainEqual({
      kind: 'security',
      name: 'ml',
      modulePath: 'plugin://@test/ml-scanner',
    });
  });

  test('clearPluginProviders removes all', () => {
    registerPluginProvider('memory', 'a', 'plugin://a');
    registerPluginProvider('memory', 'b', 'plugin://b');
    expect(listPluginProviders()).toHaveLength(2);

    clearPluginProviders();
    expect(listPluginProviders()).toHaveLength(0);
  });

  test('built-in providers still resolve correctly after plugin registration', () => {
    registerPluginProvider('memory', 'postgres', 'plugin://@test/pg');

    // Built-in should still work
    expect(resolveProviderPath('llm', 'anthropic')).toContain('/providers/llm/anthropic.js');
    expect(resolveProviderPath('memory', 'cortex')).toContain('/providers/memory/cortex/index.js');

    // Plugin should also work
    expect(resolveProviderPath('memory', 'postgres')).toBe('plugin://@test/pg');
  });

  test('resolveProviderPath falls back to plugin map for unknown kind', () => {
    // Plugin with a kind not in built-in map should still fail unless registered
    expect(() => resolveProviderPath('custom', 'thing')).toThrow('Unknown provider kind');
  });

  test('package-name style paths are returned as-is', () => {
    // If someone adds a package name to the built-in map in the future,
    // it should be returned as-is (not resolved as a relative path)
    // We test this via plugin registration which uses the same code path
    registerPluginProvider('memory', 'external', '@ax/provider-memory-external');
    expect(resolveProviderPath('memory', 'external')).toBe('@ax/provider-memory-external');
  });
});
