# Configure Command — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a `ax configure` CLI command that launches an interactive terminal UI (via @inquirer/prompts) to generate `ax.yaml`. On first run without a config, it auto-triggers. On subsequent runs, it pre-fills answers from the existing config. All config and data files live in `~/.ax/`.

**Architecture:** Standalone CLI module (`src/onboarding/`) with three layers: (1) profile defaults data (`prompts.ts`), (2) config generation logic (`wizard.ts` — pure function, testable without terminal), (3) interactive UI (`configure.ts` — inquirer prompts, loads existing config as defaults). A new `src/paths.ts` module centralizes all file paths under `~/.ax/`. CLI arg parsing in `host.ts` gains a `configure` subcommand. First-run detection triggers the same flow.

**Tech Stack:** TypeScript, `@inquirer/prompts` (new dependency), `yaml` (existing)

---

### Task 1: Centralize Paths to ~/.ax + Tests

All config and data files currently use hardcoded relative paths (`data/memory.db`, `ax.yaml`, `.env`). This task creates a single `src/paths.ts` module that resolves everything under `~/.ax/`, then updates all consumers.

**Files:**
- Create: `src/paths.ts`
- Create: `tests/paths.test.ts`
- Modify: `src/config.ts`
- Modify: `src/host.ts`
- Modify: `src/db.ts`
- Modify: `src/providers/memory/file.ts`
- Modify: `src/providers/memory/sqlite.ts`
- Modify: `src/providers/audit/file.ts`
- Modify: `src/providers/audit/sqlite.ts`
- Modify: `src/providers/credentials/encrypted.ts`

**Step 1: Write failing tests in `tests/paths.test.ts`**

```typescript
import { describe, test, expect, afterEach, beforeEach } from 'vitest';
import { join } from 'node:path';
import { homedir } from 'node:os';

describe('paths', () => {
  const originalEnv = process.env.AX_HOME;

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.AX_HOME = originalEnv;
    } else {
      delete process.env.AX_HOME;
    }
  });

  test('defaults to ~/.ax', async () => {
    delete process.env.AX_HOME;
    // Re-import to pick up env change
    const { axHome, configPath, envPath, dataDir } = await import('../src/paths.js');
    expect(axHome()).toBe(join(homedir(), '.ax'));
    expect(configPath()).toBe(join(homedir(), '.ax', 'ax.yaml'));
    expect(envPath()).toBe(join(homedir(), '.ax', '.env'));
    expect(dataDir()).toBe(join(homedir(), '.ax', 'data'));
  });

  test('respects AX_HOME env override', async () => {
    process.env.AX_HOME = '/tmp/sc-test';
    const { axHome, configPath, dataDir } = await import('../src/paths.js');
    expect(axHome()).toBe('/tmp/sc-test');
    expect(configPath()).toBe('/tmp/sc-test/ax.yaml');
    expect(dataDir()).toBe('/tmp/sc-test/data');
  });

  test('dataFile resolves under data dir', async () => {
    delete process.env.AX_HOME;
    const { dataFile } = await import('../src/paths.js');
    expect(dataFile('memory.db')).toBe(join(homedir(), '.ax', 'data', 'memory.db'));
    expect(dataFile('audit', 'audit.jsonl')).toBe(
      join(homedir(), '.ax', 'data', 'audit', 'audit.jsonl'),
    );
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/paths.test.ts`
Expected: FAIL (module not found)

**Step 3: Implement `src/paths.ts`**

```typescript
/**
 * Centralized path resolution for AX.
 *
 * All config and data files live under ~/.ax/ by default.
 * Override with AX_HOME env var (useful for tests).
 *
 * Layout:
 *   ~/.ax/
 *     ax.yaml     — main config
 *     .env              — API keys
 *     data/
 *       messages.db     — message queue
 *       conversations.db — conversation history
 *       memory.db       — SQLite memory provider
 *       memory/         — file memory provider
 *       audit.db        — SQLite audit provider
 *       audit/          — file audit provider
 *       credentials.enc — encrypted credentials
 */

import { join } from 'node:path';
import { homedir } from 'node:os';

/** Root directory for all AX files. */
export function axHome(): string {
  return process.env.AX_HOME || join(homedir(), '.ax');
}

/** Path to ax.yaml config file. */
export function configPath(): string {
  return join(axHome(), 'ax.yaml');
}

/** Path to .env file. */
export function envPath(): string {
  return join(axHome(), '.env');
}

/** Path to the data subdirectory. */
export function dataDir(): string {
  return join(axHome(), 'data');
}

/** Resolve a file path under the data directory. */
export function dataFile(...segments: string[]): string {
  return join(dataDir(), ...segments);
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/paths.test.ts`
Expected: All PASS

**Step 5: Update all consumers**

Update each file that hardcodes `data/` or config paths. The pattern is the same for each: import from `../paths.js` (or `../../paths.js` for providers) and replace the hardcoded string.

