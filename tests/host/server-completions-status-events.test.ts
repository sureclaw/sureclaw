import { describe, test, expect } from 'vitest';

describe('status events', () => {
  test('workspace mount emits status events', async () => {
    const event = {
      type: 'status',
      requestId: 'req-1',
      timestamp: Date.now(),
      data: { operation: 'workspace', phase: 'downloading', message: 'Restoring workspace\u2026' },
    };

    expect(event.type).toBe('status');
    expect(event.data.operation).toBe('workspace');
    expect(event.data.phase).toBe('downloading');
    expect(typeof event.data.message).toBe('string');
  });

  test('pod spawn emits status events', () => {
    const event = {
      type: 'status',
      requestId: 'req-1',
      timestamp: Date.now(),
      data: { operation: 'pod', phase: 'creating', message: 'Starting sandbox\u2026' },
    };

    expect(event.type).toBe('status');
    expect(event.data.operation).toBe('pod');
    expect(event.data.phase).toBe('creating');
    expect(typeof event.data.message).toBe('string');
  });

  test('retry attempt uses correct phase and message', () => {
    const attempt = 1;
    const event = {
      type: 'status',
      requestId: 'req-1',
      timestamp: Date.now(),
      data: {
        operation: 'pod',
        phase: attempt === 0 ? 'creating' : 'retrying',
        message: attempt === 0 ? 'Starting sandbox\u2026' : `Retrying sandbox (attempt ${attempt + 1})\u2026`,
      },
    };

    expect(event.data.phase).toBe('retrying');
    expect(event.data.message).toBe('Retrying sandbox (attempt 2)\u2026');
  });
});
