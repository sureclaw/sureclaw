# AX Security Hardening — Implementation Spec

> **Purpose**: This document is an implementation specification for Claude Code. It covers
> four security findings (1 CRITICAL, 3 HIGH) from the AX independent security review.
> Follow the implementation order below. Each section is self-contained with exact file paths,
> types, logic, tests, and acceptance criteria.
>
> **Context**: AX is a plugin/provider-based personal AI agent architecture. No code
> exists yet — this spec should be implemented alongside the Stage 0 walking skeleton. The
> architecture doc is in `ax-modular-architecture.md`. The project uses TypeScript,
> Node.js, and Zod for runtime validation.
>
> **Implementation Order** (dependencies flow downward):
> 1. SC-SEC-002 — Provider Loading Allowlist (no dependencies, 5 min)
> 2. SC-SEC-004 — Path Traversal Protection (no dependencies, shared utility)
> 3. SC-SEC-001 — IPC Schema Validation (foundational, everything else depends on this)
> 4. SC-SEC-003 — Taint Budget Enforcement (depends on IPC validation layer)

---

## Prerequisites

```bash
# Add Zod as a project dependency (runtime schema validation)
npm install zod

# Add fast-check for property-based fuzz testing (dev dependency)
npm install --save-dev fast-check
```

Zod is chosen over Ajv/io-ts because:
- Native TypeScript type inference (`z.infer<typeof Schema>` gives you the type for free)
- `.strict()` mode rejects unknown keys (critical for prototype pollution prevention)
- Excellent error messages for debugging validation failures
- Zero dependencies

---

## 1. SC-SEC-002: Provider Loading Allowlist

**Finding**: `registry.ts` uses `import(\`./providers/${kind}-${name}\`)` with values from
`ax.yaml`. Path traversal or config manipulation → arbitrary code execution on host.

**Fix**: Replace dynamic path construction with a hardcoded static map.

### File: `src/provider-map.ts` (NEW — ~60 LOC)

```typescript
/**
 * Static allowlist of all valid provider modules.
 *
 * SECURITY: This is the ONLY place that maps provider names to module paths.
 * Adding a new provider requires adding a line here. No dynamic path
 * construction from config values is permitted anywhere in the codebase.
 *
 * The keys are the (kind, name) pairs from ax.yaml.
 * The values are the import paths relative to this file's location.
 */

export const PROVIDER_MAP: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  llm: {
    anthropic: './providers/llm-anthropic',
    openai:    './providers/llm-openai',
    multi:     './providers/llm-multi',
  },
  memory: {
    file:   './providers/memory-file',
    sqlite: './providers/memory-sqlite',
    memu:   './providers/memory-memu',
  },
  scanner: {
    basic:     './providers/scanner-basic',
    patterns:  './providers/scanner-patterns',
    promptfoo: './providers/scanner-promptfoo',
  },
  channel: {
    cli:       './providers/channel-cli',
    whatsapp:  './providers/channel-whatsapp',
    telegram:  './providers/channel-telegram',
    discord:   './providers/channel-discord',
  },
  web: {
    none:   './providers/web-none',
    fetch:  './providers/web-fetch',
    search: './providers/web-search',
  },
  browser: {
    none:      './providers/browser-none',
    container: './providers/browser-container',
  },
  credentials: {
    env:       './providers/creds-env',
    encrypted: './providers/creds-encrypted',
    keychain:  './providers/creds-keychain',
  },
  skills: {
    readonly: './providers/skills-readonly',
    git:      './providers/skills-git',
  },
  audit: {
    file:   './providers/audit-file',
    sqlite: './providers/audit-sqlite',
  },
  container: {
    docker:     './providers/container-docker',
    apple:      './providers/container-apple',
    subprocess: './providers/container-subprocess',
  },
  scheduler: {
    none: './providers/scheduler-none',
    cron: './providers/scheduler-cron',
    full: './providers/scheduler-full',
  },
} as const;

/**
 * Returns the module path for a given provider kind and name.
 * Throws if the combination is not in the allowlist.
 */
export function resolveProviderPath(kind: string, name: string): string {
  const kindMap = PROVIDER_MAP[kind];
  if (!kindMap) {
    throw new Error(
      `Unknown provider kind: "${kind}". ` +
      `Valid kinds: ${Object.keys(PROVIDER_MAP).join(', ')}`
    );
  }

  const modulePath = kindMap[name];
  if (!modulePath) {
    throw new Error(
      `Unknown ${kind} provider: "${name}". ` +
      `Valid ${kind} providers: ${Object.keys(kindMap).join(', ')}`
    );
  }

  return modulePath;
}
```

### File: `src/registry.ts` (MODIFY)

Replace the existing `loadProvider` function:

```typescript
// BEFORE (INSECURE — remove this entirely):
// async function loadProvider(kind: string, name: string, config: Config) {
//   const mod = await import(`./providers/${kind}-${name}`);
//   return mod.create(config);
// }

// AFTER:
import { resolveProviderPath } from './provider-map';

async function loadProvider(kind: string, name: string, config: Config) {
  const modulePath = resolveProviderPath(kind, name);
  const mod = await import(modulePath);

  if (typeof mod.create !== 'function') {
    throw new Error(
      `Provider ${kind}-${name} does not export a create() function`
    );
  }

  return mod.create(config);
}
```

The special case for `memory-memu` (which receives registry and router accessors) stays as-is
in `loadProviders()` — it just uses `resolveProviderPath('memory', 'memu')` instead of
string interpolation for the import path.

### Tests: `tests/provider-map.test.ts`

```typescript
import { resolveProviderPath, PROVIDER_MAP } from '../src/provider-map';

describe('Provider allowlist', () => {
  test('resolves valid provider paths', () => {
    expect(resolveProviderPath('llm', 'anthropic')).toBe('./providers/llm-anthropic');
    expect(resolveProviderPath('memory', 'file')).toBe('./providers/memory-file');
    expect(resolveProviderPath('scheduler', 'none')).toBe('./providers/scheduler-none');
  });

  test('rejects unknown provider kind', () => {
    expect(() => resolveProviderPath('unknown', 'foo')).toThrow('Unknown provider kind');
  });

  test('rejects unknown provider name', () => {
    expect(() => resolveProviderPath('llm', 'evil')).toThrow('Unknown llm provider');
  });

  test('rejects path traversal in kind', () => {
    expect(() => resolveProviderPath('../etc', 'passwd')).toThrow('Unknown provider kind');
  });

  test('rejects path traversal in name', () => {
    expect(() => resolveProviderPath('llm', '../../etc/passwd')).toThrow('Unknown llm provider');
  });

  test('rejects empty strings', () => {
    expect(() => resolveProviderPath('', '')).toThrow('Unknown provider kind');
  });

  test('every mapped path follows naming convention', () => {
    for (const [kind, names] of Object.entries(PROVIDER_MAP)) {
      for (const [name, path] of Object.entries(names)) {
        // Path must start with ./providers/ and contain only safe characters
        expect(path).toMatch(/^\.\/providers\/[a-z\-]+$/);
        // Path must contain the kind or a known abbreviation
        // (creds-env → credentials kind, this is fine)
      }
    }
  });
});
```