**`src/config.ts`** — Replace `DEFAULT_CONFIG_PATH`:

```typescript
// Before:
const DEFAULT_CONFIG_PATH = 'ax.yaml';
export function loadConfig(path?: string): Config {
  const configPath = resolve(path ?? DEFAULT_CONFIG_PATH);

// After:
import { configPath as defaultConfigPath } from './paths.js';
export function loadConfig(path?: string): Config {
  const configPath = resolve(path ?? defaultConfigPath());
```

Remove the `DEFAULT_CONFIG_PATH` constant.

**`src/host.ts`** — Replace `.env` path and `data/` mkdir:

```typescript
// Before:
const envPath = resolve('.env');
// ...
mkdirSync('data', { recursive: true });
const db = new MessageQueue('data/messages.db');
const conversations = new ConversationStore('data/conversations.db');

// After:
import { envPath as getEnvPath, dataDir, dataFile, axHome } from './paths.js';
// ...
const envPathResolved = getEnvPath();
// ...
mkdirSync(dataDir(), { recursive: true });
const db = new MessageQueue(dataFile('messages.db'));
const conversations = new ConversationStore(dataFile('conversations.db'));
```

Update `loadDotEnv()` to use the centralized path:

```typescript
function loadDotEnv(): void {
  const envPathResolved = getEnvPath();
  if (!existsSync(envPathResolved)) return;
  const lines = readFileSync(envPathResolved, 'utf-8').split('\n');
  // ... rest unchanged
}
```

**`src/db.ts`** — Replace default path arguments:

```typescript
// Before:
constructor(dbPath: string = 'data/conversations.db') {
// ...
constructor(dbPath: string = 'data/messages.db') {

// After:
import { dataFile } from './paths.js';
// ...
constructor(dbPath: string = dataFile('conversations.db')) {
// ...
constructor(dbPath: string = dataFile('messages.db')) {
```

**`src/providers/memory/file.ts`** — Replace `DEFAULT_BASE`:

```typescript
// Before:
const DEFAULT_BASE = 'data/memory';

// After:
import { dataFile } from '../../paths.js';
const DEFAULT_BASE = dataFile('memory');
```

**`src/providers/memory/sqlite.ts`** — Replace data path:

```typescript
// Before:
mkdirSync('data', { recursive: true });
const db: SQLiteDatabase = openDatabase('data/memory.db');

// After:
import { dataDir, dataFile } from '../../paths.js';
mkdirSync(dataDir(), { recursive: true });
const db: SQLiteDatabase = openDatabase(dataFile('memory.db'));
```

**`src/providers/audit/file.ts`** — Replace `DEFAULT_AUDIT_PATH`:

```typescript
// Before:
const DEFAULT_AUDIT_PATH = 'data/audit/audit.jsonl';

// After:
import { dataFile } from '../../paths.js';
const DEFAULT_AUDIT_PATH = dataFile('audit', 'audit.jsonl');
```

**`src/providers/audit/sqlite.ts`** — Replace data path:

```typescript
// Before:
mkdirSync('data', { recursive: true });
const db: SQLiteDatabase = openDatabase('data/audit.db');

// After:
import { dataDir, dataFile } from '../../paths.js';
mkdirSync(dataDir(), { recursive: true });
const db: SQLiteDatabase = openDatabase(dataFile('audit.db'));
```

**`src/providers/credentials/encrypted.ts`** — Replace `DEFAULT_STORE_PATH`:

```typescript
// Before:
const DEFAULT_STORE_PATH = 'data/credentials.enc';

// After:
import { dataFile } from '../../paths.js';
const DEFAULT_STORE_PATH = dataFile('credentials.enc');
```

**Step 6: Update existing tests to use AX_HOME**

Tests that rely on `data/` being in the working directory need `process.env.AX_HOME` set to a temp dir. The main tests that need this are integration tests and provider tests that use the default paths. Most provider tests already pass explicit paths, but check and update any that rely on `data/` being the working dir.

In test files that create/clean `data/` directories, set `AX_HOME` to a temp dir in `beforeEach`:

```typescript
beforeEach(() => {
  process.env.AX_HOME = join(tmpdir(), `sc-test-${randomUUID()}`);
  mkdirSync(process.env.AX_HOME, { recursive: true });
});

afterEach(() => {
  rmSync(process.env.AX_HOME!, { recursive: true, force: true });
  delete process.env.AX_HOME;
});
```

**Step 7: Run full test suite**

Run: `npm test`
Expected: All pass

Run: `bun test`
Expected: All pass

**Step 8: Commit**

```bash
git add src/paths.ts tests/paths.test.ts src/config.ts src/host.ts src/db.ts \
  src/providers/memory/file.ts src/providers/memory/sqlite.ts \
  src/providers/audit/file.ts src/providers/audit/sqlite.ts \
  src/providers/credentials/encrypted.ts
git commit -m "refactor: centralize all file paths under ~/.ax via src/paths.ts"
```

---

