# Toolgen: Unified Tool Dispatch & Programmatic Tool Calling

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace `capnweb/` with `toolgen/`, unify host-side tool dispatch into a single bottleneck, add OpenAPI spec support, introduce `execute_script` for multi-tool pipelines, and add result persistence for context bloat defense.

**Architecture:** A `ToolDispatcher` on the host becomes the single entry point for all external tool calls (MCP + OpenAPI). Toolgen generates importable TypeScript modules (not CLIs) from MCP and OpenAPI schemas. The agent uses these modules via an `execute_script` tool that runs Node.js scripts in-sandbox, with intermediate results never entering LLM context. Large tool results are persisted to `/tmp` with inline previews.

**Tech Stack:** TypeScript, Zod (IPC schemas), TypeBox (tool catalog), Node.js `vm` or subprocess for script execution, existing IPC transport (Unix socket / HTTP).

---

## Design Decisions

### Why PTC over CLIs

The current CLI model (one shell invocation per tool call) has three problems:
1. Each CLI call is a separate `bash` tool invocation — N tools = N LLM turns
2. CLI output is string-based with no composability between calls
3. Tool results all enter context individually, bloating the window

PTC (Programmatic Tool Calling) fixes all three: the agent writes one TypeScript script that calls N tools, intermediate results stay local, and only `stdout` enters context.

### Why unified dispatch

`tool-router.ts` and `tool-batch.ts` currently duplicate MCP routing logic (resolve server → resolve headers → call tool → enforce size limits → taint-tag). A single `ToolDispatcher` eliminates this duplication and provides one place for circuit breakers, size limits, and audit logging.

### Result persistence

Tool results exceeding a threshold are written to `/tmp/ax-results/<id>.json` and replaced with a short preview + file path in context. The agent can `read_file` the full result on demand. `/tmp` works in both local and k8s modes and doesn't pollute the git workspace.

---

## Task 1: Rename `capnweb/` → `toolgen/`

**Files:**
- Rename: `src/host/capnweb/` → `src/host/toolgen/`
- Rename: `tests/host/capnweb/` → `tests/host/toolgen/`
- Modify: `src/host/server-completions.ts:1267,1277` (import paths)
- Modify: `.claude/skills/ax/SKILL.md`, `.claude/skills/ax-host/SKILL.md` (references)
- Modify: `.claude/journal/host/capnweb.md` → add note about rename

**Step 1: Move source directory**

```bash
git mv src/host/capnweb src/host/toolgen
```

**Step 2: Move test directory**

```bash
git mv tests/host/capnweb tests/host/toolgen
```

**Step 3: Update imports in server-completions.ts**

In `src/host/server-completions.ts`, change both occurrences (lines ~1267 and ~1277):

```typescript
// Before
const { prepareMcpCLIs } = await import('./capnweb/generate-and-cache.js');
// After
const { prepareMcpCLIs } = await import('./toolgen/generate-and-cache.js');
```

**Step 4: Update imports in test files**

In `tests/host/toolgen/codegen.test.ts`:
```typescript
// Before
import { groupToolsByServer, generateCLI, mcpToolToCLICommand } from '../../../src/host/capnweb/codegen.js';
// After
import { groupToolsByServer, generateCLI, mcpToolToCLICommand } from '../../../src/host/toolgen/codegen.js';
```

In `tests/host/toolgen/generate-and-cache.test.ts`:
```typescript
// Before
import { prepareMcpCLIs } from '../../../src/host/capnweb/generate-and-cache.js';
// After
import { prepareMcpCLIs } from '../../../src/host/toolgen/generate-and-cache.js';
```

**Step 5: Update skill docs**

Update references in `.claude/skills/ax/SKILL.md` and `.claude/skills/ax-host/SKILL.md` from `capnweb` to `toolgen`.

**Step 6: Run tests to verify rename**

Run: `npx vitest run tests/host/toolgen/`
Expected: All existing tests pass with new paths.

**Step 7: Commit**

```bash
git add -A
git commit -m "refactor: rename capnweb/ to toolgen/"
```

---

## Task 2: Create `ToolDispatcher` — unified host-side dispatch

**Files:**
- Create: `src/host/tool-dispatcher.ts`
- Create: `tests/host/tool-dispatcher.test.ts`

This replaces the duplicated MCP routing logic in `tool-router.ts` and `tool-batch.ts` with a single bottleneck.

**Step 1: Write the failing test**

```typescript
// tests/host/tool-dispatcher.test.ts
import { describe, it, expect, vi } from 'vitest';
import { ToolDispatcher } from '../../src/host/tool-dispatcher.js';
import { initLogger } from '../../src/logger.js';

initLogger({ file: false, level: 'silent' });

describe('ToolDispatcher', () => {
  it('dispatches to MCP server when resolver finds a match', async () => {
    const callTool = vi.fn().mockResolvedValue({ content: '{"ok":true}' });
    const dispatcher = new ToolDispatcher({
      resolveServer: (_agentId, toolName) =>
        toolName === 'linear_list_issues' ? 'http://mcp.linear' : undefined,
      callTool,
    });

    const result = await dispatcher.dispatch(
      { tool: 'linear_list_issues', args: { limit: 5 } },
      { agentId: 'a1', sessionId: 's1', userId: 'u1' },
    );

    expect(callTool).toHaveBeenCalledWith(
      'http://mcp.linear',
      'linear_list_issues',
      { limit: 5 },
      expect.anything(),
    );
    expect(result.content).toBe('{"ok":true}');
    expect(result.isError).toBeFalsy();
  });

  it('returns error for unknown tools', async () => {
    const dispatcher = new ToolDispatcher({
      resolveServer: () => undefined,
      callTool: vi.fn(),
    });

    const result = await dispatcher.dispatch(
      { tool: 'nonexistent', args: {} },
      { agentId: 'a1', sessionId: 's1', userId: 'u1' },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('nonexistent');
  });

  it('enforces per-result size limit', async () => {
    const bigContent = 'x'.repeat(2_000_000);
    const dispatcher = new ToolDispatcher({
      resolveServer: () => 'http://mcp.test',
      callTool: vi.fn().mockResolvedValue({ content: bigContent }),
    });

    const result = await dispatcher.dispatch(
      { tool: 'big_tool', args: {} },
      { agentId: 'a1', sessionId: 's1', userId: 'u1' },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('too large');
  });

  it('taint-tags all results as external', async () => {
    const dispatcher = new ToolDispatcher({
      resolveServer: () => 'http://mcp.test',
      callTool: vi.fn().mockResolvedValue({ content: '{}' }),
    });

    const result = await dispatcher.dispatch(
      { tool: 'some_tool', args: {} },
      { agentId: 'a1', sessionId: 's1', userId: 'u1' },
    );

    expect(result.taint).toBeDefined();
    expect(result.taint?.trust).toBe('external');
  });

  it('catches handler errors and returns error result', async () => {
    const dispatcher = new ToolDispatcher({
      resolveServer: () => 'http://mcp.test',
      callTool: vi.fn().mockRejectedValue(new Error('connection refused')),
    });

    const result = await dispatcher.dispatch(
      { tool: 'failing_tool', args: {} },
      { agentId: 'a1', sessionId: 's1', userId: 'u1' },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('connection refused');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/host/tool-dispatcher.test.ts`
