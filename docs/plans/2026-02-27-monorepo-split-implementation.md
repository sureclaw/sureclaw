# Phase 2 Implementation: Monorepo Split

**Date:** 2026-02-27
**Status:** Draft
**Depends on:** [Plugin Framework Design](./2026-02-26-plugin-framework-design.md) (Approved)

## Goal

Extract all non-core providers from `src/providers/` into scoped `@ax/provider-*`
packages under a pnpm workspace. `@ax/core` shrinks to ~3K LOC with noop/mock
implementations. An `ax` meta-package bundles the standard set.

**Current state:** 5,840 LOC across 13 provider categories, 36 implementations.
Everything in one package, one `tsconfig.json`, one `package.json`.

**Target state:** ~35 packages in a pnpm monorepo. `@ax/core` contains host, agent,
IPC, registry, and one noop/mock provider per category. Everything else is a separate
`@ax/provider-{kind}-{name}` package.

## Pre-Implementation Analysis

### What stays in `@ax/core`

These files remain in the core package. They're the trusted host/agent infrastructure:

```
src/
├── main.ts, config.ts, types.ts, paths.ts, logger.ts, errors.ts
├── db.ts, dotenv.ts, ipc-schemas.ts, conversation-store.ts
├── file-store.ts, job-store.ts, session-store.ts
├── host/          (server, router, ipc-server, registry, provider-map, proxy, etc.)
├── agent/         (runner, ipc-client, ipc-transport, local-tools, runners/)
├── cli/           (chat, send, serve, configure, bootstrap)
├── onboarding/    (first-run wizard, profiles)
├── utils/         (safe-path, sqlite, database, migrator, retry, circuit-breaker, etc.)
├── migrations/    (all migration files — used by core stores + sqlite providers)
├── provider-sdk/  (already exists from Phase 1)
└── providers/     (ONLY the core noop/mock stubs — see Decision #4)
```

### Core providers (stay inline in `@ax/core`)

Per the resolved Decision #4, these implementations stay in core:

| Category | Provider | File | Lines | Why |
|----------|----------|------|-------|-----|
| llm | `mock` | mock.ts | 32 | Zero deps, reference impl |
| image | `mock` | mock.ts | 28 | Zero deps, reference impl |
| memory | `file` | file.ts | 120 | Uses only node:fs + safePath |
| scanner | `basic` | basic.ts | 79 | Uses only node:crypto |
| web | `none` | none.ts | 7 | disabledProvider stub |
| browser | `none` | none.ts | 7 | disabledProvider stub |
| credentials | `env` | env.ts | 22 | Just process.env |
| skills | `readonly` | readonly.ts | 51 | node:fs + safePath |
| audit | `file` | file.ts | 60 | node:fs append |
| sandbox | `subprocess` | subprocess.ts | 44 | node:child_process only |
| scheduler | `none` | none.ts | 9 | Empty stub |
| screener | `static` | static.ts | 200 | No external deps |
| screener | `none` | none.ts | 24 | Empty stub |

**Total core providers: ~683 LOC** — well within the ~3K budget.

### What gets extracted

Every other implementation becomes its own package. Here's the full extraction manifest:

#### LLM providers
| Package | Source file | Lines | External deps |
|---------|-----------|-------|---------------|
| `@ax/provider-llm-anthropic` | llm/anthropic.ts | 202 | @anthropic-ai/sdk |
| `@ax/provider-llm-openai` | llm/openai.ts | 279 | openai |
| `@ax/provider-llm-router` | llm/router.ts | 225 | (none — uses provider-map) |
| `@ax/provider-llm-traced` | llm/traced.ts | 91 | @opentelemetry/api |

#### Image providers
| Package | Source file | Lines | External deps |
|---------|-----------|-------|---------------|
| `@ax/provider-image-openai` | image/openai-images.ts | 118 | (uses fetch) |
| `@ax/provider-image-openrouter` | image/openrouter.ts | 109 | (uses fetch) |
| `@ax/provider-image-gemini` | image/gemini.ts | 120 | (uses fetch) |
| `@ax/provider-image-router` | image/router.ts | 143 | (none — uses provider-map) |

