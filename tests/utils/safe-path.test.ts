import { describe, test, expect } from 'vitest';
import { safePath, assertWithinBase } from '../../src/utils/safe-path.js';
import { resolve } from 'node:path';

const BASE = '/tmp/test-base';

describe('safePath (SC-SEC-004)', () => {
  // ── Basic functionality ──
  test('constructs path within base', () => {
    expect(safePath(BASE, 'foo')).toBe(resolve(BASE, 'foo'));
  });

  test('handles nested segments', () => {
    expect(safePath(BASE, 'scope', 'file.json')).toBe(resolve(BASE, 'scope', 'file.json'));
  });

  // ── Path traversal attacks ──
  test('sanitizes ../ traversal to stay within base', () => {
    const result = safePath(BASE, '..', 'etc', 'passwd');
    expect(result.startsWith(resolve(BASE))).toBe(true);
  });

  test('sanitizes encoded traversal', () => {
    const result = safePath(BASE, '..%2f..%2fetc');
    expect(result.startsWith(resolve(BASE))).toBe(true);
  });

  test('sanitizes absolute path injection', () => {
    const result = safePath(BASE, '/etc/passwd');
    expect(result.startsWith(resolve(BASE))).toBe(true);
  });

  test('removes null bytes', () => {
    const result = safePath(BASE, 'foo\0.json');
    expect(result).toBe(resolve(BASE, 'foo.json'));
    expect(result.includes('\0')).toBe(false);
  });

  // ── Platform edge cases ──
  test('sanitizes colon (Windows ADS)', () => {
    const result = safePath(BASE, 'file:stream');
    expect(result).toBe(resolve(BASE, 'file_stream'));
  });

  test('sanitizes backslash traversal', () => {
    const result = safePath(BASE, '..\\..\\etc');
    expect(result.startsWith(resolve(BASE))).toBe(true);
  });

  test('handles trailing dots and spaces', () => {
    const result = safePath(BASE, 'foo. . .');
    expect(result.startsWith(resolve(BASE))).toBe(true);
  });

  // ── Edge cases ──
  test('handles empty segment', () => {
    const result = safePath(BASE, '');
    expect(result).toBe(resolve(BASE, '_empty_'));
  });

  test('handles very long segment', () => {
    const long = 'a'.repeat(1000);
    const result = safePath(BASE, long);
    const segment = result.slice(resolve(BASE).length + 1);
    expect(segment.length).toBeLessThanOrEqual(255);
  });

  test('blocks realistic attack payloads', () => {
    const attacks = [
      '../../../../etc/shadow',
      '..\\..\\..\\windows\\system32',
      'user:alice/../../root',
      'scope\x00.json',
      'C:\\Windows\\System32',
      'user:alice:$DATA',
    ];

    for (const attack of attacks) {
      const result = safePath(BASE, attack);
      expect(result.startsWith(resolve(BASE))).toBe(true);
    }
  });
});

describe('assertWithinBase', () => {
  test('accepts path within base', () => {
    expect(assertWithinBase(BASE, `${BASE}/foo`)).toBe(resolve(BASE, 'foo'));
  });

  test('rejects path outside base', () => {
    expect(() => assertWithinBase(BASE, '/etc/passwd')).toThrow('outside base directory');
  });

  test('accepts base directory itself', () => {
    expect(assertWithinBase(BASE, BASE)).toBe(resolve(BASE));
  });
});