Expected: FAIL — module not found.

**Step 3: Implement ToolDispatcher**

```typescript
// src/host/tool-dispatcher.ts
/**
 * Unified tool dispatch bottleneck for all external tools (MCP + OpenAPI).
 *
 * Both tool_batch IPC (from toolgen scripts) and tool-router.ts (from
 * pi-agent tool_use) call into this single dispatcher. Handles server
 * resolution, header injection, size limits, taint tagging, and errors.
 */

import type { TaintTag } from '../types.js';
import { getLogger } from '../logger.js';

const logger = getLogger().child({ component: 'tool-dispatcher' });

export const DISPATCH_LIMITS = {
  maxResultSizeBytes: 1_048_576,   // 1 MB per result
} as const;

export interface DispatchCall {
  tool: string;
  args: Record<string, unknown>;
}

export interface DispatchContext {
  agentId: string;
  sessionId: string;
  userId: string;
}

export interface DispatchResult {
  content: string;
  isError?: boolean;
  taint?: TaintTag;
}

export interface ToolDispatcherOptions {
  /** Resolve tool name → MCP/API server URL. */
  resolveServer: (agentId: string, toolName: string) => string | undefined;
  /** Execute tool on resolved server. */
  callTool: (
    serverUrl: string,
    toolName: string,
    args: Record<string, unknown>,
    opts?: { headers?: Record<string, string> },
  ) => Promise<{ content: string | Record<string, unknown>; isError?: boolean }>;
  /** Get server metadata for credential resolution. */
  getServerMeta?: (agentId: string, serverUrl: string) =>
    { name?: string; headers?: Record<string, string> } | undefined;
  /** Resolve credential placeholders in headers. */
  resolveHeaders?: (headers: Record<string, string>) => Promise<Record<string, string>>;
  /** Auto-discover auth for servers without explicit headers. */
  authForServer?: (server: { name: string; url: string }) => Promise<Record<string, string> | undefined>;
}

export class ToolDispatcher {
  constructor(private readonly opts: ToolDispatcherOptions) {}

  async dispatch(call: DispatchCall, ctx: DispatchContext): Promise<DispatchResult> {
    const serverUrl = this.opts.resolveServer(ctx.agentId, call.tool);
    if (!serverUrl) {
      return {
        content: `Unknown tool: "${call.tool}". No MCP server or API endpoint registered for this tool.`,
        isError: true,
      };
    }

    // Resolve auth headers
    let headers: Record<string, string> | undefined;
    try {
      if (this.opts.getServerMeta) {
        const meta = this.opts.getServerMeta(ctx.agentId, serverUrl);
        if (meta?.headers) {
          headers = this.opts.resolveHeaders
            ? await this.opts.resolveHeaders(meta.headers)
            : meta.headers;
        }
        if (!headers && this.opts.authForServer && meta?.name) {
          headers = await this.opts.authForServer({ name: meta.name, url: serverUrl });
        }
      }
    } catch {
      // Header resolution failure should not block the tool call
    }

    try {
      const result = await this.opts.callTool(
        serverUrl, call.tool, call.args,
        headers ? { headers } : undefined,
      );

      const content = typeof result.content === 'string'
        ? result.content
        : JSON.stringify(result.content);

      if (Buffer.byteLength(content) > DISPATCH_LIMITS.maxResultSizeBytes) {
        return {
          content: `Tool result too large (>${DISPATCH_LIMITS.maxResultSizeBytes} bytes). Ask for a smaller response.`,
          isError: true,
        };
      }

      return {
        content,
        isError: result.isError,
        taint: { source: `mcp:${serverUrl}`, trust: 'external' as const, timestamp: new Date() },
      };
    } catch (err) {
      logger.warn('dispatch_error', { tool: call.tool, error: (err as Error).message });
      return {
        content: `Tool call failed: ${(err as Error).message}`,
        isError: true,
      };
    }
  }

  /** Batch dispatch with dependency resolution (for tool_batch IPC). */
  async dispatchBatch(
    calls: DispatchCall[],
    ctx: DispatchContext,
  ): Promise<unknown[]> {
    const results: unknown[] = [];
    for (const call of calls) {
      const resolved = this.resolveRefs(call.args, results);
      const result = await this.dispatch({ tool: call.tool, args: resolved }, ctx);
      if (result.isError) {
        results.push({ ok: false, error: result.content });
      } else {
        try { results.push(JSON.parse(result.content)); }
        catch { results.push(result.content); }
      }
    }
    return results;
  }

  /** Resolve __batchRef markers in args using prior results. */
  private resolveRefs(value: unknown, results: unknown[]): Record<string, unknown> {
    return this.deepResolve(value, results) as Record<string, unknown>;
  }

  private deepResolve(value: unknown, results: unknown[]): unknown {
    if (value && typeof value === 'object' && '__batchRef' in (value as Record<string, unknown>)) {
      const ref = value as { __batchRef: number; path?: string };
      const resolved = results[ref.__batchRef];
      if (resolved && typeof resolved === 'object' && 'ok' in (resolved as Record<string, unknown>) && !(resolved as Record<string, unknown>).ok) {
        throw new Error(`Batch ref index ${ref.__batchRef} references a failed call`);
      }
      return ref.path ? this.evaluatePath(resolved, ref.path) : resolved;
    }
    if (Array.isArray(value)) return value.map(v => this.deepResolve(v, results));
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        out[k] = this.deepResolve(v, results);
      }
      return out;
    }
    return value;
  }

  private evaluatePath(value: unknown, path: string): unknown {
    if (!path) return value;
    const segments = path.match(/\.([^.[]+)|\[(\d+)\]/g);
    if (!segments) return value;
    let current: unknown = value;
    for (const seg of segments) {
      if (current == null) return undefined;
      if (seg.startsWith('[')) {
        (current as unknown) = (current as unknown[])[parseInt(seg.slice(1, -1))];
      } else {
        (current as unknown) = (current as Record<string, unknown>)[seg.slice(1)];
      }
    }
    return current;
  }
}
```

