# Skill Dependency Installation — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Auto-install skill-declared package manager dependencies (npm, pip, cargo, go, uv) into persistent workspace directories so binaries survive across sessions.

**Architecture:** A new `installSkillDeps()` function reads SKILL.md files from workspace skill directories, parses install specs via `parseAgentSkill()`, checks `binExists()` for each declared binary, and runs missing install commands with package-manager prefix env vars redirecting output to `/workspace/user` or `/workspace/agent`. The existing HTTP proxy provides network access — no sandbox changes needed.

**Tech Stack:** Node.js child_process (`execFileSync` with `/bin/sh -c`), existing `parseAgentSkill()` parser, existing `binExists()` utility, existing web proxy bridge.

**Design doc:** `docs/plans/2026-03-19-skill-dependency-installation-design.md`

---

### Task 1: Fix pip install command to use --user flag

The `KIND_TO_RUN` mapping for pip currently emits `pip install {pkg}` which ignores `PYTHONUSERBASE`. It must emit `pip install --user {pkg}` so binaries land in `$PYTHONUSERBASE/bin/`.

**Files:**
- Modify: `src/utils/skill-format-parser.ts:82` (KIND_TO_RUN pip entry)
- Test: `tests/utils/skill-format-parser.test.ts`

**Step 1: Write the failing test**

Add to `tests/utils/skill-format-parser.test.ts` inside the install steps describe block:

```typescript
test('pip old-format install uses --user flag', () => {
  const skill = parseAgentSkill(`---
name: py-skill
metadata:
  openclaw:
    install:
      - kind: pip
        package: some-tool
        bins: [some-tool]
---
Body`);

  expect(skill.install).toHaveLength(1);
  expect(skill.install[0].run).toBe('pip install --user some-tool');
  expect(skill.install[0].bin).toBe('some-tool');
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/utils/skill-format-parser.test.ts`
Expected: FAIL — `pip install some-tool` does not match `pip install --user some-tool`

**Step 3: Fix the pip mapping**

In `src/utils/skill-format-parser.ts`, change line 82:

```typescript
// Before:
pip:    pkg => `pip install ${pkg}`,
// After:
pip:    pkg => `pip install --user ${pkg}`,
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/utils/skill-format-parser.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/utils/skill-format-parser.ts tests/utils/skill-format-parser.test.ts
git commit -m "fix: pip install uses --user flag for PYTHONUSERBASE compat"
```

---

### Task 2: Create skill-installer module with tests

This is the core new module. It reads skill directories, parses SKILL.md files for install specs, and runs missing installs with prefix env vars.

**Important:** Uses `execFileSync('/bin/sh', ['-c', step.run])` instead of `execSync(step.run)`. The `run` field contains shell commands from screened SKILL.md files — shell execution is intentional, but `execFileSync` makes it explicit and avoids double-shell issues.

**Files:**
- Create: `src/agent/skill-installer.ts`
- Create: `tests/agent/skill-installer.test.ts`

**Step 1: Write the tests**

Create `tests/agent/skill-installer.test.ts`:

```typescript
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
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/agent/skill-installer.test.ts`
Expected: FAIL — module `src/agent/skill-installer.ts` does not exist

**Step 3: Write the implementation**

Create `src/agent/skill-installer.ts`:

```typescript
/**
 * Skill dependency installer.
 *
 * Reads SKILL.md files from workspace skill directories, parses install
 * specs, and runs missing installs with package-manager prefix env vars
 * redirecting binaries to the target workspace path.
 *
 * Called by runners after the web proxy bridge is up (so HTTP_PROXY is set)
 * and before the agent loop starts.
 *
 * Uses execFileSync('/bin/sh', ['-c', cmd]) rather than execSync(cmd)
 * because the `run` field is intentionally a shell command from a screened
 * SKILL.md — execFileSync makes the shell invocation explicit.
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseAgentSkill } from '../utils/skill-format-parser.js';
import { binExists } from '../utils/bin-exists.js';
import { getLogger } from '../logger.js';
import type { ParsedAgentSkill } from '../providers/skills/types.js';

const logger = getLogger().child({ component: 'skill-installer' });

const INSTALL_TIMEOUT_MS = 120_000;

/** Map process.platform to the os values used in SKILL.md install specs. */
function currentOS(): string {
  switch (process.platform) {
    case 'darwin': return 'macos';
    case 'win32': return 'windows';
    default: return 'linux';
  }
}

/** Build env vars that redirect all package managers to install under prefix. */
function buildInstallEnv(prefix: string): Record<string, string> {
  const binDir = join(prefix, 'bin');
  return {
    ...process.env as Record<string, string>,
    npm_config_prefix: prefix,
    PYTHONUSERBASE: prefix,
    CARGO_INSTALL_ROOT: prefix,
    GOBIN: binDir,
    UV_TOOL_BIN_DIR: binDir,
  };
}

/**
 * Read and parse all SKILL.md files from a directory.
 * Supports both file-based (foo.md) and directory-based (foo/SKILL.md) skills.
 */
function loadSkillSpecs(dir: string): ParsedAgentSkill[] {
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    const skills: ParsedAgentSkill[] = [];

    for (const entry of entries) {
      try {
        let raw: string | undefined;

        if (entry.isFile() && entry.name.endsWith('.md')) {
          raw = readFileSync(join(dir, entry.name), 'utf-8');
        } else if (entry.isDirectory()) {
          const skillMdPath = join(dir, entry.name, 'SKILL.md');
          if (existsSync(skillMdPath)) {
            raw = readFileSync(skillMdPath, 'utf-8');
          }
        }

        if (raw) {
          skills.push(parseAgentSkill(raw));
        }
      } catch (err) {
        logger.warn('skill_parse_failed', { entry: entry.name, error: (err as Error).message });
      }
    }

    return skills;
  } catch {
    return [];
  }
}

/**
 * Install missing skill dependencies.
 *
 * @param skillDirs - Directories containing SKILL.md files (agent/skills, user/skills)
 * @param prefix - Target install prefix (/workspace/user or /workspace/agent)
 */
export async function installSkillDeps(skillDirs: string[], prefix: string): Promise<void> {
  const skills = skillDirs.flatMap(dir => loadSkillSpecs(dir));
  const stepsToRun = skills.flatMap(s => s.install);

  if (stepsToRun.length === 0) return;

  const os = currentOS();
  const env = buildInstallEnv(prefix);
  let installed = 0;

  for (const step of stepsToRun) {
    // OS filter
    if (step.os?.length && !step.os.includes(os)) {
      logger.debug('skip_os', { run: step.run, os: step.os, current: os });
      continue;
    }

    // Already installed?
    if (step.bin && await binExists(step.bin)) {
      logger.debug('skip_exists', { bin: step.bin });
      continue;
    }

    // Run install — shell command from screened SKILL.md, explicit /bin/sh invocation
    try {
      logger.info('installing', { run: step.run, bin: step.bin, prefix });
      execFileSync('/bin/sh', ['-c', step.run], { env, timeout: INSTALL_TIMEOUT_MS, stdio: 'pipe' });
      installed++;
      logger.info('installed', { bin: step.bin });
    } catch (err) {
      logger.warn('install_failed', { run: step.run, error: (err as Error).message });
    }
  }

  if (installed > 0) {
    logger.info('install_complete', { count: installed, prefix });
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/agent/skill-installer.test.ts`
Expected: PASS (all 7 tests)

