/**
 * Unit tests for the diagnostic collector — the host-side in-memory buffer
 * that captures user-surfacable failure/warning events during a chat turn.
 * Paired with `src/host/diagnostics.ts`. These diagnostics are the
 * parallel signal to structured logs; the collected entries will eventually
 * be emitted as SSE events (Task B2) and rendered in the chat UI (Task B3).
 */

import { describe, test, expect } from 'vitest';
import {
  createDiagnosticCollector,
  type Diagnostic,
} from '../../src/host/diagnostics.js';

describe('createDiagnosticCollector', () => {
  test('returns an empty list on construction', () => {
    const collector = createDiagnosticCollector();
    expect(collector.list()).toEqual([]);
  });

  test('push + list returns entries in insertion order', () => {
    const collector = createDiagnosticCollector();
    collector.push({ severity: 'info', kind: 'a', message: 'first' });
    collector.push({ severity: 'warn', kind: 'b', message: 'second' });
    collector.push({ severity: 'error', kind: 'c', message: 'third' });
    const list = collector.list();
    expect(list.map((d) => d.kind)).toEqual(['a', 'b', 'c']);
    expect(list.map((d) => d.message)).toEqual(['first', 'second', 'third']);
    expect(list.map((d) => d.severity)).toEqual(['info', 'warn', 'error']);
  });

  test('push adds a valid ISO 8601 timestamp', () => {
    const collector = createDiagnosticCollector();
    const before = Date.now();
    collector.push({ severity: 'info', kind: 'k', message: 'm' });
    const after = Date.now();
    const [d] = collector.list();
    // ISO 8601 with ms and trailing Z — Date#toISOString format.
    expect(d.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const parsed = Date.parse(d.timestamp);
    expect(parsed).not.toBeNaN();
    expect(parsed).toBeGreaterThanOrEqual(before);
    expect(parsed).toBeLessThanOrEqual(after);
  });

  test('preserves context field when provided', () => {
    const collector = createDiagnosticCollector();
    collector.push({
      severity: 'warn',
      kind: 'k',
      message: 'm',
      context: { skill: 'petstore', count: 3, flag: true },
    });
    const [d] = collector.list();
    expect(d.context).toEqual({ skill: 'petstore', count: 3, flag: true });
  });

  test('reset clears the buffer', () => {
    const collector = createDiagnosticCollector();
    collector.push({ severity: 'info', kind: 'a', message: 'one' });
    collector.push({ severity: 'info', kind: 'b', message: 'two' });
    expect(collector.list()).toHaveLength(2);
    collector.reset();
    expect(collector.list()).toEqual([]);
    // And we can push again after reset without errors.
    collector.push({ severity: 'info', kind: 'c', message: 'three' });
    expect(collector.list()).toHaveLength(1);
  });

  test('caps at 50 entries and emits an overflow marker at the tail', () => {
    const collector = createDiagnosticCollector();
    // Push 51 distinct entries. The oldest should be dropped and replaced
    // with a single overflow marker so the UI still surfaces that diagnostics
    // were suppressed.
    for (let i = 0; i < 51; i += 1) {
      collector.push({ severity: 'warn', kind: 'bulk', message: `entry ${i}` });
    }
    const list = collector.list();
    expect(list).toHaveLength(50);
    // Shape: 49 retained originals (entries 2..50) + 1 overflow marker at the tail.
    const tail = list[list.length - 1];
    expect(tail.kind).toBe('diagnostic_overflow');
    expect(tail.severity).toBe('warn');
    expect(tail.message).toMatch(/additional diagnostic/i);
    // Retained slice: the 49 items before the marker should be the 49 most
    // recent original entries (2..50).
    const retained = list.slice(0, 49);
    expect(retained[0].message).toBe('entry 2');
    expect(retained[retained.length - 1].message).toBe('entry 50');
  });

  test('returned list is immutable from the caller\'s perspective', () => {
    const collector = createDiagnosticCollector();
    collector.push({ severity: 'info', kind: 'a', message: 'one' });
    const list = collector.list();
    // Mutating the returned array (by casting off readonly) must not affect
    // the collector's internal state.
    expect(() => {
      (list as Diagnostic[]).push({
        severity: 'info',
        kind: 'injected',
        message: 'mutation',
        timestamp: new Date().toISOString(),
      });
    }).not.toThrow();
    // Re-reading the list must still show just the original entry.
    const reread = collector.list();
    expect(reread).toHaveLength(1);
    expect(reread[0].kind).toBe('a');
  });
});
