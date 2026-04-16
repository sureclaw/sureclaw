import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock execFileSync to simulate git show output
vi.mock('node:child_process', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:child_process')>();
  return {
    ...orig,
    execFileSync: vi.fn((cmd: string, args: string[], opts?: any) => {
      // Only intercept git show commands
      if (cmd === 'git' && args?.[0] === 'show') {
        const ref = args[1]; // e.g. HEAD:.ax/SOUL.md
        const gitFiles: Record<string, string> = {
          'HEAD:.ax/SOUL.md': 'I am thoughtful.',
          'HEAD:.ax/IDENTITY.md': 'I am AX.',
          'HEAD:.ax/AGENTS.md': 'You are a helpful agent.',
          'HEAD:.ax/HEARTBEAT.md': 'Check in daily.',
        };
        if (ref in gitFiles) return gitFiles[ref];
        throw new Error(`fatal: path not found: ${ref}`);
      }
      return orig.execFileSync(cmd, args, opts);
    }),
  };
});

// Import AFTER mock is set up
import { loadIdentityFromGit } from '../../src/host/server-completions.js';
import { execFileSync } from 'node:child_process';

describe('loadIdentityFromGit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Restore default mock behavior
    (execFileSync as any).mockImplementation((cmd: string, args: string[], opts?: any) => {
      if (cmd === 'git' && args?.[0] === 'show') {
        const ref = args[1];
        const gitFiles: Record<string, string> = {
          'HEAD:.ax/SOUL.md': 'I am thoughtful.',
          'HEAD:.ax/IDENTITY.md': 'I am AX.',
          'HEAD:.ax/AGENTS.md': 'You are a helpful agent.',
          'HEAD:.ax/HEARTBEAT.md': 'Check in daily.',
        };
        if (ref in gitFiles) return gitFiles[ref];
        throw new Error(`fatal: path not found: ${ref}`);
      }
      return '';
    });
  });

  // BOOTSTRAP.md and USER_BOOTSTRAP.md are loaded from templates/, not git.
  it('loads identity files from committed git state', () => {
    const result = loadIdentityFromGit('/workspace', '/gitdir');
    expect(result.soul).toBe('I am thoughtful.');
    expect(result.identity).toBe('I am AX.');
    expect(result.agents).toBe('You are a helpful agent.');
    expect(result.heartbeat).toBe('Check in daily.');
  });

  it('returns empty payload when no git files exist', () => {
    (execFileSync as any).mockImplementation(() => {
      throw new Error('not found');
    });

    const result = loadIdentityFromGit('/workspace', '/gitdir');
    expect(result.soul).toBeUndefined();
    expect(result.identity).toBeUndefined();
    expect(result.agents).toBeUndefined();
    expect(result.heartbeat).toBeUndefined();
    expect(result.bootstrap).toBeUndefined();
    expect(result.userBootstrap).toBeUndefined();
  });

  it('returns partial payload when some files exist', () => {
    (execFileSync as any).mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'git' && args?.[0] === 'show') {
        const ref = args[1];
        if (ref === 'HEAD:.ax/SOUL.md') return 'I am thoughtful.';
        throw new Error('not found');
      }
      return '';
    });

    const result = loadIdentityFromGit('/workspace', '/gitdir');
    expect(result.soul).toBe('I am thoughtful.');
    expect(result.identity).toBeUndefined();
    expect(result.agents).toBeUndefined();
  });
});
