import { describe, test, expect } from 'vitest';
import { loadIdentityFiles } from '../../src/agent/identity-loader.js';

describe('loadIdentityFiles', () => {
  test('returns defaults when called with no arguments', () => {
    const files = loadIdentityFiles();
    expect(files.agents).toBe('');
    expect(files.soul).toBe('');
    expect(files.identity).toBe('');
    expect(files.bootstrap).toBe('');
    expect(files.userBootstrap).toBe('');
    expect(files.heartbeat).toBe('');
  });

  test('returns defaults when called with empty object', () => {
    const files = loadIdentityFiles({});
    expect(files.agents).toBe('');
    expect(files.soul).toBe('');
    expect(files.identity).toBe('');
    expect(files.bootstrap).toBe('');
    expect(files.userBootstrap).toBe('');
    expect(files.heartbeat).toBe('');
  });

  test('returns preloaded identity data directly', () => {
    const preloaded = {
      agents: '# Agents',
      soul: '# Soul',
      identity: '# Identity',
      bootstrap: '# Bootstrap',
      userBootstrap: '# User Bootstrap',
      heartbeat: '# Heartbeat',
    };

    const files = loadIdentityFiles(preloaded);
    expect(files.soul).toBe('# Soul');
    expect(files.agents).toBe('# Agents');
    expect(files.identity).toBe('# Identity');
    expect(files.bootstrap).toBe('# Bootstrap');
    expect(files.userBootstrap).toBe('# User Bootstrap');
    expect(files.heartbeat).toBe('# Heartbeat');
  });

  test('fills in defaults for missing preloaded fields', () => {
    const files = loadIdentityFiles({ soul: '# My Soul' });
    expect(files.soul).toBe('# My Soul');
    expect(files.agents).toBe('');
    expect(files.identity).toBe('');
    expect(files.bootstrap).toBe('');
    expect(files.userBootstrap).toBe('');
    expect(files.heartbeat).toBe('');
  });
});
