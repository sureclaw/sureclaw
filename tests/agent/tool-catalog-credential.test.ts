import { describe, it, expect } from 'vitest';
import { TOOL_CATALOG } from '../../src/agent/tool-catalog.js';

describe('request_credential tool', () => {
  const credTool = TOOL_CATALOG.find(t => t.name === 'request_credential');

  it('exists as a standalone tool', () => {
    expect(credTool).toBeDefined();
  });

  it('has singletonAction credential_request', () => {
    expect(credTool?.singletonAction).toBe('credential_request');
  });

  it('has credential category (always included by filterTools)', () => {
    expect(credTool?.category).toBe('credential');
  });

  it('has envName parameter', () => {
    const schema = credTool?.parameters as any;
    expect(schema.properties?.envName).toBeDefined();
  });
});