### Acceptance Criteria
- [ ] `loadProvider` no longer constructs import paths from string interpolation
- [ ] `resolveProviderPath` throws for any (kind, name) pair not in the static map
- [ ] Path traversal payloads (`../`, `..\\`, etc.) in config values cause a clear error, not a load attempt
- [ ] All existing provider references in `ax.yaml` examples resolve correctly
- [ ] Tests pass

---

## 2. SC-SEC-004: Path Traversal Protection

**Finding**: `memory-file.ts` (and potentially other file-based providers) construct filesystem
paths from user-influenced input without verifying the result stays within the base directory.

**Fix**: Create a shared `safePath` utility and apply it everywhere paths are constructed from
input.

### File: `src/utils/safe-path.ts` (NEW — ~45 LOC)

```typescript
import { resolve, join, sep } from 'path';

/**
 * Safely construct a filesystem path from a base directory and untrusted input segments.
 *
 * SECURITY: This is the canonical defense against path traversal. Every file-based
 * provider MUST use this function when constructing paths from any input that could
 * be influenced by the agent, user messages, or external content.
 *
 * The function:
 * 1. Sanitizes each segment (removes dangerous characters)
 * 2. Joins segments to the base directory
 * 3. Resolves the result to an absolute path
 * 4. Verifies the resolved path is within the base directory
 * 5. Throws if containment check fails
 *
 * @param baseDir - The trusted base directory (must be an absolute path or will be resolved)
 * @param segments - One or more untrusted path segments (e.g., scope name, filename)
 * @returns The resolved absolute path, guaranteed to be within baseDir
 * @throws Error if the resolved path escapes baseDir
 */
export function safePath(baseDir: string, ...segments: string[]): string {
  const resolvedBase = resolve(baseDir);

  // Sanitize each segment independently:
  // - Replace path separators (/ and \) with underscores
  // - Replace null bytes (poison for C-based filesystem APIs)
  // - Replace .. sequences
  // - Remove colons (Windows ADS / platform-specific issues)
  // - Trim whitespace and dots from edges (Windows trailing dot/space tricks)
  const sanitized = segments.map(seg => {
    let clean = seg
      .replace(/[/\\]/g, '_')          // path separators → underscore
      .replace(/\0/g, '')              // null bytes → remove
      .replace(/\.\./g, '_')           // .. sequences → underscore
      .replace(/:/g, '_')              // colons → underscore (Windows ADS)
      .replace(/^[\s.]+|[\s.]+$/g, '') // trim leading/trailing dots and spaces
      ;

    // If sanitization produced an empty string, use a safe default
    if (clean.length === 0) clean = '_empty_';

    // Cap length to prevent filesystem issues
    if (clean.length > 255) clean = clean.slice(0, 255);

    return clean;
  });

  // Construct and resolve the full path
  const constructed = join(resolvedBase, ...sanitized);
  const resolvedFull = resolve(constructed);

  // CRITICAL: Containment check
  // The resolved path must start with the base directory followed by a separator,
  // OR be exactly the base directory itself.
  if (resolvedFull !== resolvedBase && !resolvedFull.startsWith(resolvedBase + sep)) {
    throw new Error(
      `Path traversal blocked: segments ${JSON.stringify(segments)} ` +
      `resolved to "${resolvedFull}" which is outside base "${resolvedBase}"`
    );
  }

  return resolvedFull;
}

/**
 * Validates that an existing path is within a base directory.
 * Use this when you receive a path from storage (e.g., reading an ID from a file)
 * rather than constructing one from segments.
 */
export function assertWithinBase(baseDir: string, targetPath: string): string {
  const resolvedBase = resolve(baseDir);
  const resolvedTarget = resolve(targetPath);

  if (resolvedTarget !== resolvedBase && !resolvedTarget.startsWith(resolvedBase + sep)) {
    throw new Error(
      `Path "${resolvedTarget}" is outside base directory "${resolvedBase}"`
    );
  }

  return resolvedTarget;
}
```

### File: `src/providers/memory-file.ts` (MODIFY)

Replace the `scopeDir` function and all path constructions:

```typescript
// BEFORE (INSECURE):
// async function scopeDir(scope: string): Promise<string> {
//   const dir = join(baseDir, scope.replace(/[^a-zA-Z0-9:_-]/g, '_'));
//   await mkdir(dir, { recursive: true });
//   return dir;
// }

// AFTER:
import { safePath } from '../utils/safe-path';

async function scopeDir(scope: string): Promise<string> {
  const dir = safePath(baseDir, scope);
  await mkdir(dir, { recursive: true });
  return dir;
}

// Also update the read() method which iterates scope directories:
async read(id: string): Promise<MemoryEntry | null> {
  // Validate ID format before using in path construction
  if (!/^[a-f0-9\-]{36}$/.test(id)) {
    throw new Error(`Invalid memory ID format: "${id}"`);
  }

  const scopes = await readdir(baseDir).catch(() => []);
  for (const scope of scopes) {
    const filePath = safePath(baseDir, scope, `${id}.json`);
    try {
      return JSON.parse(await readFile(filePath, 'utf-8'));
    } catch { continue; }
  }
  return null;
},

// And the delete() method:
async delete(id: string): Promise<void> {
  if (!/^[a-f0-9\-]{36}$/.test(id)) {
    throw new Error(`Invalid memory ID format: "${id}"`);
  }

  const scopes = await readdir(baseDir).catch(() => []);
  for (const scope of scopes) {
    try {
      const filePath = safePath(baseDir, scope, `${id}.json`);
      await unlink(filePath);
    } catch {}
  }
},
```

### Apply to ALL file-based providers

The same pattern applies to every provider that touches the filesystem. Grep for `join(` and
`readFile`/`writeFile` calls in providers and replace with `safePath`:

- **`providers/skills-readonly.ts`** — skill names come from agent requests. Use
  `safePath(skillsDir, name)` when constructing the path to read a skill file.
- **`providers/audit-file.ts`** — audit log path is usually hardcoded, but verify no
  user-influenced value participates in path construction.
- **`providers/creds-encrypted.ts`** — service names from `get(service)` calls.
  Use `safePath` if service names influence file paths, or validate against an allowlist.
- **`container/agent-runner.ts`** — if the agent writes to `/workspace`, verify paths.

### Tests: `tests/utils/safe-path.test.ts`

