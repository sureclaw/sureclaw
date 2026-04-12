import { describe, test, expect } from 'vitest';
import { validateManifest, formatManifestForReview } from '../../src/host/plugin-manifest.js';

describe('Plugin Manifest validation', () => {
  const validManifest = {
    name: '@community/provider-memory-postgres',
    ax_provider: {
      kind: 'memory',
      name: 'postgres',
    },
    capabilities: {
      network: ['localhost:5432'],
      filesystem: 'none',
      credentials: ['POSTGRES_URL'],
    },
    integrity: 'sha512-abc123def456==',
    description: 'PostgreSQL-backed memory provider',
    version: '1.2.3',
    main: 'index.js',
  };

  test('accepts a valid manifest', () => {
    const result = validateManifest(validManifest);
    expect(result.valid).toBe(true);
    expect(result.manifest).toBeDefined();
    expect(result.manifest!.name).toBe('@community/provider-memory-postgres');
    expect(result.manifest!.ax_provider.kind).toBe('memory');
    expect(result.manifest!.ax_provider.name).toBe('postgres');
  });

  test('accepts minimal manifest with defaults', () => {
    const minimal = {
      name: '@community/provider-memory-redis',
      ax_provider: { kind: 'memory', name: 'redis' },
      capabilities: {},
    };
    const result = validateManifest(minimal);
    expect(result.valid).toBe(true);
    expect(result.manifest!.capabilities.network).toEqual([]);
    expect(result.manifest!.capabilities.filesystem).toBe('none');
    expect(result.manifest!.capabilities.credentials).toEqual([]);
    expect(result.manifest!.main).toBe('index.js');
  });

  test('rejects missing name', () => {
    const result = validateManifest({
      ax_provider: { kind: 'memory', name: 'test' },
      capabilities: {},
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toBeDefined();
  });

  test('rejects invalid provider kind', () => {
    const result = validateManifest({
      name: '@test/plugin',
      ax_provider: { kind: 'invalid_kind', name: 'test' },
      capabilities: {},
    });
    expect(result.valid).toBe(false);
  });

  test('rejects invalid provider name format', () => {
    const result = validateManifest({
      name: '@test/plugin',
      ax_provider: { kind: 'memory', name: 'UPPERCASE' },
      capabilities: {},
    });
    expect(result.valid).toBe(false);
  });

  test('rejects invalid network endpoint format', () => {
    const result = validateManifest({
      name: '@test/plugin',
      ax_provider: { kind: 'memory', name: 'test' },
      capabilities: {
        network: ['not-a-valid-endpoint'],
      },
    });
    expect(result.valid).toBe(false);
  });

  test('rejects null bytes in strings', () => {
    const result = validateManifest({
      name: '@test/plugin\0evil',
      ax_provider: { kind: 'memory', name: 'test' },
      capabilities: {},
    });
    expect(result.valid).toBe(false);
  });

  test('rejects extra fields (strict mode)', () => {
    const result = validateManifest({
      name: '@test/plugin',
      ax_provider: { kind: 'memory', name: 'test' },
      capabilities: {},
      evil_field: 'should not be here',
    });
    expect(result.valid).toBe(false);
  });

  test('accepts all valid provider kinds', () => {
    const kinds = [
      'llm', 'memory', 'security', 'channel',
      'web', 'credentials', 'skills',
      'audit', 'sandbox', 'scheduler',
    ];

    for (const kind of kinds) {
      const result = validateManifest({
        name: `@test/provider-${kind}-test`,
        ax_provider: { kind, name: 'test' },
        capabilities: {},
      });
      expect(result.valid).toBe(true);
    }
  });

  test('formatManifestForReview produces readable output', () => {
    const result = validateManifest(validManifest);
    expect(result.valid).toBe(true);

    const formatted = formatManifestForReview(result.manifest!);
    expect(formatted).toContain('Plugin: @community/provider-memory-postgres');
    expect(formatted).toContain('Provider: memory/postgres');
    expect(formatted).toContain('localhost:5432');
    expect(formatted).toContain('POSTGRES_URL');
    expect(formatted).toContain('PostgreSQL-backed memory provider');
  });

  test('formatManifestForReview handles no capabilities', () => {
    const result = validateManifest({
      name: '@test/plugin',
      ax_provider: { kind: 'memory', name: 'test' },
      capabilities: {},
    });
    const formatted = formatManifestForReview(result.manifest!);
    expect(formatted).toContain('Network: none');
    expect(formatted).toContain('Credentials: none');
  });
});