#### Memory providers
| Package | Source file | Lines | External deps |
|---------|-----------|-------|---------------|
| `@ax/provider-memory-sqlite` | memory/sqlite.ts | 134 | better-sqlite3, kysely |
| `@ax/provider-memory-memu` | memory/memu.ts | 196 | (internal) |

#### Scanner providers
| Package | Source file | Lines | External deps |
|---------|-----------|-------|---------------|
| `@ax/provider-scanner-patterns` | scanner/patterns.ts | 145 | (none) |
| `@ax/provider-scanner-promptfoo` | scanner/promptfoo.ts | 270 | (uses fetch) |

#### Channel providers
| Package | Source file | Lines | External deps |
|---------|-----------|-------|---------------|
| `@ax/provider-channel-slack` | channel/slack.ts | 438 | @slack/bolt |

Note: whatsapp, telegram, discord are in the provider-map but don't have
implementations yet. Remove from provider-map until implemented.

#### Web providers
| Package | Source file | Lines | External deps |
|---------|-----------|-------|---------------|
| `@ax/provider-web-fetch` | web/fetch.ts | 159 | (node:dns/promises) |
| `@ax/provider-web-tavily` | web/tavily.ts | 79 | @tavily/core |

#### Browser providers
| Package | Source file | Lines | External deps |
|---------|-----------|-------|---------------|
| `@ax/provider-browser-container` | browser/container.ts | 189 | (node:child_process) |

#### Credential providers
| Package | Source file | Lines | External deps |
|---------|-----------|-------|---------------|
| `@ax/provider-credentials-encrypted` | credentials/encrypted.ts | 115 | (node:crypto) |
| `@ax/provider-credentials-keychain` | credentials/keychain.ts | 64 | (native keychain) |

#### Skills providers
| Package | Source file | Lines | External deps |
|---------|-----------|-------|---------------|
| `@ax/provider-skills-git` | skills/git.ts | 387 | isomorphic-git |

#### Audit providers
| Package | Source file | Lines | External deps |
|---------|-----------|-------|---------------|
| `@ax/provider-audit-sqlite` | audit/sqlite.ts | 97 | better-sqlite3, kysely |

#### Sandbox providers
| Package | Source file | Lines | External deps |
|---------|-----------|-------|---------------|
| `@ax/provider-sandbox-seatbelt` | sandbox/seatbelt.ts | 64 | (none) |
| `@ax/provider-sandbox-nsjail` | sandbox/nsjail.ts | 100 | (none) |
| `@ax/provider-sandbox-bwrap` | sandbox/bwrap.ts | 122 | (none) |
| `@ax/provider-sandbox-docker` | sandbox/docker.ts | 135 | (none) |

Note: sandbox/utils.ts (75 LOC) is shared by seatbelt, nsjail, subprocess.
Extract into `@ax/provider-sandbox-utils` internal package, or inline into each.

#### Scheduler providers
| Package | Source file | Lines | External deps |
|---------|-----------|-------|---------------|
| `@ax/provider-scheduler-cron` | scheduler/cron.ts | 170 | (none) |
| `@ax/provider-scheduler-full` | scheduler/full.ts | 300 | (none) |

Note: scheduler/utils.ts (82 LOC) shared by cron and full. Same treatment as
sandbox/utils — extract to internal shared package or inline.

**Total extracted packages: 27 provider packages + `@ax/core` + `@ax/provider-sdk` + `ax` meta = ~30 packages.**

### Cross-provider dependencies (must resolve before extraction)

These are the imports that cross category boundaries:

1. **`image/router.ts` → `llm/router.ts`** (`parseCompoundId` utility)
   - **Fix:** Extract `parseCompoundId` into `@ax/core` utils (it's a pure function,
     ~15 LOC). Both routers import from core.

2. **`scheduler/full.ts` → `channel/types`, `memory/types`, `audit/types`**
   - **Fix:** These are all **type-only imports**. The types already live in
     `@ax/provider-sdk/interfaces`. Change imports to use the SDK package.

