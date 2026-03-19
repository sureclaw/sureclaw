import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
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

// Platform-aware expected shell args (matches shellCommand() in skill-installer)
const expectedShell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
const expectedFlag = process.platform === 'win32' ? '/c' : '-c';

describe('skill-installer', () => {
  let skillDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    skillDir = mkdtempSync(join(tmpdir(), 'skill-install-test-'));
  });

  afterEach(() => {
    if (skillDir) rmSync(skillDir, { recursive: true, force: true });
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

    await installSkillDeps([{ skillDir, prefix: '/workspace/user' }]);

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

    await installSkillDeps([{ skillDir, prefix: '/workspace/user' }]);

    expect(mockedExecFileSync).toHaveBeenCalledTimes(1);
    expect(mockedExecFileSync).toHaveBeenCalledWith(
      expectedShell,
      [expectedFlag, 'npm install -g playwright'],
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

  test('skips install when OS constraint excludes current platform', async () => {
    // os: [nonexistent] never matches any real platform
    writeFileSync(join(skillDir, 'alien.md'), `---
name: alien
metadata:
  openclaw:
    install:
      - run: "alien-pkg install something"
        bin: something
        os: [nonexistent]
---
Alien only`);

    mockedBinExists.mockResolvedValue(false);

    await installSkillDeps([{ skillDir, prefix: '/workspace/user' }]);

    expect(mockedExecFileSync).not.toHaveBeenCalled();
  });

  test('runs install when OS constraint includes current platform', async () => {
    // os includes all three recognized values — always matches
    writeFileSync(join(skillDir, 'universal.md'), `---
name: universal
metadata:
  openclaw:
    install:
      - run: "uni-pkg install something"
        bin: something
        os: [macos, linux, windows]
---
Universal`);

    mockedBinExists.mockResolvedValue(false);

    await installSkillDeps([{ skillDir, prefix: '/workspace/user' }]);

    expect(mockedExecFileSync).toHaveBeenCalledTimes(1);
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

    await installSkillDeps([{ skillDir, prefix: '/workspace/agent' }]);

    expect(mockedExecFileSync).toHaveBeenCalledWith(
      expectedShell,
      [expectedFlag, 'cargo install deploy-tool'],
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
    await installSkillDeps([{ skillDir, prefix: '/workspace/user' }]);

    expect(mockedExecFileSync).toHaveBeenCalledTimes(2);
  });

  test('skips skills with no install steps', async () => {
    writeFileSync(join(skillDir, 'simple.md'), `---
name: simple
description: No deps needed
---
Just a simple skill`);

    await installSkillDeps([{ skillDir, prefix: '/workspace/user' }]);

    expect(mockedBinExists).not.toHaveBeenCalled();
    expect(mockedExecFileSync).not.toHaveBeenCalled();
  });

  test('handles empty or missing skill directories', async () => {
    await installSkillDeps([{ skillDir: '/nonexistent/path', prefix: '/workspace/user' }]);
    expect(mockedExecFileSync).not.toHaveBeenCalled();
  });
});
