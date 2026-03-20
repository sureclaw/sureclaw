import { describe, it, expect } from 'vitest';
import { TOOL_CATALOG } from '../../src/agent/tool-catalog.js';

describe('skill tool credential_request action', () => {
  const skillTool = TOOL_CATALOG.find(t => t.name === 'skill');

  it('has request_credential in actionMap', () => {
    expect(skillTool?.actionMap).toHaveProperty('request_credential', 'credential_request');
  });

  it('has search, download, and request_credential types', () => {
    // Verify all action types exist in the actionMap
    expect(skillTool?.actionMap).toEqual({
      search: 'skill_search',
      download: 'skill_download',
      request_credential: 'credential_request',
    });
  });
});
