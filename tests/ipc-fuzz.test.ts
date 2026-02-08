import { describe, test, expect } from 'vitest';
import * as fc from 'fast-check';
import { IPC_SCHEMAS, IPCEnvelopeSchema } from '../src/ipc-schemas.js';

describe('IPC Fuzz Testing', () => {

  test('random objects never cause uncaught exceptions in envelope parsing', () => {
    fc.assert(
      fc.property(fc.anything(), (input) => {
        const result = IPCEnvelopeSchema.safeParse(input);
        expect(typeof result.success).toBe('boolean');
      }),
      { numRuns: 10_000 }
    );
  });

  test('random strings never cause uncaught exceptions in JSON.parse + validate', () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(input);
        } catch {
          return; // Invalid JSON is handled before schemas
        }

        const envelope = IPCEnvelopeSchema.safeParse(parsed);
        if (!envelope.success) return;

        const schema = IPC_SCHEMAS[envelope.data.action];
        if (!schema) return;

        const result = schema.safeParse(parsed);
        expect(typeof result.success).toBe('boolean');
      }),
      { numRuns: 10_000 }
    );
  });

  test('deep nested objects do not cause stack overflow', () => {
    fc.assert(
      fc.property(
        fc.anything({
          maxDepth: 20,
          withBigInt: false,
          withDate: false,
          withMap: false,
          withSet: false,
          withTypedArray: false,
        }),
        (input) => {
          IPCEnvelopeSchema.safeParse(input);
        }
      ),
      { numRuns: 5_000 }
    );
  });

  test('random objects with valid action names are handled safely', () => {
    const actions = Object.keys(IPC_SCHEMAS);
    fc.assert(
      fc.property(
        fc.constantFrom(...actions),
        fc.anything(),
        (action, extra) => {
          const payload = { action, ...(typeof extra === 'object' && extra !== null ? extra : {}) };
          const schema = IPC_SCHEMAS[action];
          const result = schema.safeParse(payload);
          expect(typeof result.success).toBe('boolean');
        }
      ),
      { numRuns: 10_000 }
    );
  });
});