3. **`scheduler/cron.ts` → `channel/types`**
   - **Fix:** Same as above — type-only, use SDK.

4. **`scheduler/types.ts` → `channel/types`, `memory/types`**
   - **Fix:** These are the type definition files. Move cross-category shared types
     (SessionAddress, InboundMessage, ProactiveHint) into the SDK interfaces.
     They're already re-exported from there.

5. **`screener/static.ts`, `screener/none.ts` → `skills/types`**
   - **Fix:** SkillScreenerProvider is already in SDK interfaces. Import from SDK.

6. **`sandbox/{seatbelt,nsjail,subprocess}.ts` → `sandbox/utils.ts`**
   - **Fix:** Within-category. Package `@ax/provider-sandbox-*` packages can depend
     on a shared `@ax/sandbox-utils` internal package, or we inline the 75 LOC.
     Recommend: inline, it's small enough.

7. **`scheduler/{cron,full}.ts` → `scheduler/utils.ts`**
   - **Fix:** Same pattern. Inline the 82 LOC into each scheduler package or create
     internal `@ax/scheduler-utils`. Recommend: inline.

### Provider imports from core utilities

Every extracted provider needs to import some core utilities. These become
`peerDependencies` on `@ax/core`:

| Utility | Used by | Import pattern |
|---------|---------|---------------|
| `Config`, `TaintTag` (types.ts) | All providers | `@ax/provider-sdk` (already re-exports) |
| `getLogger()` (logger.ts) | anthropic, openai, routers, slack, gemini, subprocess | `@ax/core/logger` |
| `dataFile()`, `dataDir()` (paths.ts) | file-based providers | `@ax/core/paths` |
| `safePath()` (utils/safe-path.ts) | memory/file, skills/* | `@ax/provider-sdk` (already re-exports) |
| `openDatabase()` (utils/sqlite.ts) | memory/sqlite, audit/sqlite | `@ax/core/utils/sqlite` |
| `createKyselyDb()` (utils/database.ts) | memory/sqlite, audit/sqlite | `@ax/core/utils/database` |
| `runMigrations()` (utils/migrator.ts) | memory/sqlite, audit/sqlite | `@ax/core/utils/migrator` |
| `disabledProvider()` (utils/disabled-provider.ts) | web/none, browser/none | Stays in core |
| `resolveProviderPath()` (host/provider-map.ts) | llm/router, image/router | `@ax/core/host/provider-map` |
| `agentSkillsDir()` (paths.ts) | skills/git, skills/readonly | `@ax/core/paths` |
| Migration definitions | memory/sqlite, audit/sqlite | `@ax/core/migrations/*` |

### Package exports strategy

`@ax/core` needs `exports` in package.json so providers can import specific subpaths:

```json
{
  "exports": {
    ".": "./dist/main.js",
    "./types": "./dist/types.js",
    "./logger": "./dist/logger.js",
    "./paths": "./dist/paths.js",
    "./utils/sqlite": "./dist/utils/sqlite.js",
    "./utils/database": "./dist/utils/database.js",
    "./utils/migrator": "./dist/utils/migrator.js",
    "./utils/safe-path": "./dist/utils/safe-path.js",
    "./host/provider-map": "./dist/host/provider-map.js",
    "./migrations/*": "./dist/migrations/*.js"
  }
}
```

## Implementation Steps

### Step 0: Preparation (non-breaking)

1. **Switch to pnpm.** Install pnpm, generate `pnpm-lock.yaml` from existing
   `package-lock.json`, add `pnpm-workspace.yaml`:
   ```yaml
   packages:
     - 'packages/*'
   ```
   Verify `pnpm install` and `pnpm test` pass identically.

2. **Create `packages/` directory** for extracted packages.

3. **Clean up provider-map.ts.** Remove entries for unimplemented providers
   (whatsapp, telegram, discord) that have no source files.

### Step 1: Create `@ax/core` package structure

1. Move the root `package.json` to `packages/core/package.json`.
2. Move `src/` to `packages/core/src/`, `tsconfig.json` to `packages/core/`.
3. Move `tests/` to `packages/core/tests/`.
4. Add `exports` field to `packages/core/package.json`.
5. Remove external provider dependencies from core's `package.json`
   (e.g., `@anthropic-ai/sdk`, `@slack/bolt`, `isomorphic-git`, `@tavily/core`).
6. Verify `pnpm build` and `pnpm test` pass from the workspace root.

### Step 2: Fix cross-provider dependencies and harden module resolution

Before extracting providers, resolve cross-category imports and close the CWD
hijacking vector introduced by package-name resolution.

#### 2a. Harden `resolveProviderPath` against CWD hijacking (SC-SEC-002)

**Problem:** When `provider-map.ts` returns a bare package name like
`'@ax/provider-llm-anthropic'`, Node.js `import()` resolves it by walking up the
`node_modules` directory hierarchy from CWD. An attacker who controls the working
directory can plant a malicious `node_modules/@ax/` that shadows the real package.

The current relative-path approach is immune because `new URL(path, import.meta.url)`
resolves against the module's own location, not CWD.

**Fix:** Use `import.meta.resolve()` (stable since Node 20.6) for package-name
entries. This resolves relative to the calling module's location, just like the
`new URL()` approach does for relative paths:

```typescript
// Before (vulnerable to CWD shadowing):
if (modulePath.startsWith('@') || ...) {
  return modulePath;  // import() walks CWD → parent → ... → root
}

// After (pinned to our installation):
if (modulePath.startsWith('@') || ...) {
  return import.meta.resolve(modulePath);  // resolves from THIS file's location
}
```

**Test:** Add a test that verifies package-name entries resolve to paths within the
AX installation directory, not arbitrary `node_modules/` locations.

#### 2b. Fix cross-provider imports

1. **Extract `parseCompoundId`** from `llm/router.ts` into `src/utils/compound-id.ts`.
   Update both `llm/router.ts` and `image/router.ts` to import from there.

2. **Update scheduler type imports** to use `@ax/provider-sdk` interfaces instead of
   relative `../channel/types.js` paths.

3. **Update screener type imports** similarly.

4. **Inline `sandbox/utils.ts`** into each sandbox implementation that uses it
   (subprocess, seatbelt, nsjail). It's 75 LOC of pure utility functions.

5. **Inline `scheduler/utils.ts`** into cron.ts and full.ts (82 LOC).

6. Verify all tests still pass.

### Step 3: Extract first provider package (pilot)

Start with the simplest external provider to validate the pattern:
**`@ax/provider-credentials-encrypted`** (115 LOC, no external npm deps, only
imports `node:crypto` and `dataFile` from paths).

1. Create `packages/provider-credentials-encrypted/`:
   ```
   packages/provider-credentials-encrypted/
   ├── package.json
   ├── tsconfig.json
   ├── src/
   │   └── index.ts    (renamed from encrypted.ts, exports create())
   └── tests/
       └── encrypted.test.ts
   ```

2. `package.json`:
   ```json
   {
     "name": "@ax/provider-credentials-encrypted",
     "version": "0.1.0",
     "type": "module",
     "main": "dist/index.js",
     "types": "dist/index.d.ts",
     "peerDependencies": {
       "@ax/core": "0.1.0"
     },
     "files": ["dist"]
   }
   ```

3. `tsconfig.json` extends root config, `rootDir: "src"`, `outDir: "dist"`.

4. Update `provider-map.ts`:
   ```typescript
   credentials: {
     env:       '../providers/credentials/env.js',
     encrypted: '@ax/provider-credentials-encrypted',
     keychain:  '../providers/credentials/keychain.js',
   },
   ```

5. Move the test from `tests/providers/credentials/encrypted.test.ts` to
   `packages/provider-credentials-encrypted/tests/`.

6. Update imports in the provider to use `@ax/core/paths` instead of
   `../../paths.js`.

7. Run full test suite. If green, the pattern is validated.

### Step 4: Extract remaining providers (batch)

Using the validated pattern from Step 3, extract all remaining providers. Group by
dependency complexity:

**Batch A — Zero external deps (easiest)**
- `@ax/provider-credentials-keychain`
- `@ax/provider-scanner-patterns`
- `@ax/provider-browser-container`
- `@ax/provider-sandbox-seatbelt`
- `@ax/provider-sandbox-nsjail`
- `@ax/provider-sandbox-bwrap`
- `@ax/provider-sandbox-docker`
- `@ax/provider-scheduler-cron`
- `@ax/provider-scheduler-full`
- `@ax/provider-web-fetch`
- `@ax/provider-scanner-promptfoo`
- `@ax/provider-image-openai`
- `@ax/provider-image-openrouter`
- `@ax/provider-image-gemini`

**Batch B — Has external npm deps**
- `@ax/provider-llm-anthropic` (depends: @anthropic-ai/sdk)
- `@ax/provider-llm-openai` (depends: openai)
- `@ax/provider-llm-traced` (depends: @opentelemetry/api)
- `@ax/provider-memory-sqlite` (depends: better-sqlite3, kysely)
- `@ax/provider-memory-memu` (depends: internal utils)
- `@ax/provider-audit-sqlite` (depends: better-sqlite3, kysely)
- `@ax/provider-channel-slack` (depends: @slack/bolt)
- `@ax/provider-web-tavily` (depends: @tavily/core)
- `@ax/provider-skills-git` (depends: isomorphic-git)

**Batch C — Router packages (depend on provider-map)**
- `@ax/provider-llm-router`
- `@ax/provider-image-router`

For each package: create directory structure, move source + tests, update imports,
update provider-map entry, verify tests pass.

### Step 5: Create `ax` meta-package

Create `packages/ax/package.json`:

```json
{
  "name": "ax",
  "version": "0.1.0",
  "description": "Security-first personal AI agent — batteries included",
  "dependencies": {
    "@ax/core": "0.1.0",
    "@ax/provider-llm-anthropic": "0.1.0",
    "@ax/provider-llm-openai": "0.1.0",
    "@ax/provider-llm-router": "0.1.0",
    "@ax/provider-llm-traced": "0.1.0",
    "@ax/provider-image-openai": "0.1.0",
    "@ax/provider-image-gemini": "0.1.0",
    "@ax/provider-image-router": "0.1.0",
    "@ax/provider-memory-sqlite": "0.1.0",
    "@ax/provider-scanner-patterns": "0.1.0",
    "@ax/provider-channel-slack": "0.1.0",
    "@ax/provider-web-fetch": "0.1.0",
    "@ax/provider-browser-container": "0.1.0",
    "@ax/provider-credentials-encrypted": "0.1.0",
    "@ax/provider-skills-git": "0.1.0",
    "@ax/provider-audit-sqlite": "0.1.0",
    "@ax/provider-sandbox-nsjail": "0.1.0",
    "@ax/provider-scheduler-full": "0.1.0"
  },
  "bin": {
    "ax": "./node_modules/@ax/core/bin/ax.js"
  }
}
```

### Step 6: Update `provider-map.ts` (final state)

```typescript
const _PROVIDER_MAP = {
  llm: {
    anthropic:  '@ax/provider-llm-anthropic',
    openai:     '@ax/provider-llm-openai',
    openrouter: '@ax/provider-llm-openai',
    groq:       '@ax/provider-llm-openai',
    router:     '@ax/provider-llm-router',
    mock:       './providers/llm/mock.js',        // stays in core
  },
  image: {
    openai:     '@ax/provider-image-openai',
    openrouter: '@ax/provider-image-openrouter',
    groq:       '@ax/provider-image-openai',
    gemini:     '@ax/provider-image-gemini',
    router:     '@ax/provider-image-router',
    mock:       './providers/image/mock.js',       // stays in core
  },
  memory: {
    file:   './providers/memory/file.js',          // stays in core
    sqlite: '@ax/provider-memory-sqlite',
    memu:   '@ax/provider-memory-memu',
  },
  scanner: {
    basic:     './providers/scanner/basic.js',     // stays in core
    patterns:  '@ax/provider-scanner-patterns',
    promptfoo: '@ax/provider-scanner-promptfoo',
  },
  channel: {
    slack: '@ax/provider-channel-slack',
  },
  web: {
    none:   './providers/web/none.js',             // stays in core
    fetch:  '@ax/provider-web-fetch',
    tavily: '@ax/provider-web-tavily',
  },
  browser: {
    none:      './providers/browser/none.js',      // stays in core
    container: '@ax/provider-browser-container',
  },
  credentials: {
    env:       './providers/credentials/env.js',   // stays in core
    encrypted: '@ax/provider-credentials-encrypted',
    keychain:  '@ax/provider-credentials-keychain',
  },
  skills: {
    readonly: './providers/skills/readonly.js',    // stays in core
    git:      '@ax/provider-skills-git',
  },
  audit: {
    file:   './providers/audit/file.js',           // stays in core
    sqlite: '@ax/provider-audit-sqlite',
  },
  sandbox: {
    subprocess: './providers/sandbox/subprocess.js', // stays in core
    seatbelt:   '@ax/provider-sandbox-seatbelt',
    nsjail:     '@ax/provider-sandbox-nsjail',
    bwrap:      '@ax/provider-sandbox-bwrap',
    docker:     '@ax/provider-sandbox-docker',
  },
  scheduler: {
    none: './providers/scheduler/none.js',         // stays in core
    cron: '@ax/provider-scheduler-cron',
    full: '@ax/provider-scheduler-full',
  },
  screener: {
    static: './providers/screener/static.js',      // stays in core
    none:   './providers/screener/none.js',        // stays in core
  },
} as const;
```

Note: Core providers use `./providers/` (relative to the package root within
`@ax/core`), external providers use package names. `resolveProviderPath()` already
handles both formats.

### Step 7: Update CI and build

1. Root `package.json` becomes a workspace root with scripts:
   ```json
   {
     "scripts": {
       "build": "pnpm -r build",
       "test": "pnpm -r test",
       "test:fuzz": "pnpm --filter @ax/core test:fuzz"
     }
   }
   ```

2. Root `tsconfig.json` becomes a project references file.

3. Each package has its own `tsconfig.json` extending a shared `tsconfig.base.json`.

4. `vitest.config.ts` stays in `@ax/core` for core tests. Each provider package
   gets its own minimal vitest config.

### Step 8: Verify and clean up

1. Run the full test suite from workspace root: `pnpm test`
2. Run `pnpm build` — verify all packages compile
3. Verify `provider-map.ts` correctly resolves all providers (both relative and package)
4. Remove empty directories from the old `src/providers/` structure
5. Update CLAUDE.md with new project structure
6. Verify no circular dependencies between packages

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Broken imports after move | Run tests after each step, not just at the end |
| TypeScript path resolution issues | Node16 module resolution + `exports` field handles this |
| Provider-map relative paths break | `resolveProviderPath()` already handles both formats |
| Test discovery changes | vitest config `exclude` already ignores worktrees; workspace test command runs all |
| pnpm workspace issues | Start with `pnpm import` to convert existing lockfile |
| Cross-provider type breakage | Provider-SDK already re-exports all interfaces |
| CWD module hijacking | `import.meta.resolve()` pins package resolution to AX install dir (Step 2a) |

## Success Criteria

- [ ] `@ax/core` is under 4,000 LOC (excluding tests)
- [ ] `pnpm build` compiles all packages from clean state
- [ ] `pnpm test` passes all existing tests (zero regressions)
- [ ] `npm install ax` (meta-package) resolves all standard providers
- [ ] `npm install @ax/core` alone is functional with mock/noop providers
- [ ] No provider imports from `../../` paths — all imports use package names or SDK
- [ ] SC-SEC-002 preserved: provider-map remains a static allowlist
- [ ] No new `devDependencies` in the core package from external providers
- [ ] Package-name entries resolve via `import.meta.resolve()`, not bare `import()`