```typescript
import { safePath, assertWithinBase } from '../../src/utils/safe-path';
import { resolve } from 'path';

const BASE = '/tmp/test-base';

describe('safePath', () => {
  // ── Basic functionality ──
  test('constructs path within base', () => {
    expect(safePath(BASE, 'foo')).toBe(resolve(BASE, 'foo'));
  });

  test('handles nested segments', () => {
    expect(safePath(BASE, 'scope', 'file.json')).toBe(resolve(BASE, 'scope', 'file.json'));
  });

  // ── Path traversal attacks ──
  test('blocks ../ traversal', () => {
    expect(safePath(BASE, '..', 'etc', 'passwd')).toBe(resolve(BASE, '_', 'etc', 'passwd'));
    // Sanitized, not thrown — the .. becomes _ and stays within base
  });

  test('blocks encoded traversal', () => {
    const result = safePath(BASE, '..%2f..%2fetc');
    expect(result.startsWith(resolve(BASE))).toBe(true);
  });

  test('blocks absolute path injection', () => {
    // Leading / gets sanitized to _
    const result = safePath(BASE, '/etc/passwd');
    expect(result.startsWith(resolve(BASE))).toBe(true);
  });

  test('blocks null byte injection', () => {
    const result = safePath(BASE, 'foo\0.json');
    expect(result).toBe(resolve(BASE, 'foo.json'));
    expect(result.includes('\0')).toBe(false);
  });

  // ── Platform edge cases ──
  test('blocks colon (Windows ADS)', () => {
    const result = safePath(BASE, 'file:stream');
    expect(result).toBe(resolve(BASE, 'file_stream'));
  });

  test('blocks backslash traversal', () => {
    const result = safePath(BASE, '..\\..\\etc');
    expect(result.startsWith(resolve(BASE))).toBe(true);
  });

  test('handles trailing dots and spaces', () => {
    const result = safePath(BASE, 'foo. . .');
    expect(result.startsWith(resolve(BASE))).toBe(true);
  });

  // ── Edge cases ──
  test('handles empty segment', () => {
    const result = safePath(BASE, '');
    expect(result).toBe(resolve(BASE, '_empty_'));
  });

  test('handles very long segment', () => {
    const long = 'a'.repeat(1000);
    const result = safePath(BASE, long);
    const segment = result.slice(resolve(BASE).length + 1);
    expect(segment.length).toBeLessThanOrEqual(255);
  });

  test('rejects scope values that look like real attacks from memory-file context', () => {
    // These are realistic attack payloads an injected agent might try
    const attacks = [
      '../../../../etc/shadow',
      '..\\..\\..\\windows\\system32',
      'user:alice/../../root',
      'scope\x00.json',
      'C:\\Windows\\System32',
      'user:alice:$DATA',
    ];

    for (const attack of attacks) {
      const result = safePath(BASE, attack);
      expect(result.startsWith(resolve(BASE))).toBe(true);
    }
  });
});

describe('assertWithinBase', () => {
  test('accepts path within base', () => {
    expect(assertWithinBase(BASE, `${BASE}/foo`)).toBe(resolve(BASE, 'foo'));
  });

  test('rejects path outside base', () => {
    expect(() => assertWithinBase(BASE, '/etc/passwd')).toThrow('outside base directory');
  });

  test('accepts base directory itself', () => {
    expect(assertWithinBase(BASE, BASE)).toBe(resolve(BASE));
  });
});
```

### Acceptance Criteria
- [ ] `safePath` utility exists and is the only way file-based providers construct paths from input
- [ ] `memory-file.ts` uses `safePath` for all path construction
- [ ] `skills-readonly.ts` uses `safePath` for skill file lookups
- [ ] All path traversal test vectors produce paths within the base directory
- [ ] Memory ID format is validated before use in file paths
- [ ] No raw `join(baseDir, untrustedInput)` calls remain in any provider

---

## 3. SC-SEC-001: IPC Schema Validation

**Finding**: `ipc.ts` does `JSON.parse(raw)` with no schema validation. Prototype pollution,
type confusion, and unexpected field injection are all possible.

**Fix**: Zod schemas for every IPC action, strict mode, validated dispatch.

### File: `src/ipc-schemas.ts` (NEW — ~250 LOC)

This file defines the Zod schema for every IPC action. Each schema uses `.strict()` to reject
unknown fields.

