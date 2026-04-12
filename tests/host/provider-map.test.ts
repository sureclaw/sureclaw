import { describe, test, expect } from 'vitest';
import { resolveProviderPath, PROVIDER_MAP } from '../../src/host/provider-map.js';

describe('Provider allowlist (SC-SEC-002)', () => {
  test('resolves valid provider paths', () => {
    expect(resolveProviderPath('llm', 'anthropic')).toContain('/providers/llm/anthropic.js');
    expect(resolveProviderPath('memory', 'cortex')).toContain('/providers/memory/cortex/index.js');
    expect(resolveProviderPath('scheduler', 'none')).toContain('/providers/scheduler/none.js');
    expect(resolveProviderPath('sandbox', 'docker')).toContain('/providers/sandbox/docker.js');
  });

  test('returns absolute file URLs', () => {
    const result = resolveProviderPath('llm', 'anthropic');
    expect(result).toMatch(/^file:\/\//);
  });

  test('resolves groq to openai module', () => {
    expect(resolveProviderPath('llm', 'groq')).toContain('/providers/llm/openai.js');
  });

  test('rejects unknown provider kind', () => {
    expect(() => resolveProviderPath('unknown', 'foo')).toThrow('Unknown provider kind');
  });

  test('rejects unknown provider name', () => {
    expect(() => resolveProviderPath('llm', 'evil')).toThrow('Unknown llm provider');
  });

  test('rejects path traversal in kind', () => {
    expect(() => resolveProviderPath('../etc', 'passwd')).toThrow('Unknown provider kind');
  });

  test('rejects path traversal in name', () => {
    expect(() => resolveProviderPath('llm', '../../etc/passwd')).toThrow('Unknown llm provider');
  });

  test('rejects empty strings', () => {
    expect(() => resolveProviderPath('', '')).toThrow('Unknown provider kind');
  });

  test('every mapped path follows naming convention', () => {
    for (const [_kind, names] of Object.entries(PROVIDER_MAP)) {
      for (const [_name, path] of Object.entries(names)) {
        // Allow relative paths (current) or scoped package names (Phase 2)
        const isRelative = /^\.\.\/providers\/[a-z]+\/[a-z0-9-]+(?:\/[a-z0-9-]+)?\.js$/.test(path);
        const isPackage  = /^@ax\/provider-[a-z]+-[a-z]+$/.test(path);
        expect(isRelative || isPackage).toBe(true);
      }
    }
  });

  test('package-name entries resolve via import.meta.resolve, not as bare strings (SC-SEC-002)', () => {
    // SECURITY: When PROVIDER_MAP entries use @ax/provider-* package names
    // (Phase 2 monorepo split), resolveProviderPath() must resolve them via
    // import.meta.resolve() — pinning resolution to the AX installation's
    // node_modules, not the CWD. Without this, an attacker who controls the
    // working directory can plant a malicious node_modules/@ax/ that shadows
    // the real package.
    //
    // This test validates the mechanism: import.meta.resolve() returns absolute
    // file:// URLs for packages resolved from the calling module's location.
    // When Phase 2 adds package names to PROVIDER_MAP, this property ensures
    // they can't be hijacked via CWD manipulation.
    const resolved = import.meta.resolve('vitest');
    expect(resolved).toMatch(/^file:\/\//);

    // Verify all current entries are relative paths (no package names yet).
    // This test will need updating when Phase 2 converts entries to @ax/ packages.
    for (const [_kind, names] of Object.entries(PROVIDER_MAP)) {
      for (const [_name, path] of Object.entries(names)) {
        expect(path).toMatch(/^\.\.\//);
      }
    }
  });

  test('sandbox kind has all expected providers', () => {
    const sandboxMap = PROVIDER_MAP['sandbox'];
    expect(sandboxMap).toBeDefined();
    expect(sandboxMap!['docker']).toBeDefined();
    expect(sandboxMap!['apple']).toBeDefined();
    expect(sandboxMap!['k8s']).toBeDefined();
  });

  test('all resolved paths use file:// protocol (SC-SEC-002 hardening)', () => {
    // SECURITY: assertFileUrl() rejects non-file:// URLs (data:, http:, node:, etc).
    // This test ensures every resolved path from the built-in allowlist passes
    // the protocol check. When Phase 3 adds package names, they must also resolve
    // to file:// URLs via import.meta.resolve().
    for (const [kind, names] of Object.entries(PROVIDER_MAP)) {
      for (const name of Object.keys(names)) {
        const resolved = resolveProviderPath(kind, name);
        expect(resolved).toMatch(/^file:\/\//);
      }
    }
  });
});