**Step 4: Run tests**

Run: `npx vitest run tests/host/tool-dispatcher.test.ts`
Expected: All 5 tests PASS.

**Step 5: Commit**

```bash
git add src/host/tool-dispatcher.ts tests/host/tool-dispatcher.test.ts
git commit -m "feat: add ToolDispatcher — unified host-side tool dispatch"
```

---

## Task 3: Wire `ToolDispatcher` into `tool-batch.ts` and `tool-router.ts`

**Files:**
- Modify: `src/host/ipc-handlers/tool-batch.ts` — delegate to `ToolDispatcher.dispatchBatch()`
- Modify: `src/host/tool-router.ts` — delegate MCP calls to `ToolDispatcher.dispatch()`
- Modify: `src/host/ipc-server.ts` — pass dispatcher via options
- Modify: `src/host/server-completions.ts` — construct dispatcher once, pass to both
- Modify: `tests/host/tool-batch.test.ts` (if exists) — update for new wiring

**Step 1: Add `dispatcher` option to `ToolBatchOptions`**

In `src/host/ipc-handlers/tool-batch.ts`, add dispatcher as the preferred dispatch path. Keep `getProvider`/`resolveServer`/`mcpCallTool` as legacy fallback but have the handler prefer `dispatcher.dispatchBatch()` when available.

**Step 2: Add `dispatcher` option to `ToolRouterContext`**

In `src/host/tool-router.ts`, in `handleMcpToolCall()`, prefer `ctx.dispatcher?.dispatch()` over the inline MCP routing logic.

**Step 3: Run all tests**

Run: `npx vitest run tests/host/`
Expected: All host tests pass. The dispatcher is additive — existing paths still work when dispatcher is not provided.

**Step 4: Commit**

```bash
git add src/host/ipc-handlers/tool-batch.ts src/host/tool-router.ts src/host/ipc-server.ts
git commit -m "refactor: wire ToolDispatcher into tool-batch and tool-router"
```

---

## Task 4: Result persistence to `/tmp`

**Files:**
- Create: `src/host/result-persistence.ts`
- Create: `tests/host/result-persistence.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/host/result-persistence.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ResultPersistence } from '../../src/host/result-persistence.js';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initLogger } from '../../src/logger.js';

initLogger({ file: false, level: 'silent' });

describe('ResultPersistence', () => {
  let dir: string;
  let persistence: ResultPersistence;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ax-test-results-'));
    persistence = new ResultPersistence({ dir, thresholdBytes: 100 });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('passes through small results unchanged', () => {
    const result = persistence.maybeSpill('id-1', 'short result');
    expect(result).toBe('short result');
  });

  it('spills large results to disk and returns preview', () => {
    const large = 'x'.repeat(200);
    const result = persistence.maybeSpill('id-2', large);
    expect(result).toContain('[Full output persisted');
    expect(result).toContain('id-2');
    // Verify file exists
    const filePath = join(dir, 'id-2.json');
    expect(readFileSync(filePath, 'utf-8')).toBe(large);
  });

  it('preview includes head and tail of content', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n');
    const result = persistence.maybeSpill('id-3', lines);
    expect(result).toContain('line 0');  // head
    expect(result).toContain('line 49'); // tail
  });

  it('enforces per-turn aggregate budget', () => {
    // First call: 80 bytes, under threshold (100), passes through
    const r1 = persistence.maybeSpill('id-4', 'a'.repeat(80));
    expect(r1).toBe('a'.repeat(80));

    // Second call: 80 bytes, aggregate now 160 > threshold
    // The aggregate check spills the largest accumulated result
    const r2 = persistence.maybeSpill('id-5', 'b'.repeat(80));
    // At least one of them should be spilled
    const total = r1.length + r2.length;
    expect(total).toBeLessThan(200); // previews are shorter than originals
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/host/result-persistence.test.ts`
Expected: FAIL — module not found.

**Step 3: Implement ResultPersistence**

