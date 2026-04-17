import { describe, it, expect } from 'vitest';
import { IPC_SCHEMAS } from '../../src/ipc-schemas.js';

describe('skills_index IPC schema', () => {
  it('is registered in IPC_SCHEMAS', () => {
    expect(IPC_SCHEMAS).toHaveProperty('skills_index');
  });

  it('accepts an envelope with only the action field', () => {
    const schema = IPC_SCHEMAS['skills_index'];
    expect(() => schema.parse({ action: 'skills_index' })).not.toThrow();
  });

  it('rejects unknown fields (strict)', () => {
    const schema = IPC_SCHEMAS['skills_index'];
    expect(() => schema.parse({ action: 'skills_index', extra: 1 })).toThrow();
  });

  it('rejects wrong action literal', () => {
    const schema = IPC_SCHEMAS['skills_index'];
    expect(() => schema.parse({ action: 'skills_list' })).toThrow();
  });
});
