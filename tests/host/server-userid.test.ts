import { describe, test, expect } from 'vitest';
import { parseStdinPayload } from '../../src/agent/runner.js';

describe('server userId threading', () => {
  test('parseStdinPayload extracts userId from JSON payload', () => {
    const payload = JSON.stringify({
      message: 'hello',
      history: [],
      taintRatio: 0,
      taintThreshold: 0.3,
      profile: 'balanced',
      sandboxType: 'subprocess',
      userId: 'U12345',
    });

    const result = parseStdinPayload(payload);
    expect(result.userId).toBe('U12345');
  });

  test('parseStdinPayload returns undefined userId when not provided', () => {
    const payload = JSON.stringify({
      message: 'hello',
      history: [],
      taintRatio: 0,
      taintThreshold: 0.3,
      profile: 'balanced',
      sandboxType: 'subprocess',
    });

    const result = parseStdinPayload(payload);
    expect(result.userId).toBeUndefined();
  });

  test('parseStdinPayload returns undefined userId for plain text', () => {
    const result = parseStdinPayload('just a message');
    expect(result.userId).toBeUndefined();
  });
});