### Task 2: Install @inquirer/prompts + Profile Defaults

**Files:**
- Modify: `package.json` (add dependency)
- Create: `src/onboarding/prompts.ts`

**Step 1: Install @inquirer/prompts**

Run: `npm install @inquirer/prompts`
Expected: package.json updated, package-lock.json updated

**Step 2: Create `src/onboarding/prompts.ts`**

```typescript
/**
 * Profile-based provider defaults for onboarding.
 */

export interface ProfileDefaults {
  llm: string;
  memory: string;
  scanner: string;
  web: string;
  browser: string;
  credentials: string;
  skills: string;
  audit: string;
  sandbox: string;
  scheduler: string;
  skillScreener?: string;
  timeoutSec: number;
  memoryMb: number;
}

export const PROFILE_DEFAULTS: Record<string, ProfileDefaults> = {
  paranoid: {
    llm: 'anthropic',
    memory: 'file',
    scanner: 'patterns',
    web: 'none',
    browser: 'none',
    credentials: 'env',
    skills: 'readonly',
    audit: 'file',
    sandbox: 'seatbelt',
    scheduler: 'cron',
    timeoutSec: 60,
    memoryMb: 256,
  },
  standard: {
    llm: 'anthropic',
    memory: 'sqlite',
    scanner: 'patterns',
    web: 'fetch',
    browser: 'none',
    credentials: 'env',
    skills: 'git',
    audit: 'sqlite',
    sandbox: 'seatbelt',
    scheduler: 'full',
    skillScreener: 'static',
    timeoutSec: 120,
    memoryMb: 512,
  },
  yolo: {
    llm: 'anthropic',
    memory: 'sqlite',
    scanner: 'patterns',
    web: 'fetch',
    browser: 'container',
    credentials: 'encrypted',
    skills: 'git',
    audit: 'sqlite',
    sandbox: 'seatbelt',
    scheduler: 'full',
    skillScreener: 'static',
    timeoutSec: 300,
    memoryMb: 1024,
  },
};

export const PROFILE_NAMES = ['paranoid', 'standard', 'yolo'] as const;

export const PROFILE_DESCRIPTIONS: Record<string, string> = {
  paranoid: 'Maximum security, minimal features — no web, no browser, read-only skills',
  standard: 'Balanced security and features — web fetch, git skills, SQLite storage (recommended)',
  yolo: 'Maximum features — browser automation, encrypted credentials, extended timeouts',
};

/** Available provider choices per category, derived from the provider map. */
export const PROVIDER_CHOICES = {
  llm: ['anthropic'],
  memory: ['file', 'sqlite'],
  scanner: ['basic', 'patterns'],
  web: ['none', 'fetch'],
  browser: ['none', 'container'],
  credentials: ['env', 'encrypted'],
  skills: ['readonly', 'git'],
  audit: ['file', 'sqlite'],
  sandbox: ['subprocess', 'seatbelt', 'nsjail', 'docker'],
  scheduler: ['none', 'cron', 'full'],
  channels: ['cli', 'slack', 'whatsapp', 'telegram', 'discord'],
} as const;

export const ASCII_CRAB = `
   🦀  Welcome to AX!

   The security-first personal AI agent.
   Let's get you set up.
`;

export const RECONFIGURE_HEADER = `
   🦀  AX Configuration

   Updating your existing configuration.
   Current values are pre-selected.
`;
```

This file has no tests — it's pure data. It will be tested transitively through the wizard tests.

**Step 3: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: 0 errors

**Step 4: Commit**

```bash
git add src/onboarding/prompts.ts package.json package-lock.json
git commit -m "feat: add @inquirer/prompts dependency and onboarding profile defaults"
```

---

### Task 3: Onboarding Wizard Core (Config Generator) + Tests

**Files:**
- Create: `src/onboarding/wizard.ts`
- Create: `tests/onboarding/wizard.test.ts`

**Step 1: Write failing tests in `tests/onboarding/wizard.test.ts`**

