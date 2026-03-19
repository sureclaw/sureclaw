import { describe, test, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Mock binExists before importing the module under test
vi.mock('../../src/utils/bin-exists.js', () => ({
  binExists: vi.fn(),
}));

// Mock child_process
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

import { installSkillDeps } from '../../src/agent/skill-installer.js';
import { binExists } from '../../src/utils/bin-exists.js';
import { execFileSync } from 'node:child_process';

const mockedBinExists = vi.mocked(binExists);
const mockedExecFileSync = vi.mocked(execFileSync);

describe('skill-installer', () => {
  let skillDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    skillDir = mkdtempSync(join(tmpdir(), 'skill-install-test-'));
  });

  test('skips install when binary already exists', async () => {
    writeFileSync(join(skillDir, 'browser.md'), `---
name: browser
metadata:
  openclaw:
    install:
      - kind: npm
        package: playwright
        bins: [playwright]
---
Browser skill`);

    mockedBinExists.mockResolvedValue(true);

    await installSkillDeps([skillDir], '/workspace/user');

    expect(mockedBinExists).toHaveBeenCalledWith('playwright');
    expect(mockedExecFileSync).not.toHaveBeenCalled();
  });

  test('runs install when binary is missing', async () => {
    writeFileSync(join(skillDir, 'browser.md'), `---
name: browser
metadata:
  openclaw:
    install:
      - kind: npm
        package: playwright
        bins: [playwright]
---
Browser skill`);

    mockedBinExists.mockResolvedValue(false);

    await installSkillDeps([skillDir], '/workspace/user');

    expect(mockedExecFileSync).toHaveBeenCalledTimes(1);
    expect(mockedExecFileSync).toHaveBeenCalledWith(
      '/bin/sh',
      ['-c', 'npm install -g playwright'],
      expect.objectContaining({
        timeout: 120_000,
        env: expect.objectContaining({
          npm_config_prefix: '/workspace/user',
          CARGO_INSTALL_ROOT: '/workspace/user',
          PYTHONUSERBASE: '/workspace/user',
          GOBIN: '/workspace/user/bin',
          UV_TOOL_BIN_DIR: '/workspace/user/bin',
        }),
      }),
    );
  });

  test('filters by OS constraint', async () => {
    writeFileSync(join(skillDir, 'mac-only.md'), `---
name: mac-only
metadata:
  openclaw:
    install:
      - run: "brew install something"
        bin: something
        os: [macos]
---
Mac only`);

    mockedBinExists.mockResolvedValue(false);

    await installSkillDeps([skillDir], '/workspace/user');

    if (process.platform === 'darwin') {
      expect(mockedExecFileSync).toHaveBeenCalledTimes(1);
    } else {
      expect(mockedExecFileSync).not.toHaveBeenCalled();
    }
  });

  test('handles directory-based skills (subdir/SKILL.md)', async () => {
    const subdir = join(skillDir, 'deploy');
    mkdirSync(subdir);
    writeFileSync(join(subdir, 'SKILL.md'), `---
name: deploy
metadata:
  openclaw:
    install:
      - kind: cargo
        package: deploy-tool
        bins: [deploy-tool]
---
Deploy skill`);

    mockedBinExists.mockResolvedValue(false);

    await installSkillDeps([skillDir], '/workspace/agent');

    expect(mockedExecFileSync).toHaveBeenCalledWith(
      '/bin/sh',
      ['-c', 'cargo install deploy-tool'],
      expect.objectContaining({
        env: expect.objectContaining({
          CARGO_INSTALL_ROOT: '/workspace/agent',
        }),
      }),
    );
  });

  test('continues on install failure', async () => {
    writeFileSync(join(skillDir, 'a.md'), `---
name: a
metadata:
  openclaw:
    install:
      - kind: npm
        package: tool-a
        bins: [tool-a]
---
A`);
    writeFileSync(join(skillDir, 'b.md'), `---
name: b
metadata:
  openclaw:
    install:
      - kind: npm
        package: tool-b
        bins: [tool-b]
---
B`);

    mockedBinExists.mockResolvedValue(false);
    mockedExecFileSync
      .mockImplementationOnce(() => { throw new Error('npm registry down'); })
      .mockImplementationOnce(() => Buffer.from(''));

    // Should not throw — logs error and continues
    await installSkillDeps([skillDir], '/workspace/user');

    expect(mockedExecFileSync).toHaveBeenCalledTimes(2);
  });

  test('skips skills with no install steps', async () => {
    writeFileSync(join(skillDir, 'simple.md'), `---
name: simple
description: No deps needed
---
Just a simple skill`);

    await installSkillDeps([skillDir], '/workspace/user');

    expect(mockedBinExists).not.toHaveBeenCalled();
    expect(mockedExecFileSync).not.toHaveBeenCalled();
  });

  test('handles empty or missing skill directories', async () => {
    await installSkillDeps(['/nonexistent/path'], '/workspace/user');
    expect(mockedExecFileSync).not.toHaveBeenCalled();
  });
});
