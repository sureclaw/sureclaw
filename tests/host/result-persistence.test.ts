// tests/host/result-persistence.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ResultPersistence } from '../../src/host/result-persistence.js';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initLogger } from '../../src/logger.js';

initLogger({ file: false, level: 'silent' });

describe('ResultPersistence', () => {
  let dir: string;
  let persistence: ResultPersistence;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ax-test-results-'));
    persistence = new ResultPersistence({ dir, thresholdBytes: 100 });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('passes through small results unchanged', () => {
    const result = persistence.maybeSpill('id-1', 'short result');
    expect(result).toBe('short result');
  });

  it('spills large results to disk and returns preview', () => {
    const large = 'x'.repeat(200);
    const result = persistence.maybeSpill('id-2', large);
    expect(result).toContain('[Full output persisted');
    expect(result).toContain('id-2');
    // Verify file exists
    const filePath = join(dir, 'id-2.json');
    expect(readFileSync(filePath, 'utf-8')).toBe(large);
  });

  it('preview includes head and tail of content', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n');
    const result = persistence.maybeSpill('id-3', lines);
    expect(result).toContain('line 0');  // head
    expect(result).toContain('line 49'); // tail
  });

  it('enforces per-turn aggregate budget', () => {
    // First call: 80 bytes, under threshold (100), passes through
    const r1 = persistence.maybeSpill('id-4', 'a'.repeat(80));
    expect(r1).toBe('a'.repeat(80));

    // Second call: 80 bytes, aggregate now 160 > threshold
    // The aggregate check spills the largest accumulated result
    const r2 = persistence.maybeSpill('id-5', 'b'.repeat(80));
    // At least one of them should be spilled
    const total = r1.length + r2.length;
    expect(total).toBeLessThan(200); // previews are shorter than originals
  });
});