```typescript
import { describe, test, expect, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { runOnboarding } from '../../src/onboarding/wizard.js';
import { parse as parseYaml } from 'yaml';

describe('Onboarding Wizard', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  function setup(): string {
    tmpDir = join(tmpdir(), `onboard-${randomUUID()}`);
    mkdirSync(tmpDir, { recursive: true });
    return tmpDir;
  }

  // ── Profile → config generation ──

  test('generates valid ax.yaml for paranoid profile', async () => {
    const dir = setup();
    await runOnboarding({
      outputDir: dir,
      answers: {
        profile: 'paranoid',
        apiKey: 'sk-test-key-12345',
        channels: ['cli'],
        skipSkills: true,
      },
    });

    const configPath = join(dir, 'ax.yaml');
    expect(existsSync(configPath)).toBe(true);

    const config = parseYaml(readFileSync(configPath, 'utf-8'));
    expect(config.profile).toBe('paranoid');
    expect(config.providers.llm).toBe('anthropic');
    expect(config.providers.scanner).toBe('patterns');
    expect(config.providers.web).toBe('none');
    expect(config.providers.skills).toBe('readonly');
    expect(config.providers.channels).toEqual(['cli']);
  });

  test('generates valid ax.yaml for standard profile', async () => {
    const dir = setup();
    await runOnboarding({
      outputDir: dir,
      answers: {
        profile: 'standard',
        apiKey: 'sk-test-key-12345',
        channels: ['cli'],
        skipSkills: true,
      },
    });

    const config = parseYaml(readFileSync(join(dir, 'ax.yaml'), 'utf-8'));
    expect(config.profile).toBe('standard');
    expect(config.providers.web).toBe('fetch');
    expect(config.providers.skills).toBe('git');
    expect(config.providers.memory).toBe('sqlite');
  });

  test('generates valid ax.yaml for yolo profile', async () => {
    const dir = setup();
    await runOnboarding({
      outputDir: dir,
      answers: {
        profile: 'yolo',
        apiKey: 'sk-test-key-12345',
        channels: ['cli'],
        skipSkills: true,
      },
    });

    const config = parseYaml(readFileSync(join(dir, 'ax.yaml'), 'utf-8'));
    expect(config.profile).toBe('yolo');
    expect(config.providers.skills).toBe('git');
    expect(config.providers.browser).toBe('container');
    expect(config.providers.credentials).toBe('encrypted');
  });

  // ── API key handling ──

  test('saves API key to .env file', async () => {
    const dir = setup();
    await runOnboarding({
      outputDir: dir,
      answers: {
        profile: 'standard',
        apiKey: 'sk-ant-api-key-here',
        channels: ['cli'],
        skipSkills: true,
      },
    });

    const envPath = join(dir, '.env');
    expect(existsSync(envPath)).toBe(true);
    const envContent = readFileSync(envPath, 'utf-8');
    expect(envContent).toContain('ANTHROPIC_API_KEY=sk-ant-api-key-here');
  });

  // ── YAML validity ──

  test('generated config has valid structure', async () => {
    const dir = setup();
    await runOnboarding({
      outputDir: dir,
      answers: {
        profile: 'standard',
        apiKey: 'sk-test',
        channels: ['cli'],
        skipSkills: true,
      },
    });

    const raw = readFileSync(join(dir, 'ax.yaml'), 'utf-8');
    const parsed = parseYaml(raw);
    expect(parsed.sandbox.timeout_sec).toBeGreaterThan(0);
    expect(parsed.sandbox.memory_mb).toBeGreaterThan(0);
    expect(parsed.scheduler.active_hours.start).toMatch(/^\d{2}:\d{2}$/);
    expect(parsed.scheduler.active_hours.end).toMatch(/^\d{2}:\d{2}$/);
    expect(parsed.scheduler.max_token_budget).toBeGreaterThan(0);
    expect(parsed.scheduler.heartbeat_interval_min).toBeGreaterThan(0);
  });

  // ── Multiple channels ──

  test('supports multiple channels', async () => {
    const dir = setup();
    await runOnboarding({
      outputDir: dir,
      answers: {
        profile: 'standard',
        apiKey: 'sk-test',
        channels: ['cli', 'slack'],
        skipSkills: true,
      },
    });

    const config = parseYaml(readFileSync(join(dir, 'ax.yaml'), 'utf-8'));
    expect(config.providers.channels).toEqual(['cli', 'slack']);
  });

  // ── skillScreener only on profiles that support it ──

  test('paranoid profile omits skillScreener', async () => {
    const dir = setup();
    await runOnboarding({
      outputDir: dir,
      answers: { profile: 'paranoid', apiKey: 'sk-test', channels: ['cli'], skipSkills: true },
    });

    const config = parseYaml(readFileSync(join(dir, 'ax.yaml'), 'utf-8'));
    expect(config.providers.skillScreener).toBeUndefined();
  });

  test('standard profile includes skillScreener', async () => {
    const dir = setup();
    await runOnboarding({
      outputDir: dir,
      answers: { profile: 'standard', apiKey: 'sk-test', channels: ['cli'], skipSkills: true },
    });

    const config = parseYaml(readFileSync(join(dir, 'ax.yaml'), 'utf-8'));
    expect(config.providers.skillScreener).toBe('static');
  });

  // ── Invalid profile ──

  test('throws on unknown profile', async () => {
    const dir = setup();
    await expect(
      runOnboarding({
        outputDir: dir,
        answers: { profile: 'yolo' as any, apiKey: 'sk-test', channels: ['cli'], skipSkills: true },
      }),
    ).rejects.toThrow('Unknown profile');
  });

  // ── Skill install queue ──

  test('writes .clawhub-install-queue when skills requested', async () => {
    const dir = setup();
    await runOnboarding({
      outputDir: dir,
      answers: {
        profile: 'standard',
        apiKey: 'sk-test',
        channels: ['cli'],
        skipSkills: false,
        installSkills: ['daily-standup', 'code-review'],
      },
    });

    const queuePath = join(dir, '.clawhub-install-queue');
    expect(existsSync(queuePath)).toBe(true);
    const content = readFileSync(queuePath, 'utf-8');
    expect(content).toContain('daily-standup');
    expect(content).toContain('code-review');
  });

  test('skips .clawhub-install-queue when skipSkills is true', async () => {
    const dir = setup();
    await runOnboarding({
      outputDir: dir,
      answers: {
        profile: 'standard',
        apiKey: 'sk-test',
        channels: ['cli'],
        skipSkills: true,
        installSkills: ['daily-standup'],
      },
    });

    expect(existsSync(join(dir, '.clawhub-install-queue'))).toBe(false);
  });

  // ── Reconfigure: loads existing config as defaults ──

  test('loadExistingConfig reads ax.yaml into OnboardingAnswers', async () => {
    const { loadExistingConfig } = await import('../../src/onboarding/wizard.js');
    const dir = setup();

    // Generate a config first
    await runOnboarding({
      outputDir: dir,
      answers: {
        profile: 'yolo',
        apiKey: 'sk-existing-key',
        channels: ['cli', 'slack'],
        skipSkills: true,
      },
    });

    const existing = loadExistingConfig(dir);
    expect(existing).not.toBeNull();
    expect(existing!.profile).toBe('yolo');
    expect(existing!.channels).toEqual(['cli', 'slack']);
  });

  test('loadExistingConfig returns null when no config exists', async () => {
    const { loadExistingConfig } = await import('../../src/onboarding/wizard.js');
    const dir = setup();

    const existing = loadExistingConfig(dir);
    expect(existing).toBeNull();
  });

  test('loadExistingConfig reads API key from .env', async () => {
    const { loadExistingConfig } = await import('../../src/onboarding/wizard.js');
    const dir = setup();

    await runOnboarding({
      outputDir: dir,
      answers: {
        profile: 'standard',
        apiKey: 'sk-my-saved-key',
        channels: ['cli'],
        skipSkills: true,
      },
    });

    const existing = loadExistingConfig(dir);
    expect(existing!.apiKey).toBe('sk-my-saved-key');
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/onboarding/wizard.test.ts`
Expected: FAIL (module not found)