```typescript
import { z } from 'zod';

// ═══════════════════════════════════════════════════════
// Shared validators (reused across schemas)
// ═══════════════════════════════════════════════════════

/** Safe string: no null bytes, reasonable length */
const safeString = (maxLen: number = 10_000) =>
  z.string().max(maxLen).refine(s => !s.includes('\0'), 'Null bytes not allowed');

/** Scope names: alphanumeric, underscores, hyphens, slashes for hierarchy */
const scopeName = z.string()
  .min(1)
  .max(200)
  .regex(
    /^[a-zA-Z0-9][a-zA-Z0-9_\-\/]{0,199}$/,
    'Scope must start with alphanumeric, contain only alphanumeric/underscore/hyphen/slash'
  );

/** Memory entry type */
const memoryType = z.enum([
  'preference', 'knowledge', 'user_message', 'assistant_message',
  'system', 'context', 'relationship',
]);

/** UUID format for IDs */
const uuid = z.string().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  'Must be a valid UUID'
);

// ═══════════════════════════════════════════════════════
// Action schemas — one per IPC action
// ═══════════════════════════════════════════════════════

// ── LLM ──────────────────────────────────────────────

export const LlmCallSchema = z.object({
  action: z.literal('llm_call'),
  provider: safeString(64),
  model: safeString(128).optional(),
  messages: z.array(z.object({
    role: z.enum(['user', 'assistant', 'system']),
    content: safeString(200_000),
  }).strict()).min(1).max(200),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(1).max(200_000).optional(),
}).strict();

// ── Memory ───────────────────────────────────────────

export const MemoryWriteSchema = z.object({
  action: z.literal('memory_write'),
  scope: scopeName,
  content: safeString(100_000),
  type: memoryType,
  source: safeString(200).optional(),
  tainted: z.boolean().optional(),
  relatedId: uuid.optional(),
}).strict();

export const MemoryQuerySchema = z.object({
  action: z.literal('memory_query'),
  scope: scopeName,
  query: safeString(10_000).optional(),
  maxResults: z.number().int().min(1).max(100).optional(),
}).strict();

export const MemoryReadSchema = z.object({
  action: z.literal('memory_read'),
  id: uuid,
}).strict();

export const MemoryDeleteSchema = z.object({
  action: z.literal('memory_delete'),
  id: uuid,
}).strict();

export const MemoryListSchema = z.object({
  action: z.literal('memory_list'),
  scope: scopeName,
  limit: z.number().int().min(1).max(100).optional(),
}).strict();

// ── Web ──────────────────────────────────────────────

export const WebFetchSchema = z.object({
  action: z.literal('web_fetch'),
  url: z.string().url().max(2048),
  method: z.enum(['GET', 'HEAD']).optional(),
  headers: z.record(safeString(200), safeString(4096)).optional(),
  timeoutMs: z.number().int().min(1000).max(30_000).optional(),
}).strict();

export const WebSearchSchema = z.object({
  action: z.literal('web_search'),
  query: safeString(1000),
  maxResults: z.number().int().min(1).max(20).optional(),
}).strict();

// ── Browser ──────────────────────────────────────────

export const BrowserNavigateSchema = z.object({
  action: z.literal('browser_navigate'),
  session: safeString(128),
  url: z.string().url().max(2048),
}).strict();

export const BrowserSnapshotSchema = z.object({
  action: z.literal('browser_snapshot'),
  session: safeString(128),
}).strict();

export const BrowserClickSchema = z.object({
  action: z.literal('browser_click'),
  session: safeString(128),
  ref: z.number().int().min(0),
}).strict();

export const BrowserTypeSchema = z.object({
  action: z.literal('browser_type'),
  session: safeString(128),
  ref: z.number().int().min(0),
  text: safeString(10_000),
}).strict();

export const BrowserScreenshotSchema = z.object({
  action: z.literal('browser_screenshot'),
  session: safeString(128),
}).strict();

export const BrowserCloseSchema = z.object({
  action: z.literal('browser_close'),
  session: safeString(128),
}).strict();

export const BrowserLaunchSchema = z.object({
  action: z.literal('browser_launch'),
  config: z.object({
    headless: z.boolean().optional(),
    viewport: z.object({
      width: z.number().int().min(320).max(3840).optional(),
      height: z.number().int().min(240).max(2160).optional(),
    }).strict().optional(),
  }).strict().optional(),
}).strict();

// ── Skills ───────────────────────────────────────────

export const SkillProposeSchema = z.object({
  action: z.literal('skill_propose'),
  skill: safeString(200),
  content: safeString(100_000),
  reason: safeString(2000).optional(),
}).strict();

export const SkillReadSchema = z.object({
  action: z.literal('skill_read'),
  name: safeString(200),
}).strict();

export const SkillListSchema = z.object({
  action: z.literal('skill_list'),
}).strict();

// ── OAuth ────────────────────────────────────────────

export const OAuthCallSchema = z.object({
  action: z.literal('oauth_call'),
  service: safeString(128),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  path: safeString(2048),
  body: safeString(100_000).optional(),
  headers: z.record(safeString(200), safeString(4096)).optional(),
}).strict();

// ── Scheduler (user-facing management via IPC) ───────

export const SchedulerListCronSchema = z.object({
  action: z.literal('scheduler_list_cron'),
}).strict();

export const SchedulerGetHeartbeatSchema = z.object({
  action: z.literal('scheduler_get_heartbeat'),
}).strict();

export const SchedulerListTriggersSchema = z.object({
  action: z.literal('scheduler_list_triggers'),
}).strict();

export const SchedulerRemoveCronSchema = z.object({
  action: z.literal('scheduler_remove_cron'),
  id: safeString(128),
}).strict();

// ── Audit (read-only from container) ─────────────────

export const AuditQuerySchema = z.object({
  action: z.literal('audit_query'),
  filter: z.object({
    action: safeString(100).optional(),
    since: z.string().datetime().optional(),
    until: z.string().datetime().optional(),
    limit: z.number().int().min(1).max(500).optional(),
  }).strict().optional(),
}).strict();


// ═══════════════════════════════════════════════════════
// Schema registry — maps action names to their schemas
// ═══════════════════════════════════════════════════════

export const IPC_SCHEMAS: Record<string, z.ZodType> = {
  llm_call:               LlmCallSchema,
  memory_write:           MemoryWriteSchema,
  memory_query:           MemoryQuerySchema,
  memory_read:            MemoryReadSchema,
  memory_delete:          MemoryDeleteSchema,
  memory_list:            MemoryListSchema,
  web_fetch:              WebFetchSchema,
  web_search:             WebSearchSchema,
  browser_launch:         BrowserLaunchSchema,
  browser_navigate:       BrowserNavigateSchema,
  browser_snapshot:       BrowserSnapshotSchema,
  browser_click:          BrowserClickSchema,
  browser_type:           BrowserTypeSchema,
  browser_screenshot:     BrowserScreenshotSchema,
  browser_close:          BrowserCloseSchema,
  skill_propose:          SkillProposeSchema,
  skill_read:             SkillReadSchema,
  skill_list:             SkillListSchema,
  oauth_call:             OAuthCallSchema,
  scheduler_list_cron:    SchedulerListCronSchema,
  scheduler_get_heartbeat: SchedulerGetHeartbeatSchema,
  scheduler_list_triggers: SchedulerListTriggersSchema,
  scheduler_remove_cron:  SchedulerRemoveCronSchema,
  audit_query:            AuditQuerySchema,
};

/**
 * All valid IPC action names. Used for the envelope validation.
 */
export const VALID_ACTIONS = Object.keys(IPC_SCHEMAS) as [string, ...string[]];

/**
 * The envelope schema: validates that the action field is a known action.
 * This is checked BEFORE the action-specific schema.
 */
export const IPCEnvelopeSchema = z.object({
  action: z.enum(VALID_ACTIONS as [string, ...string[]]),
}).passthrough(); // passthrough here because the action-specific schema handles strict checking
```

### File: `src/ipc.ts` (REWRITE — ~120 LOC)

Replace the existing IPC handler with a validated version:

```typescript
import { z } from 'zod';
import { IPC_SCHEMAS, IPCEnvelopeSchema } from './ipc-schemas';
import type { ProviderRegistry } from './registry';
import type { AuditProvider } from './providers/types';

export interface IPCContext {
  /** The session ID this IPC call belongs to (for taint budget, see SC-SEC-003) */
  sessionId: string;
  /** The agent making this call */
  agentId: string;
}

export function createIPCHandler(providers: ProviderRegistry) {

  // ── Handler implementations ──────────────────────────
  // Each handler receives ONLY the validated, typed data.
  // The `any` type here is narrowed by the schema — handlers should
  // cast to the specific inferred type if they need type safety.

  const handlers: Record<string, (req: any, ctx: IPCContext) => Promise<any>> = {

    llm_call: async (req) => {
      const cred = await providers.credentials.get(req.provider);
      const chunks = [];
      for await (const chunk of providers.llm.chat(req)) {
        chunks.push(chunk);
      }
      return { content: chunks };
    },

    memory_write: async (req) => {
      await providers.audit.log({ action: 'memory_write', scope: req.scope, type: req.type });
      return { id: await providers.memory.write(req) };
    },

    memory_query: async (req) => {
      return { results: await providers.memory.query(req) };
    },

    memory_read: async (req) => {
      return { entry: await providers.memory.read(req.id) };
    },

    memory_delete: async (req) => {
      await providers.audit.log({ action: 'memory_delete', id: req.id });
      await providers.memory.delete(req.id);
      return { ok: true };
    },

    memory_list: async (req) => {
      return { entries: await providers.memory.list(req.scope, req.limit) };
    },

    web_fetch: async (req) => {
      await providers.audit.log({ action: 'web_fetch', url: req.url });
      return await providers.web.fetch(req);
    },

    web_search: async (req) => {
      await providers.audit.log({ action: 'web_search', query: req.query });
      return await providers.web.search(req.query, req.maxResults);
    },

    browser_navigate: async (req) => {
      await providers.audit.log({ action: 'browser_navigate', url: req.url });
      return await providers.browser.navigate(req.session, req.url);
    },

    // ... (implement remaining handlers following the same pattern)
    // Each handler:
    //   1. Optionally audit logs the action
    //   2. Calls the appropriate provider method with validated data
    //   3. Returns the result

    skill_propose: async (req) => {
      await providers.audit.log({ action: 'skill_propose', skill: req.skill });
      return await providers.skills.propose(req);
    },

    oauth_call: async (req) => {
      const token = await providers.credentials.get(`oauth:${req.service}`);
      await providers.audit.log({ action: 'oauth_call', service: req.service, method: req.method, path: req.path });
      // Actual OAuth call implementation goes here
      // Token is injected server-side, never returned to container
    },

    scheduler_list_cron: async () => {
      return { jobs: await providers.scheduler.listCron() };
    },

    scheduler_get_heartbeat: async () => {
      return { heartbeat: await providers.scheduler.getHeartbeat() };
    },

    scheduler_list_triggers: async () => {
      return { triggers: await providers.scheduler.listTriggers() };
    },

    scheduler_remove_cron: async (req) => {
      await providers.audit.log({ action: 'scheduler_remove_cron', id: req.id });
      await providers.scheduler.removeCron(req.id);
      return { ok: true };
    },

    audit_query: async (req) => {
      return { entries: await providers.audit.query(req.filter ?? {}) };
    },
  };

  // ── Main dispatch function ───────────────────────────

  return async function handleIPC(raw: string, ctx: IPCContext): Promise<string> {
    // Step 1: Parse JSON safely
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      await providers.audit.log({
        action: 'ipc_parse_error',
        sessionId: ctx.sessionId,
        error: 'Invalid JSON',
        rawPreview: raw.slice(0, 200),
      });
      return JSON.stringify({ ok: false, error: 'Invalid JSON' });
    }

    // Step 2: Validate envelope (is this a known action?)
    const envelope = IPCEnvelopeSchema.safeParse(parsed);
    if (!envelope.success) {
      await providers.audit.log({
        action: 'ipc_unknown_action',
        sessionId: ctx.sessionId,
        issues: envelope.error.issues,
      });
      return JSON.stringify({
        ok: false,
        error: 'Unknown or missing action',
        details: envelope.error.issues.map(i => i.message),
      });
    }

    const actionName = envelope.data.action;

    // Step 3: Validate against action-specific schema (strict mode)
    const schema = IPC_SCHEMAS[actionName];
    const validated = schema.safeParse(parsed);
    if (!validated.success) {
      await providers.audit.log({
        action: 'ipc_validation_failure',
        sessionId: ctx.sessionId,
        ipcAction: actionName,
        issues: validated.error.issues,
        rawPreview: raw.slice(0, 500),
      });
      return JSON.stringify({
        ok: false,
        error: `Validation failed for action "${actionName}"`,
        details: validated.error.issues.map(i => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      });
    }

    // Step 4: Dispatch to handler with ONLY the validated data
    const handler = handlers[actionName];
    if (!handler) {
      // This should be unreachable if IPC_SCHEMAS and handlers are in sync
      return JSON.stringify({ ok: false, error: `No handler for action "${actionName}"` });
    }

    try {
      const result = await handler(validated.data, ctx);
      return JSON.stringify({ ok: true, ...result });
    } catch (err) {
      await providers.audit.log({
        action: 'ipc_handler_error',
        sessionId: ctx.sessionId,
        ipcAction: actionName,
        error: String(err),
      });
      return JSON.stringify({
        ok: false,
        error: `Handler error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  };
}
```

### Tests: `tests/ipc-schemas.test.ts`

```typescript
import { IPC_SCHEMAS, IPCEnvelopeSchema, LlmCallSchema, MemoryWriteSchema } from '../src/ipc-schemas';

describe('IPC Schema Validation', () => {

  // ── Envelope ──
  describe('Envelope', () => {
    test('accepts known action', () => {
      expect(IPCEnvelopeSchema.safeParse({ action: 'llm_call' }).success).toBe(true);
    });

    test('rejects unknown action', () => {
      expect(IPCEnvelopeSchema.safeParse({ action: 'evil_action' }).success).toBe(false);
    });

    test('rejects missing action', () => {
      expect(IPCEnvelopeSchema.safeParse({}).success).toBe(false);
    });

    test('rejects non-object', () => {
      expect(IPCEnvelopeSchema.safeParse('string').success).toBe(false);
      expect(IPCEnvelopeSchema.safeParse(42).success).toBe(false);
      expect(IPCEnvelopeSchema.safeParse(null).success).toBe(false);
    });
  });

  // ── LLM Call ──
  describe('LlmCallSchema', () => {
    const valid = {
      action: 'llm_call',
      provider: 'anthropic',
      messages: [{ role: 'user', content: 'hello' }],
    };

    test('accepts valid request', () => {
      expect(LlmCallSchema.safeParse(valid).success).toBe(true);
    });

    test('rejects extra fields (strict mode)', () => {
      expect(LlmCallSchema.safeParse({ ...valid, __proto__: {} }).success).toBe(false);
      expect(LlmCallSchema.safeParse({ ...valid, evil: 'field' }).success).toBe(false);
    });

    test('rejects empty messages', () => {
      expect(LlmCallSchema.safeParse({ ...valid, messages: [] }).success).toBe(false);
    });

    test('rejects null bytes in content', () => {
      const withNull = { ...valid, messages: [{ role: 'user', content: 'hello\0world' }] };
      expect(LlmCallSchema.safeParse(withNull).success).toBe(false);
    });

    test('rejects invalid role', () => {
      const badRole = { ...valid, messages: [{ role: 'admin', content: 'hello' }] };
      expect(LlmCallSchema.safeParse(badRole).success).toBe(false);
    });
  });

  // ── Memory Write ──
  describe('MemoryWriteSchema', () => {
    const valid = {
      action: 'memory_write',
      scope: 'user_alice',
      content: 'Alice prefers dark mode',
      type: 'preference',
    };

    test('accepts valid request', () => {
      expect(MemoryWriteSchema.safeParse(valid).success).toBe(true);
    });

    test('rejects scope with path traversal characters', () => {
      expect(MemoryWriteSchema.safeParse({ ...valid, scope: '../etc' }).success).toBe(false);
    });

    test('rejects scope starting with non-alphanumeric', () => {
      expect(MemoryWriteSchema.safeParse({ ...valid, scope: '_admin' }).success).toBe(false);
    });

    test('rejects unknown type', () => {
      expect(MemoryWriteSchema.safeParse({ ...valid, type: 'exploit' }).success).toBe(false);
    });

    test('rejects extra fields', () => {
      expect(MemoryWriteSchema.safeParse({ ...valid, drop_tables: true }).success).toBe(false);
    });
  });

  // ── Prototype Pollution ──
  describe('Prototype pollution prevention', () => {
    const pollutionPayloads = [
      { action: 'llm_call', provider: 'anthropic', messages: [{ role: 'user', content: 'hi' }], '__proto__': { admin: true } },
      { action: 'llm_call', provider: 'anthropic', messages: [{ role: 'user', content: 'hi' }], 'constructor': { prototype: { admin: true } } },
      { action: 'memory_write', scope: 'test', content: 'x', type: 'preference', '__proto__': { polluted: true } },
    ];

    test.each(pollutionPayloads)('rejects prototype pollution payload %#', (payload) => {
      const schema = IPC_SCHEMAS[payload.action];
      const result = schema.safeParse(payload);
      // Strict mode should reject the __proto__ / constructor keys
      expect(result.success).toBe(false);
    });
  });

  // ── Every action has a schema ──
  describe('Schema completeness', () => {
    test('every action in VALID_ACTIONS has a schema', () => {
      for (const action of Object.keys(IPC_SCHEMAS)) {
        expect(IPC_SCHEMAS[action]).toBeDefined();
      }
    });
  });
});
```

### Tests: `tests/ipc-fuzz.test.ts` (Property-Based)

```typescript
import * as fc from 'fast-check';
import { IPC_SCHEMAS, IPCEnvelopeSchema } from '../src/ipc-schemas';

