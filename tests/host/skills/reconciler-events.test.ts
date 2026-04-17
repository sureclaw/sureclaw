import { describe, it, expect } from 'vitest';
import { computeEvents } from '../../../src/host/skills/reconciler.js';
import type { SkillState } from '../../../src/host/skills/types.js';

const e = (name: string): SkillState => ({ name, kind: 'enabled', description: 'd' });
const p = (name: string, reasons: string[] = ['x']): SkillState => ({
  name,
  kind: 'pending',
  description: 'd',
  pendingReasons: reasons,
});
const inv = (name: string): SkillState => ({ name, kind: 'invalid', error: 'bad' });

describe('computeEvents', () => {
  it('emits skill.installed + skill.enabled for a new enabled skill', () => {
    const events = computeEvents([e('a')], new Map());
    const types = events.map((ev) => ev.type);
    expect(types).toContain('skill.installed');
    expect(types).toContain('skill.enabled');
  });

  it('emits skill.installed + skill.pending for a new pending skill', () => {
    const events = computeEvents([p('a')], new Map());
    const types = events.map((ev) => ev.type);
    expect(types).toContain('skill.installed');
    expect(types).toContain('skill.pending');
  });

  it('emits skill.invalid with the error', () => {
    const events = computeEvents([inv('a')], new Map());
    expect(events.find((ev) => ev.type === 'skill.invalid')?.data.error).toBe('bad');
  });

  it('emits skill.removed when a previously-known skill is gone', () => {
    const prior = new Map([['gone', 'enabled' as const]]);
    const events = computeEvents([], prior);
    expect(events.map((ev) => ev.type)).toContain('skill.removed');
  });

  it('emits skill.enabled when a pending skill transitions to enabled', () => {
    const prior = new Map([['a', 'pending' as const]]);
    const events = computeEvents([e('a')], prior);
    const types = events.map((ev) => ev.type);
    expect(types).toContain('skill.enabled');
    expect(types).not.toContain('skill.installed'); // not new
  });

  it('emits no events when state is unchanged', () => {
    const prior = new Map([['a', 'enabled' as const]]);
    expect(computeEvents([e('a')], prior)).toEqual([]);
  });

  it('omits reasons/error from skill.enabled payload when undefined', () => {
    const events = computeEvents([e('a')], new Map());
    const enabledEvent = events.find((ev) => ev.type === 'skill.enabled');
    expect(enabledEvent?.data).toEqual({ name: 'a' });
    expect('reasons' in (enabledEvent?.data ?? {})).toBe(false);
    expect('error' in (enabledEvent?.data ?? {})).toBe(false);
  });

  it('includes reasons on skill.pending but omits error', () => {
    const events = computeEvents([p('a', ['missing X'])], new Map());
    const pendingEvent = events.find((ev) => ev.type === 'skill.pending');
    expect(pendingEvent?.data).toEqual({ name: 'a', reasons: ['missing X'] });
    expect('error' in (pendingEvent?.data ?? {})).toBe(false);
  });

  it('includes error on skill.invalid but omits reasons', () => {
    const events = computeEvents([inv('a')], new Map());
    const invalidEvent = events.find((ev) => ev.type === 'skill.invalid');
    expect(invalidEvent?.data).toEqual({ name: 'a', error: 'bad' });
    expect('reasons' in (invalidEvent?.data ?? {})).toBe(false);
  });
});