**Step 3: Implement `src/onboarding/wizard.ts`**

```typescript
/**
 * Onboarding wizard — generates ax.yaml from answers.
 *
 * Two modes:
 * - Programmatic: call runOnboarding() with OnboardingOptions (for tests and automation)
 * - Interactive: call runConfigure() for terminal-based setup via @inquirer/prompts
 *
 * Supports reconfiguration: loadExistingConfig() reads the current config
 * so the interactive UI can pre-fill answers.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml, stringify as yamlStringify } from 'yaml';
import { PROFILE_DEFAULTS } from './prompts.js';

export interface OnboardingAnswers {
  profile: 'paranoid' | 'standard' | 'yolo';
  apiKey: string;
  channels: string[];
  skipSkills?: boolean;
  installSkills?: string[];
}

export interface OnboardingOptions {
  outputDir: string;
  answers: OnboardingAnswers;
}

export async function runOnboarding(opts: OnboardingOptions): Promise<void> {
  const { outputDir, answers } = opts;
  const defaults = PROFILE_DEFAULTS[answers.profile];

  if (!defaults) {
    throw new Error(`Unknown profile: "${answers.profile}"`);
  }

  // Ensure output directory exists
  mkdirSync(outputDir, { recursive: true });

  // Build providers object — only include skillScreener if the profile defines one
  const providers: Record<string, unknown> = {
    llm: defaults.llm,
    memory: defaults.memory,
    scanner: defaults.scanner,
    channels: answers.channels,
    web: defaults.web,
    browser: defaults.browser,
    credentials: defaults.credentials,
    skills: defaults.skills,
    audit: defaults.audit,
    sandbox: defaults.sandbox,
    scheduler: defaults.scheduler,
  };

  if (defaults.skillScreener) {
    providers.skillScreener = defaults.skillScreener;
  }

  // Build full config
  const config: Record<string, unknown> = {
    profile: answers.profile,
    providers,
    sandbox: {
      timeout_sec: defaults.timeoutSec,
      memory_mb: defaults.memoryMb,
    },
    scheduler: {
      active_hours: {
        start: '07:00',
        end: '23:00',
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      },
      max_token_budget: 4096,
      heartbeat_interval_min: 30,
    },
  };

  // Write ax.yaml
  const yamlContent = yamlStringify(config, { indent: 2, lineWidth: 120 });
  writeFileSync(join(outputDir, 'ax.yaml'), yamlContent, 'utf-8');

  // Write .env with API key
  const envContent = `# AX API Keys\nANTHROPIC_API_KEY=${answers.apiKey}\n`;
  writeFileSync(join(outputDir, '.env'), envContent, 'utf-8');

  // Write ClawHub skill install queue if requested
  if (answers.installSkills && answers.installSkills.length > 0 && !answers.skipSkills) {
    const skillListContent = answers.installSkills.join('\n');
    writeFileSync(join(outputDir, '.clawhub-install-queue'), skillListContent, 'utf-8');
  }
}