describe('IPC Fuzz Testing', () => {

  test('random objects never cause uncaught exceptions in envelope parsing', () => {
    fc.assert(
      fc.property(fc.anything(), (input) => {
        // Must not throw — should return success: true or success: false
        const result = IPCEnvelopeSchema.safeParse(input);
        expect(typeof result.success).toBe('boolean');
      }),
      { numRuns: 10_000 }
    );
  });

  test('random strings never cause uncaught exceptions in JSON.parse + validate', () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(input);
        } catch {
          return; // Invalid JSON is handled before schemas
        }

        const envelope = IPCEnvelopeSchema.safeParse(parsed);
        if (!envelope.success) return;

        const schema = IPC_SCHEMAS[envelope.data.action];
        if (!schema) return;

        // Must not throw
        const result = schema.safeParse(parsed);
        expect(typeof result.success).toBe('boolean');
      }),
      { numRuns: 10_000 }
    );
  });

  test('deep nested objects do not cause stack overflow', () => {
    fc.assert(
      fc.property(
        fc.anything({
          maxDepth: 20,
          withBigInt: false,
          withDate: false,
          withMap: false,
          withSet: false,
          withTypedArray: false,
        }),
        (input) => {
          IPCEnvelopeSchema.safeParse(input);
          // Just verify it doesn't crash
        }
      ),
      { numRuns: 5_000 }
    );
  });

  test('all valid action schemas reject payloads with extra keys', () => {
    for (const [action, schema] of Object.entries(IPC_SCHEMAS)) {
      // Build a minimal valid-ish payload and add an extra field
      const withExtra = { action, extraEvil: 'payload', __proto__: { admin: true } };
      const result = schema.safeParse(withExtra);
      // Should fail because of strict mode OR missing required fields
      expect(result.success).toBe(false);
    }
  });
});
```

### Acceptance Criteria
- [ ] Every IPC action has a Zod schema with `.strict()` mode
- [ ] `handleIPC` validates ALL messages before dispatching to handlers
- [ ] Prototype pollution payloads (`__proto__`, `constructor.prototype`) are rejected
- [ ] Unknown fields on any action are rejected
- [ ] Validation failures are audit-logged with a preview of the rejected payload
- [ ] Null bytes are rejected in all string fields
- [ ] Property-based fuzz tests pass with 10,000+ iterations
- [ ] Handler functions receive typed data, not `any` from `JSON.parse`
- [ ] The handler registry and schema registry have the same keys (compile-time or test-time check)

---

## 4. SC-SEC-003: Taint Budget Enforcement

**Finding**: Taint tracking relies on LLM compliance with XML markers. Sophisticated injection
can cause the LLM to ignore taint markers and invoke sensitive IPC actions.

**Fix**: Track taint ratio per session in the router. When taint is high, structurally block
sensitive IPC actions in the host process regardless of what the LLM requests.

**Depends on**: SC-SEC-001 (IPC validation layer) must be in place first, because the taint
check hooks into the IPC dispatch flow.

### File: `src/taint-budget.ts` (NEW — ~100 LOC)

```typescript
/**
 * Taint Budget Tracker
 *
 * Tracks the proportion of external/untrusted content in each session's context.
 * When the taint ratio exceeds a configurable threshold, sensitive IPC actions
 * are structurally blocked at the host level — independent of LLM compliance.
 *
 * This is the structural enforcement layer that sits alongside (not replacing)
 * the XML taint markers and system instructions.
 */

export interface TaintBudgetConfig {
  /**
   * IPC actions that are blocked when taint ratio exceeds the threshold.
   * These are the actions where a compromised LLM could cause the most damage.
   */
  sensitiveActions: Set<string>;

  /**
   * Taint ratio thresholds per security profile.
   * When session taint ratio exceeds this, sensitive actions are blocked.
   *
   * Paranoid:   0.10 — block almost everything when any external content is present
   * Standard:   0.30 — block when a significant portion is external
   * Power User: 0.60 — only block when majority is external
   */
  threshold: number;
}

export const DEFAULT_SENSITIVE_ACTIONS = new Set([
  'oauth_call',          // Can send emails, post to APIs, modify external state
  'skill_propose',       // Can modify agent behavior permanently
  'browser_navigate',    // Can visit arbitrary URLs with injected credentials
  'scheduler_add_cron',  // Can create persistent scheduled actions (if exposed via IPC)
]);

export const PROFILE_THRESHOLDS = {
  paranoid: 0.10,
  standard: 0.30,
  yolo: 0.60,
} as const;

export interface SessionTaintState {
  sessionId: string;
  totalTokens: number;
  taintedTokens: number;

  /** IPC actions that have been explicitly user-confirmed for this session */
  userOverrides: Set<string>;
}

export class TaintBudget {
  private sessions = new Map<string, SessionTaintState>();
  private config: TaintBudgetConfig;

  constructor(config: TaintBudgetConfig) {
    this.config = config;
  }

  /**
   * Record content entering a session.
   * Call this from the router when messages are processed.
   *
   * @param sessionId - The session this content belongs to
   * @param estimatedTokens - Approximate token count of the content
   * @param isTainted - Whether this content is from an external/untrusted source
   */
  recordContent(sessionId: string, estimatedTokens: number, isTainted: boolean): void {
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = {
        sessionId,
        totalTokens: 0,
        taintedTokens: 0,
        userOverrides: new Set(),
      };
      this.sessions.set(sessionId, state);
    }