```typescript
// src/host/result-persistence.ts
/**
 * Persists large tool results to /tmp, replacing them with short previews
 * in the LLM context. The agent can read_file the full result on demand.
 *
 * Two-layer defense:
 * 1. Per-result: results exceeding thresholdBytes → disk + preview
 * 2. Per-turn aggregate: total bytes across all results → spill largest
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getLogger } from '../logger.js';

const logger = getLogger().child({ component: 'result-persistence' });

const DEFAULT_THRESHOLD_BYTES = 100_000;   // 100KB per result
const DEFAULT_TURN_BUDGET_BYTES = 200_000; // 200KB aggregate per turn
const DEFAULT_PREVIEW_CHARS = 1_500;       // inline preview size
const DEFAULT_DIR = '/tmp/ax-results';

export interface ResultPersistenceOptions {
  dir?: string;
  thresholdBytes?: number;
  turnBudgetBytes?: number;
  previewChars?: number;
}

export class ResultPersistence {
  private readonly dir: string;
  private readonly threshold: number;
  private readonly turnBudget: number;
  private readonly previewChars: number;
  private turnTotal = 0;

  constructor(opts?: ResultPersistenceOptions) {
    this.dir = opts?.dir ?? DEFAULT_DIR;
    this.threshold = opts?.thresholdBytes ?? DEFAULT_THRESHOLD_BYTES;
    this.turnBudget = opts?.turnBudgetBytes ?? DEFAULT_TURN_BUDGET_BYTES;
    this.previewChars = opts?.previewChars ?? DEFAULT_PREVIEW_CHARS;
  }

  /**
   * Check if result should be spilled. Returns the original content or a
   * preview stub with a file path.
   */
  maybeSpill(id: string, content: string): string {
    const bytes = Buffer.byteLength(content);

    // Layer 1: per-result threshold
    if (bytes > this.threshold) {
      return this.spill(id, content);
    }

    // Layer 2: per-turn aggregate
    this.turnTotal += bytes;
    if (this.turnTotal > this.turnBudget) {
      return this.spill(id, content);
    }

    return content;
  }

  /** Reset per-turn accumulator (call at start of each agent turn). */
  resetTurn(): void {
    this.turnTotal = 0;
  }

  private spill(id: string, content: string): string {
    try {
      mkdirSync(this.dir, { recursive: true });
      const filePath = join(this.dir, `${id}.json`);
      writeFileSync(filePath, content, 'utf-8');
      logger.debug('result_spilled', { id, bytes: Buffer.byteLength(content), path: filePath });
      return this.buildPreview(content, filePath);
    } catch (err) {
      logger.warn('spill_failed', { id, error: (err as Error).message });
      // If spill fails, truncate inline rather than losing data
      return content.slice(0, this.previewChars) + `\n\n... [truncated, ${content.length} chars total]`;
    }
  }

  private buildPreview(content: string, filePath: string): string {
    const headSize = Math.floor(this.previewChars * 0.6);
    const tailSize = this.previewChars - headSize;
    const head = content.slice(0, headSize);
    const tail = content.slice(-tailSize);
    const omitted = content.length - headSize - tailSize;

    return (
      head +
      `\n\n... [${omitted.toLocaleString()} chars omitted] ...\n\n` +
      tail +
      `\n\n[Full output persisted to ${filePath} — use read_file to access. ID: ${filePath.split('/').pop()}]`
    );
  }
}
```

**Step 4: Run tests**

Run: `npx vitest run tests/host/result-persistence.test.ts`
Expected: All 4 tests PASS.

**Step 5: Wire into ToolDispatcher**

Add optional `persistence` field to `ToolDispatcherOptions`. In `dispatch()`, after getting the result content, call `persistence.maybeSpill(callId, content)` before returning.

**Step 6: Commit**

```bash
git add src/host/result-persistence.ts tests/host/result-persistence.test.ts src/host/tool-dispatcher.ts
git commit -m "feat: add ResultPersistence — spill large tool results to /tmp"
```

---

## Task 5: Toolgen module codegen (PTC model)

**Files:**
- Modify: `src/host/toolgen/codegen.ts` — add `generateModule()` alongside existing `generateCLI()`
- Create: `tests/host/toolgen/module-codegen.test.ts`

This is the core of the PTC model. Instead of CLI executables, generate importable TypeScript modules with typed async functions.

**Step 1: Write the failing test**

```typescript
// tests/host/toolgen/module-codegen.test.ts
import { describe, it, expect } from 'vitest';
import { generateModule, generateIndex } from '../../../src/host/toolgen/codegen.js';
import { initLogger } from '../../../src/logger.js';

initLogger({ file: false, level: 'silent' });

describe('generateModule', () => {
  it('generates an importable JS module with async functions', () => {
    const result = generateModule('linear', [
      {
        name: 'list_issues',
        description: 'List issues with optional filters',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Filter query' },
            limit: { type: 'number', description: 'Max results' },
          },
        },
      },
      {
        name: 'create_issue',
        description: 'Create a new issue',
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            body: { type: 'string' },
            teamId: { type: 'string' },
          },
          required: ['title', 'teamId'],
        },
      },
    ]);

    // Should export named async functions
    expect(result).toContain('export async function listIssues');
    expect(result).toContain('export async function createIssue');
    // Should have JSDoc with descriptions
    expect(result).toContain('List issues with optional filters');
    expect(result).toContain('@param');
    // Should use IPC under the hood
    expect(result).toContain('tool_batch');
    expect(result).toContain('AX_HOST_URL');
    // Should be a valid JS module (no shebang)
    expect(result).not.toContain('#!/usr/bin/env');
  });

  it('converts snake_case tool names to camelCase function names', () => {
    const result = generateModule('github', [
      { name: 'get_pull_request', description: 'Get PR', inputSchema: { type: 'object', properties: { id: { type: 'number' } } } },
    ]);
    expect(result).toContain('export async function getPullRequest');
  });
});

describe('generateIndex', () => {
  it('generates a barrel file re-exporting all modules', () => {
    const result = generateIndex(['linear', 'github', 'stripe']);
    expect(result).toContain("export * as linear from './linear.js'");
    expect(result).toContain("export * as github from './github.js'");
    expect(result).toContain("export * as stripe from './stripe.js'");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/host/toolgen/module-codegen.test.ts`
Expected: FAIL — `generateModule` not exported.

**Step 3: Implement `generateModule()` and `generateIndex()`**

Add to `src/host/toolgen/codegen.ts`:

```typescript
/**
 * Convert snake_case to camelCase: list_issues → listIssues
 */
export function snakeToCamel(name: string): string {
  return name.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

/**
 * Generate a JSDoc block from tool description and input schema.
 */
function buildJSDoc(description: string, schema: Record<string, unknown>): string {
  const lines = [`/**`, ` * ${description}`];
  const props = (schema.properties ?? {}) as Record<string, { type?: string; description?: string }>;
  const required = new Set((schema.required ?? []) as string[]);
  for (const [name, prop] of Object.entries(props)) {
    const opt = required.has(name) ? '' : ' [optional]';
    const desc = prop.description ? ` — ${prop.description}` : '';
    lines.push(` * @param {${prop.type ?? 'unknown'}} ${name}${opt}${desc}`);
  }
  lines.push(` */`);
  return lines.join('\n');
}

/**
 * Generate an importable JS module for an MCP server's tools.
 * Each tool becomes a named async function that calls through IPC.
 */
export function generateModule(
  server: string,
  tools: McpToolSchema[],
): string {
  const functions = tools.map(tool => {
    const fnName = snakeToCamel(tool.name);
    const props = (tool.inputSchema?.properties ?? {}) as Record<string, unknown>;
    const paramNames = Object.keys(props);
    const jsDoc = buildJSDoc(tool.description ?? tool.name, tool.inputSchema ?? {});

    return `${jsDoc}