**Step 5: Run full test suite**

Run: `npx vitest run`
Expected: All existing tests still pass

**Step 6: Commit**

```bash
git add src/agent/skill-installer.ts tests/agent/skill-installer.test.ts
git commit -m "feat: add skill dependency installer"
```

---

### Task 3: Wire installer into pi-session runner

Call `installSkillDeps()` in the pi-session runner after the web proxy bridge is set up (so `HTTP_PROXY` is in `process.env`) and before `buildSystemPrompt()`.

**Files:**
- Modify: `src/agent/runners/pi-session.ts`

**Step 1: Add the import and call**

In `src/agent/runners/pi-session.ts`, add the import at the top (after existing imports, around line 38):

```typescript
import { installSkillDeps } from '../skill-installer.js';
```

Then, after the `HTTP_PROXY` setup block (after line 381, before the "Decide LLM transport" comment at line 383), add:

```typescript
  // Install missing skill dependencies (proxy is already set for network access)
  const installPrefix = config.userWorkspace ?? config.agentWorkspace;
  if (installPrefix) {
    const skillDirs: string[] = [];
    if (config.agentWorkspace) skillDirs.push(join(config.agentWorkspace, 'skills'));
    if (config.userWorkspace) skillDirs.push(join(config.userWorkspace, 'skills'));
    await installSkillDeps(skillDirs, installPrefix);
  }
```

Note: `join` is already imported at line 9.

**Step 2: Run tests to verify nothing is broken**

Run: `npx vitest run tests/agent`
Expected: PASS

**Step 3: Commit**

```bash
git add src/agent/runners/pi-session.ts
git commit -m "feat: wire skill installer into pi-session runner"
```

---

### Task 4: Wire installer into claude-code runner

Same pattern as Task 3, but for the claude-code runner. The call goes after the web proxy bridge setup and before `buildSystemPrompt()`.

**Files:**
- Modify: `src/agent/runners/claude-code.ts`

**Step 1: Add the import and call**

In `src/agent/runners/claude-code.ts`, add the import (after line 30):

```typescript
import { installSkillDeps } from '../skill-installer.js';
import { join } from 'node:path';
```

Then, after the web proxy bridge block (after line 122, before the "Connect IPC client" comment at line 124), add:

```typescript
  // Install missing skill dependencies (proxy is already set for network access)
  const installPrefix = config.userWorkspace ?? config.agentWorkspace;
  if (installPrefix) {
    const skillDirs: string[] = [];
    if (config.agentWorkspace) skillDirs.push(join(config.agentWorkspace, 'skills'));
    if (config.userWorkspace) skillDirs.push(join(config.userWorkspace, 'skills'));
    await installSkillDeps(skillDirs, installPrefix);
  }
```

**Step 2: Run tests to verify nothing is broken**

Run: `npx vitest run tests/agent`
Expected: PASS

**Step 3: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass

**Step 4: Commit**

```bash
git add src/agent/runners/claude-code.ts
git commit -m "feat: wire skill installer into claude-code runner"
```

---

### Task 5: Update design doc status and journal

**Files:**
- Modify: `docs/plans/2026-03-19-skill-dependency-installation-design.md` (status → Implemented)
- Modify: `.claude/journal/agent/` (add entry)
- Modify: `.claude/lessons/` (if anything was learned)

**Step 1: Update design doc**

Change `**Status:** Design` to `**Status:** Implemented` in `docs/plans/2026-03-19-skill-dependency-installation-design.md`.

**Step 2: Add journal entry**

Append to appropriate `.claude/journal/agent/` file.

**Step 3: Commit**

```bash
git add docs/plans/2026-03-19-skill-dependency-installation-design.md .claude/journal/
git commit -m "docs: mark skill dependency installation as implemented"
```
