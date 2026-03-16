import { describe, test, expect } from 'vitest';
import {
  encode, decode,
  eventSubject,
} from '../../src/host/nats-session-protocol.js';

describe('nats-session-protocol', () => {
  test('eventSubject formats correctly', () => {
    expect(eventSubject('req-456')).toBe('events.req-456');
  });

  test('encode/decode round-trip preserves data', () => {
    const original = {
      type: 'test',
      requestId: 'test-123',
      content: 'Hello, world!',
      nested: { a: 1, b: [2, 3] },
    };

    const encoded = encode(original);
    expect(encoded).toBeInstanceOf(Uint8Array);

    const decoded = decode<typeof original>(encoded);
    expect(decoded.type).toBe('test');
    expect(decoded.requestId).toBe('test-123');
    expect(decoded.content).toBe('Hello, world!');
    expect(decoded.nested).toEqual({ a: 1, b: [2, 3] });
  });

  test('encode handles unicode and special characters', () => {
    const data = {
      content: 'Hello 🌍! Tëst with spëcîal chars: <>&"\'',
    };

    const decoded = decode<typeof data>(encode(data));
    expect(decoded.content).toBe('Hello 🌍! Tëst with spëcîal chars: <>&"\'');
  });
});