export async function ${fnName}(${paramNames.length ? 'params' : ''}) {
  return _call(${JSON.stringify(tool.name)}${paramNames.length ? ', params' : ', {}'});
}`;
  });

  return `// Auto-generated tool module for ${server}. Do not edit.
'use strict';

const _hostUrl = process.env.AX_HOST_URL;
const _token = process.env.AX_IPC_TOKEN;

async function _call(tool, params) {
  if (!_hostUrl) throw new Error('AX_HOST_URL not set');
  const res = await fetch(_hostUrl + '/internal/ipc', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(_token ? { Authorization: 'Bearer ' + _token } : {}),
    },
    body: JSON.stringify({ action: 'tool_batch', calls: [{ tool, args: params }] }),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + (await res.text()));
  const data = await res.json();
  const result = data.results?.[0];
  if (result && typeof result === 'object' && 'ok' in result && !result.ok) {
    throw new Error(result.error || 'tool call failed');
  }
  return result;
}

${functions.join('\n\n')}
`;
}

/**
 * Generate a barrel index.js that re-exports all server modules.
 */
export function generateIndex(servers: string[]): string {
  const exports = servers.map(s => `export * as ${s} from './${s}.js';`);
  return `// Auto-generated tool index. Do not edit.\n${exports.join('\n')}\n`;
}
```

**Step 4: Run tests**

Run: `npx vitest run tests/host/toolgen/module-codegen.test.ts`
Expected: All tests PASS.

**Step 5: Commit**

```bash
git add src/host/toolgen/codegen.ts tests/host/toolgen/module-codegen.test.ts
git commit -m "feat: add generateModule() — PTC-style importable tool modules"
```

---

## Task 6: Compact tool index for system prompt

**Files:**
- Modify: `src/host/toolgen/codegen.ts` — add `generateCompactIndex()`
- Modify: `src/agent/prompt/modules/runtime.ts` — replace CLI listing with compact index
- Modify: `src/agent/prompt/types.ts` — change `mcpCLIs?: string[]` to `toolModules?: ToolModuleSummary[]`
- Create: `tests/host/toolgen/compact-index.test.ts`

This generates the compact one-line-per-function summary for the system prompt.

**Step 1: Write the failing test**

```typescript
// tests/host/toolgen/compact-index.test.ts
import { describe, it, expect } from 'vitest';
import { generateCompactIndex } from '../../../src/host/toolgen/codegen.js';
import { initLogger } from '../../../src/logger.js';

initLogger({ file: false, level: 'silent' });