    state.totalTokens += estimatedTokens;
    if (isTainted) {
      state.taintedTokens += estimatedTokens;
    }
  }

  /**
   * Check whether an IPC action should be allowed for a session.
   *
   * Returns { allowed: true } or { allowed: false, reason, taintRatio }.
   */
  checkAction(sessionId: string, action: string): TaintCheckResult {
    // If this action isn't in the sensitive set, always allow
    if (!this.config.sensitiveActions.has(action)) {
      return { allowed: true };
    }

    const state = this.sessions.get(sessionId);

    // No state = no content recorded = no taint = allow
    if (!state || state.totalTokens === 0) {
      return { allowed: true };
    }

    // User has explicitly overridden this action for this session
    if (state.userOverrides.has(action)) {
      return { allowed: true };
    }

    const ratio = state.taintedTokens / state.totalTokens;

    if (ratio > this.config.threshold) {
      return {
        allowed: false,
        reason: `Session taint ratio ${(ratio * 100).toFixed(1)}% exceeds threshold ` +
                `${(this.config.threshold * 100).toFixed(0)}%. Action "${action}" requires ` +
                `user confirmation.`,
        taintRatio: ratio,
        threshold: this.config.threshold,
      };
    }

    return { allowed: true };
  }

  /**
   * Record a user confirmation that overrides the taint block for a specific action.
   * Called when the user explicitly confirms they want the action to proceed.
   */
  addUserOverride(sessionId: string, action: string): void {
    const state = this.sessions.get(sessionId);
    if (state) {
      state.userOverrides.add(action);
    }
  }

  /**
   * Get the current taint state for a session (for audit/debug).
   */
  getState(sessionId: string): SessionTaintState | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Clean up a session when it ends.
   */
  endSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}

export type TaintCheckResult =
  | { allowed: true }
  | { allowed: false; reason: string; taintRatio: number; threshold: number };
```

### File: `src/router.ts` (MODIFY)

Add taint tracking to the message routing pipeline:

```typescript
import { TaintBudget } from './taint-budget';

// In the router, when processing inbound content:
function processInboundContent(sessionId: string, msg: InboundMessage, taintBudget: TaintBudget) {
  // Estimate tokens (rough: ~4 chars per token)
  const estimatedTokens = Math.ceil(msg.content.length / 4);

  // Determine if this content is tainted
  const isTainted = msg.trust === 'external' || msg.source === 'web' || msg.source === 'email';

  // Record in the taint budget
  taintBudget.recordContent(sessionId, estimatedTokens, isTainted);

  // Existing taint tagging logic continues below (XML markers, etc.)
  // ...
}
```

### File: `src/ipc.ts` (MODIFY — add taint check to dispatch)

Add the taint budget check between validation and handler dispatch. This goes into the
`handleIPC` function from SC-SEC-001:

```typescript
import { TaintBudget } from './taint-budget';

// In createIPCHandler, accept taintBudget as a parameter:
export function createIPCHandler(providers: ProviderRegistry, taintBudget: TaintBudget) {

  return async function handleIPC(raw: string, ctx: IPCContext): Promise<string> {
    // ... (Steps 1-3 from SC-SEC-001: parse, envelope validate, schema validate) ...

    // Step 3.5: Taint budget enforcement (AFTER validation, BEFORE dispatch)
    const taintCheck = taintBudget.checkAction(ctx.sessionId, actionName);
    if (!taintCheck.allowed) {
      await providers.audit.log({
        action: 'taint_budget_block',
        sessionId: ctx.sessionId,
        blockedAction: actionName,
        taintRatio: taintCheck.taintRatio,
        threshold: taintCheck.threshold,
      });
      return JSON.stringify({
        ok: false,
        error: taintCheck.reason,
        taintBlocked: true,  // Distinct error type so the agent can ask for user confirmation
        action: actionName,
      });
    }

    // Step 4: Dispatch to handler (existing code from SC-SEC-001)
    // ...
  };
}
```

### File: `src/host.ts` (MODIFY — wire it together)

```typescript
import { TaintBudget, DEFAULT_SENSITIVE_ACTIONS, PROFILE_THRESHOLDS } from './taint-budget';

// During startup, after loading config:
const securityProfile = config.securityProfile ?? 'standard';  // paranoid | standard | yolo
const taintBudget = new TaintBudget({
  sensitiveActions: DEFAULT_SENSITIVE_ACTIONS,
  threshold: PROFILE_THRESHOLDS[securityProfile],
});

// Pass to IPC handler:
const handleIPC = createIPCHandler(providers, taintBudget);

// Pass to router:
const router = createRouter(providers, taintBudget);

// Clean up when sessions end:
// (in session teardown logic)
taintBudget.endSession(sessionId);
```

### User Confirmation Flow

When the agent receives a `taintBlocked: true` error from IPC, it should tell the user:

```
Agent: "I'd like to send an email on your behalf, but this session includes external
content (web pages, emails) that could influence my actions. For safety, I need your
explicit confirmation. Would you like me to proceed with sending the email?"

User: "Yes, go ahead."

→ Router sees user confirmation, calls taintBudget.addUserOverride(sessionId, 'oauth_call')
→ Agent retries the oauth_call, which now succeeds
```

The confirmation detection logic belongs in the router. When a user message arrives that
appears to be confirming a taint-blocked action (heuristic: follows immediately after a
taint block, contains affirmative language), the router calls `addUserOverride`.

**Important**: The override is per-session and per-action. It does not carry across sessions
or apply to other actions. The user must confirm each sensitive action type independently.

### Config: `ax.yaml` (ADD)

```yaml
# Security profile: paranoid | standard | yolo
# Controls taint budget thresholds and other security-vs-utility tradeoffs
securityProfile: standard

# Optional: override taint budget settings directly
# taintBudget:
#   threshold: 0.35
#   sensitiveActions:
#     - oauth_call
#     - skill_propose
#     - browser_navigate
```

### Tests: `tests/taint-budget.test.ts`

```typescript
import { TaintBudget, DEFAULT_SENSITIVE_ACTIONS, PROFILE_THRESHOLDS } from '../src/taint-budget';

function createBudget(threshold = 0.3) {
  return new TaintBudget({
    sensitiveActions: DEFAULT_SENSITIVE_ACTIONS,
    threshold,
  });
}

