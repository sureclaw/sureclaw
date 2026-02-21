import { describe, test, expect } from 'vitest';
import { resolveProviderPath, PROVIDER_MAP } from '../../src/host/provider-map.js';

describe('Provider allowlist (SC-SEC-002)', () => {
  test('resolves valid provider paths', () => {
    expect(resolveProviderPath('llm', 'anthropic')).toContain('/providers/llm/anthropic.js');
    expect(resolveProviderPath('memory', 'file')).toContain('/providers/memory/file.js');
    expect(resolveProviderPath('scheduler', 'none')).toContain('/providers/scheduler/none.js');
    expect(resolveProviderPath('sandbox', 'seatbelt')).toContain('/providers/sandbox/seatbelt.js');
    expect(resolveProviderPath('sandbox', 'subprocess')).toContain('/providers/sandbox/subprocess.js');
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
        expect(path).toMatch(/^\.\.\/providers\/[a-z]+\/[a-z-]+\.js$/);
      }
    }
  });

  test('sandbox kind has all expected providers', () => {
    const sandboxMap = PROVIDER_MAP['sandbox'];
    expect(sandboxMap).toBeDefined();
    expect(sandboxMap!['subprocess']).toBeDefined();
    expect(sandboxMap!['seatbelt']).toBeDefined();
    expect(sandboxMap!['nsjail']).toBeDefined();
    expect(sandboxMap!['docker']).toBeDefined();
  });
});
