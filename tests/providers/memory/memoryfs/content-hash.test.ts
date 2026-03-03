import { describe, it, expect } from 'vitest';
import { computeContentHash, buildRefId } from '../../../../src/providers/memory/memoryfs/content-hash.js';

describe('computeContentHash', () => {
  it('produces deterministic 16-char hex hash', () => {
    const hash = computeContentHash('Prefers TypeScript');
    expect(hash).toHaveLength(16);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
    expect(computeContentHash('Prefers TypeScript')).toBe(hash);
  });

  it('is type-agnostic (same text always produces same hash)', () => {
    const a = computeContentHash('The API uses REST');
    const b = computeContentHash('The API uses REST');
    expect(a).toBe(b);
  });

  it('normalizes whitespace', () => {
    const a = computeContentHash('  Prefers   TypeScript  ');
    const b = computeContentHash('Prefers TypeScript');
    expect(a).toBe(b);
  });

  it('normalizes case', () => {
    const a = computeContentHash('PREFERS TYPESCRIPT');
    const b = computeContentHash('prefers typescript');
    expect(a).toBe(b);
  });

  it('different content produces different hash', () => {
    const a = computeContentHash('Prefers TypeScript');
    const b = computeContentHash('Prefers JavaScript');
    expect(a).not.toBe(b);
  });
});

describe('buildRefId', () => {
  it('returns first 6 chars of content hash', () => {
    const hash = computeContentHash('Prefers TypeScript');
    const ref = buildRefId(hash);
    expect(ref).toBe(hash.slice(0, 6));
    expect(ref).toHaveLength(6);
  });
});