describe('generateCompactIndex', () => {
  it('generates one-line-per-server compact summary', () => {
    const result = generateCompactIndex([
      {
        server: 'linear',
        tools: [
          { name: 'list_issues', description: 'List issues', inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } } } },
          { name: 'create_issue', description: 'Create issue', inputSchema: { type: 'object', properties: { title: { type: 'string' }, teamId: { type: 'string' } }, required: ['title', 'teamId'] } },
        ],
      },
    ]);

    expect(result).toContain('linear:');
    expect(result).toContain('listIssues(query?, limit?)');
    expect(result).toContain('createIssue(title, teamId)');
  });

  it('marks required params without ? suffix', () => {
    const result = generateCompactIndex([{
      server: 'stripe',
      tools: [
        { name: 'get_invoice', description: 'Get invoice', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
      ],
    }]);

    expect(result).toContain('getInvoice(id)');
    expect(result).not.toContain('id?');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/host/toolgen/compact-index.test.ts`
Expected: FAIL — `generateCompactIndex` not exported.

**Step 3: Implement `generateCompactIndex()`**

Add to `src/host/toolgen/codegen.ts`:

```typescript
/**
 * Generate a compact one-line-per-server summary for the system prompt.
 * Minimizes token cost while giving the LLM enough info to write scripts.
 *
 * Output example:
 *   linear: listIssues(query?, limit?), createIssue(title, teamId)
 *   stripe: getInvoice(id), listInvoices(customer?)
 */
export function generateCompactIndex(groups: ToolStubGroup[]): string {
  return groups.map(group => {
    const fns = group.tools.map(tool => {
      const fnName = snakeToCamel(tool.name);
      const props = (tool.inputSchema?.properties ?? {}) as Record<string, unknown>;
      const required = new Set((tool.inputSchema?.required ?? []) as string[]);
      const params = Object.keys(props)
        .map(p => required.has(p) ? p : `${p}?`)
        .join(', ');
      return `${fnName}(${params})`;
    });
    return `  ${group.server}: ${fns.join(', ')}`;
  }).join('\n');
}
```

**Step 4: Run tests**

Run: `npx vitest run tests/host/toolgen/compact-index.test.ts`
Expected: All tests PASS.

**Step 5: Update prompt module**

In `src/agent/prompt/types.ts`, change the field from `mcpCLIs?: string[]` to also support the new format. In `src/agent/prompt/modules/runtime.ts`, replace the CLI listing with the compact index when tool modules are available.

**Step 6: Commit**

```bash
git add src/host/toolgen/codegen.ts tests/host/toolgen/compact-index.test.ts src/agent/prompt/modules/runtime.ts src/agent/prompt/types.ts
git commit -m "feat: add compact tool index for system prompt"
```

---

## Task 7: `execute_script` tool

**Files:**
- Modify: `src/agent/tool-catalog.ts` — add `execute_script` tool spec
- Modify: `src/ipc-schemas.ts` — add `execute_script` IPC action schema
- Create: `src/host/ipc-handlers/execute-script.ts` — host-side handler (no-op for now; agent executes locally)
- Modify: `src/agent/ipc-tools.ts` — add local execution for `execute_script`
- Modify: `src/agent/mcp-server.ts` — add `execute_script` MCP tool
- Create: `tests/agent/execute-script.test.ts`

The `execute_script` tool runs a Node.js script in the sandbox. The script can `import` tool modules from `/workspace/tools/`. Only `stdout` enters context — intermediate tool call results stay local to the script.

**Step 1: Add to tool catalog**

In `src/agent/tool-catalog.ts`, add:

```typescript
  // ── Execute Script (PTC) ──
  {
    name: 'execute_script',
    label: 'Execute Script',
    description:
      'Run a JavaScript script with access to tool modules.\n\n' +
      'The script can import modules from /workspace/tools/ to call external tools ' +
      '(MCP servers, APIs). Only the script\'s stdout output is returned — ' +
      'intermediate tool calls do NOT enter your context window.\n\n' +
      'Use this for multi-step tool pipelines instead of calling tools individually.\n\n' +
      'Example:\n' +
      '```\n' +
      'import { listIssues } from \'/workspace/tools/linear.js\';\n' +
      'const bugs = await listIssues({ query: \'bug\', limit: 5 });\n' +
      'console.log(JSON.stringify(bugs, null, 2));\n' +
      '```\n\n' +
      'IMPORTANT: Use console.log() for output. Only stdout is captured.',
    parameters: Type.Object({
      code: Type.String({ description: 'JavaScript code to execute. Can import from /workspace/tools/.' }),
      timeoutMs: Type.Optional(Type.Number({ description: 'Execution timeout in ms (default: 30000, max: 120000)' })),
    }),
    category: 'sandbox',
    timeoutMs: 120_000,
    singletonAction: 'execute_script',
  },
```

**Step 2: Add IPC schema**

In `src/ipc-schemas.ts`, add:

```typescript
export const ExecuteScriptSchema = ipcAction('execute_script', {
  code: safeString(500_000),
  timeoutMs: z.number().int().min(1000).max(120_000).optional(),
});
```

**Step 3: Implement local execution in ipc-tools.ts and mcp-server.ts**

In the agent's local sandbox handling (both `ipc-tools.ts` and `mcp-server.ts`), when `execute_script` is called:

1. Write `code` to a temp file in `/tmp/ax-script-<random>.mjs`
2. Spawn `node /tmp/ax-script-<random>.mjs` with the sandbox workspace as cwd
3. Capture stdout (capped at 50KB with head+tail truncation)
4. Return stdout as the tool result
5. Clean up temp file

For subprocess sandbox mode, route through IPC to the host which executes via the sandbox tools handler.

**Step 4: Write test**

```typescript
// tests/agent/execute-script.test.ts
import { describe, it, expect } from 'vitest';
import { initLogger } from '../../src/logger.js';

initLogger({ file: false, level: 'silent' });

describe('execute_script tool spec', () => {
  it('is defined in tool catalog', async () => {
    const { TOOL_CATALOG } = await import('../../src/agent/tool-catalog.js');
    const spec = TOOL_CATALOG.find(t => t.name === 'execute_script');
    expect(spec).toBeDefined();
    expect(spec!.category).toBe('sandbox');
    expect(spec!.singletonAction).toBe('execute_script');
  });
});
```

**Step 5: Run tests**

Run: `npx vitest run tests/agent/execute-script.test.ts`
Expected: PASS.

**Step 6: Commit**

```bash
git add src/agent/tool-catalog.ts src/ipc-schemas.ts src/agent/ipc-tools.ts src/agent/mcp-server.ts tests/agent/execute-script.test.ts
git commit -m "feat: add execute_script tool for PTC-style multi-tool scripts"
```

---

## Task 8: Update `generate-and-cache.ts` to produce modules

**Files:**
- Modify: `src/host/toolgen/generate-and-cache.ts` — generate modules + index instead of CLIs
- Modify: `src/host/server-completions.ts` — pass module files + compact index in stdin payload
- Modify: `src/agent/runner.ts` — write modules to `/workspace/tools/` instead of `/workspace/bin/`
- Modify: `src/agent/agent-setup.ts` — scan `/workspace/tools/` for module names
- Modify: `tests/host/toolgen/generate-and-cache.test.ts` — update expectations

**Step 1: Update `prepareMcpCLIs` → `prepareToolModules`**

Rename and update `src/host/toolgen/generate-and-cache.ts`:

```typescript
export interface PrepareToolModulesOptions {
  agentName: string;
  tools: McpToolSchema[];
}

export interface ToolModulePayload {
  /** Module files to write to /workspace/tools/ */
  files: ToolStubFile[];
  /** Compact index for system prompt */
  compactIndex: string;
}

export async function prepareToolModules(
  opts: PrepareToolModulesOptions,
): Promise<ToolModulePayload | null> {
  const { tools } = opts;
  if (tools.length === 0) return null;

  const groups = groupToolsByServer(tools);
  const files: ToolStubFile[] = [];

  for (const group of groups) {
    const content = generateModule(group.server, group.tools);
    files.push({ path: `${group.server}.js`, content });
  }

  // Generate barrel index
  const serverNames = groups.map(g => g.server);
  files.push({ path: 'index.js', content: generateIndex(serverNames) });

  const compactIndex = generateCompactIndex(groups);

  return files.length > 0 ? { files, compactIndex } : null;
}

// Keep old function for backward compat during migration
export { prepareMcpCLIs };
```

**Step 2: Update stdin payload**

In `src/host/server-completions.ts`, change `mcpCLIsPayload` to `toolModulesPayload` and include the compact index. In `src/agent/runner.ts`, write to `/workspace/tools/` instead of `/workspace/bin/`.

**Step 3: Update agent-setup.ts**

Change `scanMcpCLIs()` to `scanToolModules()` — scan `/workspace/tools/` for `.js` files, parse module names.

**Step 4: Update tests**

```typescript
// tests/host/toolgen/generate-and-cache.test.ts
describe('prepareToolModules', () => {
  it('generates module files + index + compact index', async () => {
    const tools: McpToolSchema[] = [
      { name: 'list_issues', description: 'List issues', inputSchema: { type: 'object', properties: { team: { type: 'string' } } }, server: 'linear' },
      { name: 'list_repos', description: 'List repos', inputSchema: { type: 'object', properties: {} }, server: 'github' },
    ];
    const result = await prepareToolModules({ agentName: 'test', tools });
    expect(result).not.toBeNull();
    expect(result!.files.find(f => f.path === 'linear.js')).toBeTruthy();
    expect(result!.files.find(f => f.path === 'github.js')).toBeTruthy();
    expect(result!.files.find(f => f.path === 'index.js')).toBeTruthy();
    expect(result!.compactIndex).toContain('linear:');
    expect(result!.compactIndex).toContain('github:');
  });
});
```

**Step 5: Run all tests**

Run: `npx vitest run tests/host/toolgen/`
Expected: All PASS.

**Step 6: Commit**

```bash
git add src/host/toolgen/ src/host/server-completions.ts src/agent/runner.ts src/agent/agent-setup.ts tests/host/toolgen/
git commit -m "feat: toolgen generates importable modules instead of CLIs"
```

---

## Task 9: OpenAPI spec → tool modules

**Files:**
- Create: `src/host/toolgen/openapi.ts` — parse OpenAPI spec → `McpToolSchema[]`
- Create: `tests/host/toolgen/openapi.test.ts`

This converts OpenAPI/Swagger specs into the same `McpToolSchema[]` format that MCP tools use, so they flow through the same toolgen pipeline.

**Step 1: Write the failing test**

```typescript
// tests/host/toolgen/openapi.test.ts
import { describe, it, expect } from 'vitest';
import { openApiToToolSchemas } from '../../../src/host/toolgen/openapi.js';
import { initLogger } from '../../../src/logger.js';

initLogger({ file: false, level: 'silent' });

describe('openApiToToolSchemas', () => {
  it('converts GET endpoints to tool schemas', () => {
    const spec = {
      openapi: '3.0.0',
      info: { title: 'Billing API', version: '1.0.0' },
      paths: {
        '/invoices': {
          get: {
            operationId: 'listInvoices',
            summary: 'List all invoices',
            parameters: [
              { name: 'customer', in: 'query', schema: { type: 'string' }, description: 'Filter by customer' },
              { name: 'limit', in: 'query', schema: { type: 'integer' }, description: 'Max results' },
            ],
          },
        },
      },
    };

    const tools = openApiToToolSchemas(spec, 'billing');
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('listInvoices');
    expect(tools[0].server).toBe('billing');
    expect(tools[0].description).toBe('List all invoices');
    expect(tools[0].inputSchema.properties).toHaveProperty('customer');
    expect(tools[0].inputSchema.properties).toHaveProperty('limit');
  });

  it('converts POST endpoints with request body', () => {
    const spec = {
      openapi: '3.0.0',
      info: { title: 'API', version: '1.0.0' },
      paths: {
        '/invoices': {
          post: {
            operationId: 'createInvoice',
            summary: 'Create invoice',
            requestBody: {
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      customer: { type: 'string' },
                      amount: { type: 'number' },
                    },
                    required: ['customer', 'amount'],
                  },
                },
              },
            },
          },
        },
      },
    };

    const tools = openApiToToolSchemas(spec, 'billing');
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('createInvoice');
    expect(tools[0].inputSchema.required).toEqual(['customer', 'amount']);
  });

  it('generates operationId from method + path when missing', () => {
    const spec = {
      openapi: '3.0.0',
      info: { title: 'API', version: '1.0.0' },
      paths: {
        '/users/{id}': {
          get: { summary: 'Get user by ID', parameters: [{ name: 'id', in: 'path', schema: { type: 'string' }, required: true }] },
        },
      },
    };

    const tools = openApiToToolSchemas(spec, 'users');
    expect(tools[0].name).toMatch(/get.*user/i);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/host/toolgen/openapi.test.ts`
Expected: FAIL — module not found.

**Step 3: Implement `openApiToToolSchemas()`**

```typescript
// src/host/toolgen/openapi.ts
/**
 * Convert an OpenAPI 3.x spec into McpToolSchema[] for the toolgen pipeline.
 *
 * Each operation (GET /invoices, POST /invoices, etc.) becomes one tool.
 * Query/path parameters + request body properties become the tool's inputSchema.
 */

import type { McpToolSchema } from '../../providers/mcp/types.js';

interface OpenApiSpec {
  paths: Record<string, Record<string, OpenApiOperation>>;
  [key: string]: unknown;
}

interface OpenApiOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  parameters?: OpenApiParam[];
  requestBody?: { content?: { 'application/json'?: { schema?: JsonSchema } } };
}

interface OpenApiParam {
  name: string;
  in: string;
  description?: string;
  required?: boolean;
  schema?: { type?: string; [key: string]: unknown };
}

interface JsonSchema {
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

/**
 * Generate an operationId from HTTP method + path when none is provided.
 * GET /users/{id} → getUsers_id
 */
function inferOperationId(method: string, path: string): string {
  const cleaned = path
    .replace(/\{([^}]+)\}/g, '_$1')
    .replace(/[^a-zA-Z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  return `${method}${cleaned.charAt(0).toUpperCase()}${cleaned.slice(1)}`;
}

export function openApiToToolSchemas(spec: OpenApiSpec, serverName: string): McpToolSchema[] {
  const tools: McpToolSchema[] = [];

  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const method of HTTP_METHODS) {
      const op = methods[method] as OpenApiOperation | undefined;
      if (!op) continue;

      const name = op.operationId ?? inferOperationId(method, path);
      const description = op.summary ?? op.description ?? `${method.toUpperCase()} ${path}`;

      // Merge parameters + request body into one inputSchema
      const properties: Record<string, unknown> = {};
      const required: string[] = [];

      // Query/path parameters
      for (const param of op.parameters ?? []) {
        properties[param.name] = {
          type: param.schema?.type ?? 'string',
          ...(param.description ? { description: param.description } : {}),
        };
        if (param.required) required.push(param.name);
      }

      // Request body (JSON)
      const bodySchema = op.requestBody?.content?.['application/json']?.schema;
      if (bodySchema?.properties) {
        Object.assign(properties, bodySchema.properties);
        if (bodySchema.required) required.push(...bodySchema.required);
      }

      tools.push({
        name,
        description,
        server: serverName,
        inputSchema: {
          type: 'object',
          properties,
          ...(required.length > 0 ? { required } : {}),
        },
      });
    }
  }

  return tools;
}
```

**Step 4: Run tests**

Run: `npx vitest run tests/host/toolgen/openapi.test.ts`
Expected: All tests PASS.

**Step 5: Commit**

```bash
git add src/host/toolgen/openapi.ts tests/host/toolgen/openapi.test.ts
git commit -m "feat: add OpenAPI spec → tool schema converter for toolgen"
```

---

## Task 10: Update runtime prompt module for PTC

**Files:**
- Modify: `src/agent/prompt/modules/runtime.ts` — replace CLI listing with PTC instructions
- Modify: `src/agent/prompt/types.ts` — update context type

**Step 1: Update PromptContext**

In `src/agent/prompt/types.ts`, add alongside existing `mcpCLIs`:

```typescript
  /** Tool module compact index for system prompt (replaces mcpCLIs). */
  toolModuleIndex?: string;
```

**Step 2: Update RuntimeModule.render()**

Replace the CLI listing block in `src/agent/prompt/modules/runtime.ts`:

```typescript
// New PTC block (preferred when toolModuleIndex is available)
...(ctx.toolModuleIndex ? [
  `  - /workspace/tools/ — importable tool modules`,
  `    Use execute_script to run multi-step scripts that import these modules.`,
  `    Available modules:`,
  ctx.toolModuleIndex,
  `    Read /workspace/tools/<module>.js for full function signatures.`,
  `    Only stdout from execute_script enters your context — intermediate results stay local.`,
] : []),
// Legacy CLI block (backward compat)
...(ctx.mcpCLIs?.length && !ctx.toolModuleIndex ? [
  `  - /workspace/bin/ — MCP tool CLIs (in PATH)`,
  `    Run \`<tool> --help\` for usage. Available: ${ctx.mcpCLIs.join(', ')}`,
] : []),
```

**Step 3: Run prompt tests**

Run: `npx vitest run tests/agent/prompt/`
Expected: Existing tests pass. The new block only appears when `toolModuleIndex` is set.

**Step 4: Commit**

```bash
git add src/agent/prompt/modules/runtime.ts src/agent/prompt/types.ts
git commit -m "feat: update system prompt for PTC-style tool modules"
```

---

## Task 11: End-to-end integration test

**Files:**
- Create: `tests/host/toolgen/e2e.test.ts`

**Step 1: Write integration test**

```typescript
// tests/host/toolgen/e2e.test.ts
import { describe, it, expect } from 'vitest';
import { prepareToolModules } from '../../../src/host/toolgen/generate-and-cache.js';
import { openApiToToolSchemas } from '../../../src/host/toolgen/openapi.js';
import type { McpToolSchema } from '../../../src/providers/mcp/types.js';
import { initLogger } from '../../../src/logger.js';

initLogger({ file: false, level: 'silent' });

describe('toolgen e2e', () => {
  it('MCP tools → modules + compact index', async () => {
    const mcpTools: McpToolSchema[] = [
      { name: 'list_issues', description: 'List issues', inputSchema: { type: 'object', properties: { query: { type: 'string' } } }, server: 'linear' },
      { name: 'create_issue', description: 'Create issue', inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] }, server: 'linear' },
    ];

    const result = await prepareToolModules({ agentName: 'test', tools: mcpTools });
    expect(result).not.toBeNull();

    // Module file has importable functions
    const linearModule = result!.files.find(f => f.path === 'linear.js');
    expect(linearModule).toBeDefined();
    expect(linearModule!.content).toContain('export async function listIssues');
    expect(linearModule!.content).toContain('export async function createIssue');

    // Compact index is prompt-ready
    expect(result!.compactIndex).toContain('linear:');
    expect(result!.compactIndex).toContain('listIssues(query?)');
    expect(result!.compactIndex).toContain('createIssue(title)');
  });

  it('OpenAPI spec → modules + compact index', async () => {
    const spec = {
      openapi: '3.0.0',
      info: { title: 'Billing', version: '1.0.0' },
      paths: {
        '/invoices': {
          get: {
            operationId: 'list_invoices',
            summary: 'List invoices',
            parameters: [{ name: 'customer', in: 'query', schema: { type: 'string' } }],
          },
        },
      },
    };

    const tools = openApiToToolSchemas(spec, 'billing');
    const result = await prepareToolModules({ agentName: 'test', tools });

    expect(result).not.toBeNull();
    const billingModule = result!.files.find(f => f.path === 'billing.js');
    expect(billingModule).toBeDefined();
    expect(billingModule!.content).toContain('export async function listInvoices');
    expect(result!.compactIndex).toContain('billing:');
  });
});
```

**Step 2: Run test**

Run: `npx vitest run tests/host/toolgen/e2e.test.ts`
Expected: All PASS.

**Step 3: Run full test suite**

Run: `npm test`
Expected: All tests pass. No regressions.

**Step 4: Commit**

```bash
git add tests/host/toolgen/e2e.test.ts
git commit -m "test: add toolgen e2e integration tests"
```

---

## Summary

| Task | What | Key Files |
|------|------|-----------|
| 1 | Rename capnweb → toolgen | `src/host/toolgen/`, `tests/host/toolgen/` |
| 2 | ToolDispatcher | `src/host/tool-dispatcher.ts` |
| 3 | Wire dispatcher into existing paths | `tool-batch.ts`, `tool-router.ts` |
| 4 | Result persistence to /tmp | `src/host/result-persistence.ts` |
| 5 | Module codegen (PTC) | `src/host/toolgen/codegen.ts` |
| 6 | Compact prompt index | `src/host/toolgen/codegen.ts`, `runtime.ts` |
| 7 | execute_script tool | `tool-catalog.ts`, `ipc-schemas.ts` |
| 8 | Generate modules instead of CLIs | `generate-and-cache.ts`, `server-completions.ts` |
| 9 | OpenAPI → tool schemas | `src/host/toolgen/openapi.ts` |
| 10 | Update prompt for PTC | `runtime.ts`, `types.ts` |
| 11 | E2E integration test | `tests/host/toolgen/e2e.test.ts` |

Tasks 1-4 can be done independently. Tasks 5-6 depend on each other. Task 7 is independent. Tasks 8 depends on 5+6. Task 9 is independent (uses same McpToolSchema interface). Task 10 depends on 6+8. Task 11 depends on all prior tasks.
