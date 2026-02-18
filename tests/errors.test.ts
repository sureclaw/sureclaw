// tests/errors.test.ts
import { describe, it, expect } from 'vitest';
import { diagnoseError } from '../src/errors.js';

describe('diagnoseError', () => {
  it('should diagnose ETIMEDOUT', () => {
    const d = diagnoseError(new Error('connect ETIMEDOUT 104.18.0.1:443'));
    expect(d.diagnosis).toContain('timeout');
    expect(d.suggestion).toBeTruthy();
    expect(d.raw).toContain('ETIMEDOUT');
  });

  it('should diagnose ECONNREFUSED', () => {
    const d = diagnoseError(new Error('connect ECONNREFUSED 127.0.0.1:8080'));
    expect(d.diagnosis).toContain('refused');
    expect(d.suggestion).toContain('running');
  });

  it('should diagnose ECONNRESET', () => {
    const d = diagnoseError('read ECONNRESET');
    expect(d.diagnosis).toContain('dropped');
  });

  it('should diagnose ENOTFOUND', () => {
    const d = diagnoseError(new Error('getaddrinfo ENOTFOUND api.anthropic.com'));
    expect(d.diagnosis).toContain('DNS');
  });

  it('should diagnose HTTP 401', () => {
    const d = diagnoseError('401 Unauthorized');
    expect(d.diagnosis.toLowerCase()).toContain('authentication');
    expect(d.suggestion).toContain('ax configure');
  });

  it('should diagnose HTTP 429', () => {
    const d = diagnoseError('429 Too Many Requests');
    expect(d.diagnosis.toLowerCase()).toContain('rate');
  });

  it('should diagnose HTTP 502/503', () => {
    const d = diagnoseError('502 Bad Gateway');
    expect(d.diagnosis).toContain('API');
  });

  it('should handle unknown errors gracefully', () => {
    const d = diagnoseError('something completely unknown happened');
    expect(d.raw).toContain('something completely unknown');
    expect(d.logHint).toContain('ax.log');
  });

  it('should accept Error objects', () => {
    const d = diagnoseError(new Error('EPIPE'));
    expect(d.diagnosis).toBeTruthy();
  });

  it('should diagnose socket hangup', () => {
    const d = diagnoseError('socket hang up');
    expect(d.diagnosis).toContain('closed');
  });
});
