import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HeartbeatState, parseCadences } from '../../src/agent/heartbeat-state.js';

describe('HeartbeatState', () => {
  let dir: string;
  let state: HeartbeatState;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hb-state-'));
    state = new HeartbeatState(dir);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('returns null for unknown check', () => {
    expect(state.lastRun('memory-review')).toBeNull();
  });

  it('records and retrieves last run time', () => {
    const now = Date.now();
    state.markRun('memory-review', now);
    expect(state.lastRun('memory-review')).toBe(now);
  });

  it('persists state to disk', () => {
    state.markRun('memory-review', 1000);
    const state2 = new HeartbeatState(dir);
    expect(state2.lastRun('memory-review')).toBe(1000);
  });

  it('isOverdue returns true when never run', () => {
    expect(state.isOverdue('memory-review', 60)).toBe(true);
  });

  it('isOverdue returns false when recently run', () => {
    state.markRun('memory-review', Date.now());
    expect(state.isOverdue('memory-review', 60)).toBe(false);
  });

  it('isOverdue returns true when cadence exceeded', () => {
    state.markRun('memory-review', Date.now() - 120 * 60 * 1000);
    expect(state.isOverdue('memory-review', 60)).toBe(true);
  });

  it('formats summary with overdue status', () => {
    state.markRun('a', Date.now());
    state.markRun('b', Date.now() - 300 * 60 * 1000);
    const summary = state.summarize({ a: 60, b: 120 });
    expect(summary).toContain('a');
    expect(summary).toContain('b');
    expect(summary).toMatch(/b.*OVERDUE/i);
  });

  it('marks never-run checks as OVERDUE in summary', () => {
    const summary = state.summarize({ 'new-check': 30 });
    expect(summary).toContain('never run');
    expect(summary).toContain('OVERDUE');
  });
});

describe('parseCadences', () => {
  it('parses hours cadence from HEARTBEAT.md format', () => {
    const md = '- **memory-review** (every 4h): Review memories';
    expect(parseCadences(md)).toEqual({ 'memory-review': 240 });
  });

  it('parses minutes cadence', () => {
    const md = '- **quick-check** (every 30m): Do a quick check';
    expect(parseCadences(md)).toEqual({ 'quick-check': 30 });
  });

  it('parses multiple checks', () => {
    const md = [
      '# Heartbeat Checklist',
      '',
      '## Checks',
      '',
      '- **memory-review** (every 4h): Review recent memories',
      '- **pending-tasks** (every 1h): Check pending tasks',
    ].join('\n');
    expect(parseCadences(md)).toEqual({
      'memory-review': 240,
      'pending-tasks': 60,
    });
  });

  it('returns empty object for content with no checks', () => {
    expect(parseCadences('# Just a heading\nSome text')).toEqual({});
  });

  it('returns empty object for empty string', () => {
    expect(parseCadences('')).toEqual({});
  });
});
