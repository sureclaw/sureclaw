/**
 * Tests the SkillState → SkillSummary projection that feeds the stdin
 * payload's `skills` field for the agent. Asserts the omit-empty shape
 * that the agent's SkillsModule expects.
 */
import { describe, test, expect } from 'vitest';
import { toSkillSummary } from '../../src/host/server-completions.js';

describe('toSkillSummary', () => {
  test('projects description and pendingReasons when set', () => {
    const out = toSkillSummary({
      name: 'linear',
      kind: 'pending',
      description: 'Linear issues',
      pendingReasons: ['needs LINEAR_TOKEN'],
    });
    expect(out).toEqual({
      name: 'linear',
      kind: 'pending',
      description: 'Linear issues',
      pendingReasons: ['needs LINEAR_TOKEN'],
    });
  });

  test('omits description and pendingReasons when absent on the source', () => {
    const out = toSkillSummary({ name: 'bad', kind: 'invalid', error: 'parse error' });
    expect(out).toEqual({ name: 'bad', kind: 'invalid', description: '' });
    expect(out).not.toHaveProperty('pendingReasons');
    // Error never leaks into the agent-facing summary.
    expect(out).not.toHaveProperty('error');
  });

  test('omits pendingReasons when the array is empty', () => {
    const out = toSkillSummary({
      name: 'weather',
      kind: 'enabled',
      description: 'Weather data',
      pendingReasons: [],
    });
    expect(out).toEqual({
      name: 'weather',
      kind: 'enabled',
      description: 'Weather data',
    });
    expect(out).not.toHaveProperty('pendingReasons');
  });
});