/**
 * Load existing config from a directory, returning OnboardingAnswers
 * or null if no config exists. Used by the interactive configure UI
 * to pre-fill default selections.
 */
export function loadExistingConfig(dir: string): OnboardingAnswers | null {
  const cfgPath = join(dir, 'ax.yaml');
  if (!existsSync(cfgPath)) return null;

  try {
    const raw = readFileSync(cfgPath, 'utf-8');
    const parsed = parseYaml(raw);

    // Read API key from .env if it exists
    let apiKey = '';
    const envFilePath = join(dir, '.env');
    if (existsSync(envFilePath)) {
      const envContent = readFileSync(envFilePath, 'utf-8');
      const match = envContent.match(/^ANTHROPIC_API_KEY=(.+)$/m);
      if (match) apiKey = match[1].trim();
    }

    return {
      profile: parsed.profile ?? 'standard',
      apiKey,
      channels: parsed.providers?.channels ?? ['cli'],
      skipSkills: true,
    };
  } catch {
    return null;
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/onboarding/wizard.test.ts`
Expected: All PASS

**Step 5: Run full test suite on both runtimes**

Run: `npm test`
Expected: All pass

Run: `bun test`
Expected: All pass

**Step 6: Commit**

```bash
git add src/onboarding/wizard.ts tests/onboarding/wizard.test.ts
git commit -m "feat: implement onboarding wizard with profile-based config generation"
```

---

### Task 4: Interactive Configure UI + Tests

**Files:**
- Create: `src/onboarding/configure.ts`
- Create: `tests/onboarding/configure.test.ts`

**Step 1: Write failing tests in `tests/onboarding/configure.test.ts`**

The interactive UI can't be tested end-to-end (it requires a TTY), but we can test the helper functions and the `buildInquirerDefaults()` logic.

```typescript
import { describe, test, expect, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { buildInquirerDefaults } from '../../src/onboarding/configure.js';
import { runOnboarding, loadExistingConfig } from '../../src/onboarding/wizard.js';

describe('Configure UI Helpers', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  function setup(): string {
    tmpDir = join(tmpdir(), `configure-${randomUUID()}`);
    mkdirSync(tmpDir, { recursive: true });
    return tmpDir;
  }

  test('buildInquirerDefaults returns undefined values when no existing config', () => {
    const defaults = buildInquirerDefaults(null);
    expect(defaults.profile).toBeUndefined();
    expect(defaults.apiKey).toBeUndefined();
    expect(defaults.channels).toBeUndefined();
  });

  test('buildInquirerDefaults maps existing config to inquirer defaults', async () => {
    const dir = setup();
    await runOnboarding({
      outputDir: dir,
      answers: {
        profile: 'yolo',
        apiKey: 'sk-existing',
        channels: ['cli', 'slack'],
        skipSkills: true,
      },
    });

    const existing = loadExistingConfig(dir);
    const defaults = buildInquirerDefaults(existing);

    expect(defaults.profile).toBe('yolo');
    expect(defaults.apiKey).toBe('sk-existing');
    expect(defaults.channels).toEqual(['cli', 'slack']);
  });

  test('buildInquirerDefaults masks API key for display', async () => {
    const dir = setup();
    await runOnboarding({
      outputDir: dir,
      answers: {
        profile: 'standard',
        apiKey: 'sk-ant-api03-longkeyvalue12345',
        channels: ['cli'],
        skipSkills: true,
      },
    });

    const existing = loadExistingConfig(dir);
    const defaults = buildInquirerDefaults(existing);

    // apiKey is the full value (for pre-filling the input),
    // but apiKeyMasked is a display hint
    expect(defaults.apiKey).toBe('sk-ant-api03-longkeyvalue12345');
    expect(defaults.apiKeyMasked).toMatch(/^sk-\.\.\..+$/);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/onboarding/configure.test.ts`
Expected: FAIL (module not found)

**Step 3: Implement `src/onboarding/configure.ts`**

```typescript
/**
 * Interactive configure UI using @inquirer/prompts.
 *
 * Launched by `ax configure` or auto-triggered on first run.
 * When reconfiguring, pre-fills answers from existing ax.yaml.
 */

import { select, input, checkbox, password, confirm } from '@inquirer/prompts';
import {
  PROFILE_NAMES,
  PROFILE_DESCRIPTIONS,
  PROVIDER_CHOICES,
  ASCII_CRAB,
  RECONFIGURE_HEADER,
} from './prompts.js';
import { runOnboarding, loadExistingConfig } from './wizard.js';
import type { OnboardingAnswers } from './wizard.js';

export interface InquirerDefaults {
  profile?: string;
  apiKey?: string;
  apiKeyMasked?: string;
  channels?: string[];
}

/**
 * Build default values for inquirer prompts from existing config.
 * Returns an object with undefined values if no existing config.
 */
export function buildInquirerDefaults(existing: OnboardingAnswers | null): InquirerDefaults {
  if (!existing) {
    return { profile: undefined, apiKey: undefined, apiKeyMasked: undefined, channels: undefined };
  }

  // Mask API key for display: show first 3 chars + last 4 chars
  let apiKeyMasked: string | undefined;
  if (existing.apiKey && existing.apiKey.length > 8) {
    apiKeyMasked = `${existing.apiKey.slice(0, 3)}...${existing.apiKey.slice(-4)}`;
  }

  return {
    profile: existing.profile,
    apiKey: existing.apiKey,
    apiKeyMasked,
    channels: existing.channels,
  };
}

/**
 * Run the interactive configure flow.
 *
 * @param outputDir - Directory to write config files to (defaults to axHome())
 */
export async function runConfigure(outputDir: string): Promise<void> {
  const existing = loadExistingConfig(outputDir);
  const isReconfigure = existing !== null;
  const defaults = buildInquirerDefaults(existing);

  console.log(isReconfigure ? RECONFIGURE_HEADER : ASCII_CRAB);

  // 1. Profile selection
  const profile = await select({
    message: 'Security profile',
    choices: PROFILE_NAMES.map((name) => ({
      name: `${name}  —  ${PROFILE_DESCRIPTIONS[name]}`,
      value: name,
    })),
    default: defaults.profile,
  }) as OnboardingAnswers['profile'];

  // 2. API key
  const apiKeyMessage = defaults.apiKeyMasked
    ? `Anthropic API key (current: ${defaults.apiKeyMasked})`
    : 'Anthropic API key';

  const apiKeyInput = await password({
    message: apiKeyMessage,
    mask: '*',
  });

  // If user pressed Enter without typing, keep existing key
  const apiKey = apiKeyInput.trim() || defaults.apiKey || '';

  if (!apiKey) {
    console.log('\nWarning: No API key provided. You can set it later in ~/.ax/.env\n');
  }

  // 3. Channel selection
  const channels = await checkbox({
    message: 'Communication channels',
    choices: PROVIDER_CHOICES.channels.map((ch) => ({
      name: ch,
      value: ch,
      checked: defaults.channels ? defaults.channels.includes(ch) : ch === 'cli',
    })),
  });

  // Ensure at least 'cli' is selected
  if (channels.length === 0) {
    channels.push('cli');
  }

  // 4. Skill installation
  const skipSkills = !(await confirm({
    message: 'Install ClawHub skills?',
    default: false,
  }));

  let installSkills: string[] = [];
  if (!skipSkills) {
    const skillsInput = await input({
      message: 'Skill names (comma-separated)',
      default: '',
    });
    installSkills = skillsInput
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  // 5. Generate config
  await runOnboarding({
    outputDir,
    answers: { profile, apiKey, channels, skipSkills, installSkills },
  });

  console.log(`\n  Config written to ${outputDir}/ax.yaml`);
  console.log(`  API key written to ${outputDir}/.env`);

  if (!skipSkills && installSkills.length > 0) {
    console.log(`  Skill install queue: ${installSkills.join(', ')}`);
  }

  console.log('');
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/onboarding/configure.test.ts`
Expected: All PASS

**Step 5: Run full test suite on both runtimes**

Run: `npm test`
Expected: All pass

Run: `bun test`
Expected: All pass

**Step 6: Commit**

```bash
git add src/onboarding/configure.ts tests/onboarding/configure.test.ts
git commit -m "feat: interactive configure UI with @inquirer/prompts and reconfigure support"
```

---

### Task 5: Config Schema Updates for Onboarding

The generated `ax.yaml` may include optional fields (`skillScreener`) that the current `ConfigSchema` in `src/config.ts` doesn't accept. This task makes the config schema forward-compatible.

**Files:**
- Modify: `src/config.ts:7-35`
- Modify: `src/providers/types.ts:315-345`
- Modify: `src/registry.ts`
- Modify: `tests/config.test.ts`

**Step 1: Write failing test in `tests/config.test.ts`**

Add to the existing describe block:

```typescript
  test('accepts config with optional skillScreener', async () => {
    const { writeFileSync, rmSync } = await import('node:fs');
    const tmpPath = resolve(import.meta.dirname, '../ax-test-screener.yaml');
    writeFileSync(tmpPath, `
profile: standard
providers:
  llm: anthropic
  memory: file
  scanner: basic
  channels: [cli]
  web: none
  browser: none
  credentials: env
  skills: readonly
  audit: file
  sandbox: subprocess
  scheduler: none
  skillScreener: static
sandbox:
  timeout_sec: 120
  memory_mb: 512
scheduler:
  active_hours: { start: "07:00", end: "23:00", timezone: "UTC" }
  max_token_budget: 4096
  heartbeat_interval_min: 30
`);
    try {
      const config = loadConfig(tmpPath);
      expect(config.providers.skillScreener).toBe('static');
    } finally {
      rmSync(tmpPath);
    }
  });
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL (Zod strict schema rejects `skillScreener`)

**Step 3: Add optional field to Config type in `src/providers/types.ts`**

In the `Config.providers` object (after `scheduler: string;` at line 328), add:

```typescript
    skillScreener?: string;
```

In the `ProviderRegistry` interface (after `scheduler: SchedulerProvider;`), add:

```typescript
  skillScreener?: SkillScreenerProvider;
```

Add the minimal interface (if not already defined):

```typescript
export interface ScreeningVerdict {
  allowed: boolean;
  reasons: string[];
}

export interface SkillScreenerProvider {
  screen(content: string, declaredPermissions?: string[]): Promise<ScreeningVerdict>;
}
```

**Step 4: Update ConfigSchema in `src/config.ts`**

In the `providers` strictObject, add after `scheduler`:

```typescript
    skillScreener: z.string().optional(),
```

**Step 5: Update `src/registry.ts` for optional skillScreener loading**

After loading scheduler, add:

```typescript
    skillScreener: config.providers.skillScreener
      ? await loadProvider('screener', config.providers.skillScreener, config)
      : undefined,
```

**Step 6: Run tests**

Run: `npm test`
Expected: All pass

Run: `bun test`
Expected: All pass

**Step 7: Commit**

```bash
git add src/config.ts src/providers/types.ts src/registry.ts tests/config.test.ts
git commit -m "feat: config schema accepts optional skillScreener"
```

---

### Task 6: CLI `configure` Subcommand + First-Run Detection

**Files:**
- Modify: `src/host.ts:42-66`
- Modify: `package.json`

**Step 1: Update CLI arg parsing in `src/host.ts`**

Replace the current `parseHostArgs()` function (lines 43-54) with:

```typescript
function parseHostArgs(): { configPath?: string; command?: string } {
  const args = process.argv.slice(2);
  let configPath: string | undefined;
  let command: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--config' || args[i] === '-c') {
      configPath = args[++i];
    } else if (!args[i].startsWith('-') && !command) {
      command = args[i];
    }
  }

  return { configPath, command };
}
```

**Step 2: Add configure command + first-run detection to `main()`**

At the top of `main()`, after parsing CLI args but before loading config, add:

```typescript
  const { configPath, command } = parseHostArgs();

  // Handle `ax configure` command
  if (command === 'configure') {
    const { runConfigure } = await import('./onboarding/configure.js');
    await runConfigure(axHome());
    return;
  }

  // First-run detection: if no config file exists, run configure
  const configFile = configPath ?? configPathDefault();
  if (!existsSync(configFile)) {
    console.log('[host] No ax.yaml found — running first-time setup...\n');
    const { runConfigure } = await import('./onboarding/configure.js');
    await runConfigure(axHome());
    console.log('[host] Setup complete! Starting AX...\n');
  }
```

Where `configPathDefault` and `axHome` are imported from `./paths.js` (already done in Task 1).

Remove the old `const { configPath } = parseHostArgs();` line since we now destructure both values.

**Step 3: Add `configure` script to `package.json`**

In the `scripts` section, add:

```json
"configure": "NODE_NO_WARNINGS=1 tsx src/host.ts configure"
```

**Step 4: Run tests**

Run: `npm test`
Expected: All pass

Run: `bun test`
Expected: All pass

**Step 5: Commit**

```bash
git add src/host.ts package.json
git commit -m "feat: add 'configure' CLI subcommand with first-run detection"
```

---

## Verification Checklist

- [ ] `npx tsc --noEmit` — zero errors
- [ ] `npm test` — all tests pass (Node.js / vitest)
- [ ] `bun test` — all tests pass (Bun)
- [ ] All data files resolve under `~/.ax/data/`
- [ ] Config file resolves to `~/.ax/ax.yaml`
- [ ] `.env` resolves to `~/.ax/.env`
- [ ] `AX_HOME` env var overrides the default path
- [ ] `runOnboarding()` generates valid YAML for all 3 profiles
- [ ] Generated YAML passes `loadConfig()` validation (after Task 5)
- [ ] `.env` file contains API key
- [ ] `paranoid` profile omits `skillScreener`
- [ ] `standard` and `yolo` profiles include `skillScreener: static`
- [ ] `.clawhub-install-queue` written when skills requested, skipped when `skipSkills: true`
- [ ] `loadExistingConfig()` reads profile, channels, and API key from existing config
- [ ] `buildInquirerDefaults()` returns undefined values when no existing config
- [ ] `buildInquirerDefaults()` maps existing config to pre-fill values
- [ ] `npm run configure` launches interactive wizard
- [ ] `npm start` without `ax.yaml` triggers configure flow
- [ ] `npm run configure` with existing config shows current values as defaults