describe('TaintBudget', () => {
  // ── Basic behavior ──
  test('allows non-sensitive actions regardless of taint', () => {
    const tb = createBudget();
    tb.recordContent('s1', 1000, true); // 100% tainted
    expect(tb.checkAction('s1', 'memory_query').allowed).toBe(true);
    expect(tb.checkAction('s1', 'llm_call').allowed).toBe(true);
  });

  test('allows sensitive actions when taint is below threshold', () => {
    const tb = createBudget(0.3);
    tb.recordContent('s1', 900, false);  // 90% clean
    tb.recordContent('s1', 100, true);   // 10% tainted
    expect(tb.checkAction('s1', 'oauth_call').allowed).toBe(true);
  });

  test('blocks sensitive actions when taint exceeds threshold', () => {
    const tb = createBudget(0.3);
    tb.recordContent('s1', 300, false);  // 30% clean
    tb.recordContent('s1', 700, true);   // 70% tainted
    const result = tb.checkAction('s1', 'oauth_call');
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.taintRatio).toBeCloseTo(0.7);
    }
  });

  test('blocks at exact threshold boundary', () => {
    const tb = createBudget(0.3);
    tb.recordContent('s1', 700, false);
    tb.recordContent('s1', 301, true);  // just over 30%
    expect(tb.checkAction('s1', 'oauth_call').allowed).toBe(false);
  });

  // ── User overrides ──
  test('allows after user override', () => {
    const tb = createBudget(0.3);
    tb.recordContent('s1', 100, false);
    tb.recordContent('s1', 900, true);  // 90% tainted

    expect(tb.checkAction('s1', 'oauth_call').allowed).toBe(false);

    tb.addUserOverride('s1', 'oauth_call');
    expect(tb.checkAction('s1', 'oauth_call').allowed).toBe(true);

    // Override is per-action: other sensitive actions still blocked
    expect(tb.checkAction('s1', 'skill_propose').allowed).toBe(false);
  });

  // ── Session isolation ──
  test('sessions are independent', () => {
    const tb = createBudget(0.3);
    tb.recordContent('s1', 100, false);
    tb.recordContent('s1', 900, true);  // s1: 90% tainted
    tb.recordContent('s2', 900, false);
    tb.recordContent('s2', 100, true);  // s2: 10% tainted

    expect(tb.checkAction('s1', 'oauth_call').allowed).toBe(false);
    expect(tb.checkAction('s2', 'oauth_call').allowed).toBe(true);
  });

  test('overrides do not leak across sessions', () => {
    const tb = createBudget(0.3);
    tb.recordContent('s1', 100, true);  // both tainted
    tb.recordContent('s2', 100, true);

    tb.addUserOverride('s1', 'oauth_call');
    expect(tb.checkAction('s1', 'oauth_call').allowed).toBe(true);
    expect(tb.checkAction('s2', 'oauth_call').allowed).toBe(false);
  });

  // ── Cleanup ──
  test('endSession clears state', () => {
    const tb = createBudget(0.3);
    tb.recordContent('s1', 100, true);
    tb.addUserOverride('s1', 'oauth_call');

    tb.endSession('s1');

    // New content in same session ID starts fresh
    expect(tb.checkAction('s1', 'oauth_call').allowed).toBe(true); // no state = no taint
  });

  // ── Edge cases ──
  test('unknown session allows all actions', () => {
    const tb = createBudget(0.3);
    expect(tb.checkAction('nonexistent', 'oauth_call').allowed).toBe(true);
  });

  test('zero tokens allows all actions', () => {
    const tb = createBudget(0.3);
    tb.recordContent('s1', 0, true);
    expect(tb.checkAction('s1', 'oauth_call').allowed).toBe(true);
  });

  // ── Profile thresholds ──
  test('paranoid profile blocks at low taint', () => {
    const tb = createBudget(PROFILE_THRESHOLDS.paranoid); // 0.10
    tb.recordContent('s1', 850, false);
    tb.recordContent('s1', 150, true); // 15% tainted
    expect(tb.checkAction('s1', 'oauth_call').allowed).toBe(false);
  });

  test('yolo profile allows at moderate taint', () => {
    const tb = createBudget(PROFILE_THRESHOLDS.yolo); // 0.60
    tb.recordContent('s1', 500, false);
    tb.recordContent('s1', 400, true); // 44% tainted
    expect(tb.checkAction('s1', 'oauth_call').allowed).toBe(true);
  });

  // ── All sensitive actions are checked ──
  test('all default sensitive actions are blocked when tainted', () => {
    const tb = createBudget(0.3);
    tb.recordContent('s1', 100, false);
    tb.recordContent('s1', 900, true);

    for (const action of DEFAULT_SENSITIVE_ACTIONS) {
      expect(tb.checkAction('s1', action).allowed).toBe(false);
    }
  });
});
```

### Acceptance Criteria
- [ ] `TaintBudget` class tracks per-session taint ratios
- [ ] Sensitive IPC actions are blocked when taint ratio exceeds the configured threshold
- [ ] The block is structural (in host code), not dependent on LLM behavior
- [ ] User can override taint blocks with explicit confirmation (per-session, per-action)
- [ ] Sessions are isolated — taint in one session does not affect another
- [ ] Security profiles (paranoid/standard/yolo) map to different thresholds
- [ ] All taint blocks are audit-logged with the ratio, threshold, and blocked action
- [ ] `endSession` cleans up state to prevent memory leaks
- [ ] The taint check integrates into the IPC dispatch flow between validation and handler execution
- [ ] Non-sensitive actions (memory_query, llm_call, etc.) are never blocked by taint

---

## Cross-Cutting Concerns

### Dependency Summary

| Package | Version | Purpose | Used By |
|---------|---------|---------|---------|
| `zod` | ^3.x | Runtime schema validation | `ipc-schemas.ts`, config validation |
| `fast-check` | ^3.x (dev) | Property-based fuzz testing | `ipc-fuzz.test.ts` |

### File Manifest (New Files)

| File | LOC (est.) | Purpose |
|------|-----------|---------|
| `src/provider-map.ts` | ~60 | Static provider allowlist |
| `src/utils/safe-path.ts` | ~45 | Path traversal protection utility |
| `src/ipc-schemas.ts` | ~250 | Zod schemas for all IPC actions |
| `src/taint-budget.ts` | ~100 | Taint ratio tracking and enforcement |
| `tests/provider-map.test.ts` | ~50 | Provider allowlist tests |
| `tests/utils/safe-path.test.ts` | ~80 | Path traversal tests |
| `tests/ipc-schemas.test.ts` | ~120 | Schema validation tests |
| `tests/ipc-fuzz.test.ts` | ~60 | Property-based fuzz tests |
| `tests/taint-budget.test.ts` | ~120 | Taint budget tests |

### Modified Files

| File | Changes |
|------|---------|
| `src/registry.ts` | Replace dynamic import with `resolveProviderPath()` |
| `src/ipc.ts` | Full rewrite: add validation layer + taint check |
| `src/router.ts` | Add taint recording on inbound content |
| `src/host.ts` | Wire TaintBudget into IPC handler and router |
| `src/providers/memory-file.ts` | Replace path construction with `safePath()` |
| `src/providers/skills-readonly.ts` | Replace path construction with `safePath()` |
| `ax.yaml` | Add `securityProfile` config option |

### CI Integration

Add to the test suite:
```bash
# Unit tests
npx vitest run tests/provider-map.test.ts
npx vitest run tests/utils/safe-path.test.ts
npx vitest run tests/ipc-schemas.test.ts
npx vitest run tests/taint-budget.test.ts

# Fuzz tests (longer running)
npx vitest run tests/ipc-fuzz.test.ts

# Ensure no raw dynamic imports remain
grep -rn 'import(`' src/ && echo "FAIL: Dynamic imports found" && exit 1 || echo "PASS: No dynamic imports"

# Ensure no raw join() with untrusted input remains in providers
grep -rn 'join(.*Dir.*,' src/providers/ | grep -v safe-path | grep -v node_modules && echo "WARNING: Potential unsafe path construction" || echo "PASS"
```
