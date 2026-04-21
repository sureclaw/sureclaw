# Tool Dispatch Unification Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the `.ax/tools/<skill>/*.js` codegen + script-import pipeline with a unified tool catalog, where MCP and OpenAPI tools become first-class agent tools dispatched via two meta-tools (`describe_tools`, `call_tool`) in `indirect` mode or direct `tools[]` entries in `direct` mode.

**Architecture:** One `CatalogTool` record per MCP/OpenAPI operation, built at session start, shipped to the agent via stdin. Dispatch modes configured in `ax.yaml`. Every tool response flows through optional `_select` jq projection + auto-spill at 20KB. Built-in tools (`bash`, `read_file`, etc.) stay as-is.

**Tech Stack:** TypeScript, Zod for IPC schemas, Vitest for tests, `node-jq` or embedded jq binary for projection, existing `mcp-client.ts` for MCP dispatch.

**Source design:** `docs/plans/2026-04-19-tool-dispatch-unification-design.md`

---

## Preamble for the implementer

You've inherited a week's worth of fix-the-next-symptom machinery in tool dispatch. The design doc explains why. Resist the urge to "preserve" the existing codegen pipeline's cleverness — the whole point of this migration is that the complexity of generating, syncing, rendering, guarding, and parsing script-imported JS stubs was papering over a structural mismatch. Delete aggressively when the plan says delete.

**Workflow rules (from CLAUDE.md):**
- **Journal every meaningful commit** to `.claude/journal/<category>/<file>.md` BEFORE committing.
- **Log lessons learned** to `.claude/lessons/<category>/<file>.md` when you discover something non-obvious.
- **Bug-fix-with-test discipline**: if you fix a bug the tests missed, add the test that would have caught it.
- Use `.claude/skills/ax/*` sub-skills (`ax-agent`, `ax-host`, `ax-ipc`, etc.) when you need architecture context for a subsystem.

**Branch:** create `feat/tool-dispatch-unification` before starting. Don't work on main.

---

## Phase 0: Setup

### Task 0.1: Create feature branch

**Step 1: Confirm clean working tree**

```bash
git status
```

Expected: no uncommitted changes relevant to this work. Ignore unrelated `.claude/journal/*` or doc scratch files.

**Step 2: Create branch**

```bash
git checkout -b feat/tool-dispatch-unification
```

**Step 3: Verify tests pass before changing anything**

```bash
npm run build && npm test
```

Expected: all green. If not, stop and ask — starting from red means we can't distinguish our regressions from pre-existing ones.

---

## Phase 1: Catalog types and registry (rollout step 1)

**Goal of phase:** Pure data layer. No dispatch yet, no prompt changes, no IPC. Just the `CatalogTool` type, a host-side registry, and tests.

### Task 1.1: Define `CatalogTool` shape + registry type

**Files:**
- Create: `src/host/tool-catalog/types.ts`
- Create: `tests/host/tool-catalog/types.test.ts`

**Step 1: Write the failing test**

```ts
// tests/host/tool-catalog/types.test.ts
import { describe, test, expect } from 'vitest';
import { validateCatalogTool } from '../../../src/host/tool-catalog/types.js';

describe('CatalogTool validation', () => {
  test('accepts a minimal MCP catalog tool', () => {
    const tool = {
      name: 'mcp_linear_list_issues',
      skill: 'linear',
      summary: 'List Linear issues',
      schema: { type: 'object', properties: { team: { type: 'string' } } },
      dispatch: { kind: 'mcp' as const, server: 'linear', toolName: 'list_issues' },
    };
    expect(() => validateCatalogTool(tool)).not.toThrow();
  });

  test('rejects a tool without a name', () => {
    expect(() => validateCatalogTool({ skill: 'linear' })).toThrow(/name/);
  });

  test('rejects unknown dispatch kinds', () => {
    const bad = {
      name: 'foo', skill: 'x', summary: 's',
      schema: { type: 'object' },
      dispatch: { kind: 'bogus', target: 'nope' },
    };
    expect(() => validateCatalogTool(bad as never)).toThrow(/dispatch/);
  });
});
```

**Step 2: Run to verify it fails**

Run: `npx vitest run tests/host/tool-catalog/types.test.ts`
Expected: FAIL with `Cannot find module` or similar.

**Step 3: Implement the types**

```ts
// src/host/tool-catalog/types.ts
import { z } from 'zod';

const JsonSchemaLiteral = z.record(z.unknown());

const McpDispatch = z.object({
  kind: z.literal('mcp'),
  server: z.string().min(1),
  toolName: z.string().min(1),
});

const OpenApiDispatch = z.object({
  kind: z.literal('openapi'),
  baseUrl: z.string().url(),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  path: z.string().min(1),
  operationId: z.string().min(1),
  credential: z.string().optional(),
  authScheme: z.enum(['bearer', 'basic', 'api_key_header', 'api_key_query']).optional(),
});

export const CatalogToolSchema = z.object({
  name: z.string().regex(/^(mcp|api)_[a-z0-9_]+$/),
  skill: z.string().min(1),
  summary: z.string().min(1),
  schema: JsonSchemaLiteral,
  dispatch: z.discriminatedUnion('kind', [McpDispatch, OpenApiDispatch]),
}).strict();

export type CatalogTool = z.infer<typeof CatalogToolSchema>;

export function validateCatalogTool(input: unknown): CatalogTool {
  return CatalogToolSchema.parse(input);
}
```

**Step 4: Run to verify it passes**

Run: `npx vitest run tests/host/tool-catalog/types.test.ts`
Expected: PASS, 3/3.

**Step 5: Commit**

```bash
git add src/host/tool-catalog/types.ts tests/host/tool-catalog/types.test.ts
git commit -m "feat(tool-catalog): add CatalogTool type + validator"
```

**Journal:** append to `.claude/journal/host/tool-catalog.md` (create if needed).

---

### Task 1.2: Build a session-scoped catalog registry

**Files:**
- Create: `src/host/tool-catalog/registry.ts`
- Create: `tests/host/tool-catalog/registry.test.ts`

**Step 1: Write the failing test**

```ts
// tests/host/tool-catalog/registry.test.ts
import { describe, test, expect, beforeEach } from 'vitest';
import { ToolCatalog } from '../../../src/host/tool-catalog/registry.js';
import type { CatalogTool } from '../../../src/host/tool-catalog/types.js';

const toolA: CatalogTool = {
  name: 'mcp_linear_list_issues', skill: 'linear', summary: 'List issues',
  schema: { type: 'object' },
  dispatch: { kind: 'mcp', server: 'linear', toolName: 'list_issues' },
};

describe('ToolCatalog', () => {
  let catalog: ToolCatalog;
  beforeEach(() => { catalog = new ToolCatalog(); });

  test('registers and retrieves a tool by name', () => {
    catalog.register(toolA);
    expect(catalog.get('mcp_linear_list_issues')).toEqual(toolA);
  });

  test('rejects duplicate names', () => {
    catalog.register(toolA);
    expect(() => catalog.register(toolA)).toThrow(/already registered/);
  });

  test('lists all tools in insertion order', () => {
    catalog.register(toolA);
    catalog.register({ ...toolA, name: 'mcp_linear_get_team', dispatch: { ...toolA.dispatch, toolName: 'get_team' } });
    expect(catalog.list().map(t => t.name)).toEqual(['mcp_linear_list_issues', 'mcp_linear_get_team']);
  });

  test('lists tools filtered by skill', () => {
    catalog.register(toolA);
    catalog.register({ ...toolA, name: 'mcp_stripe_foo', skill: 'stripe' });
    expect(catalog.listBySkill('linear').map(t => t.name)).toEqual(['mcp_linear_list_issues']);
  });

  test('freeze prevents further registration', () => {
    catalog.register(toolA);
    catalog.freeze();
    expect(() => catalog.register({ ...toolA, name: 'mcp_other_x' })).toThrow(/frozen/);
  });
});
```

**Step 2: Run to verify it fails**

Run: `npx vitest run tests/host/tool-catalog/registry.test.ts`
Expected: FAIL.

**Step 3: Implement**

```ts
// src/host/tool-catalog/registry.ts
import { validateCatalogTool, type CatalogTool } from './types.js';

export class ToolCatalog {
  private tools = new Map<string, CatalogTool>();
  private frozen = false;

  register(input: CatalogTool): void {
    if (this.frozen) throw new Error(`ToolCatalog is frozen — cannot register ${input.name}`);
    const tool = validateCatalogTool(input);
    if (this.tools.has(tool.name)) throw new Error(`Tool ${tool.name} already registered`);
    this.tools.set(tool.name, tool);
  }

  get(name: string): CatalogTool | undefined {
    return this.tools.get(name);
  }

  list(): CatalogTool[] {
    return [...this.tools.values()];
  }

  listBySkill(skill: string): CatalogTool[] {
    return this.list().filter(t => t.skill === skill);
  }

  freeze(): void { this.frozen = true; }
}
```

**Step 4: Run to verify**

Run: `npx vitest run tests/host/tool-catalog/registry.test.ts`
Expected: PASS, 5/5.

**Step 5: Commit**

```bash
git add src/host/tool-catalog/registry.ts tests/host/tool-catalog/registry.test.ts
git commit -m "feat(tool-catalog): add session-scoped ToolCatalog registry"
```

---

### Task 1.3: Add one-liner render helper

**Files:**
- Create: `src/host/tool-catalog/render.ts`
- Create: `tests/host/tool-catalog/render.test.ts`

**Step 1: Write the failing test**

```ts
// tests/host/tool-catalog/render.test.ts
import { describe, test, expect } from 'vitest';
import { renderCatalogOneLiners } from '../../../src/host/tool-catalog/render.js';
import { ToolCatalog } from '../../../src/host/tool-catalog/registry.js';

describe('renderCatalogOneLiners', () => {
  test('groups tools by skill and renders one-liners', () => {
    const catalog = new ToolCatalog();
    catalog.register({
      name: 'mcp_linear_list_issues', skill: 'linear', summary: 'List issues',
      schema: { type: 'object', properties: { team: { type: 'string' }, state: { type: 'string' } }, required: ['team'] },
      dispatch: { kind: 'mcp', server: 'linear', toolName: 'list_issues' },
    });
    catalog.register({
      name: 'mcp_linear_get_team', skill: 'linear', summary: 'Find a team',
      schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      dispatch: { kind: 'mcp', server: 'linear', toolName: 'get_team' },
    });
    const out = renderCatalogOneLiners(catalog);
    expect(out).toContain('### linear');
    expect(out).toContain('- mcp_linear_list_issues(team, state?) — List issues');
    expect(out).toContain('- mcp_linear_get_team(query) — Find a team');
  });

  test('returns empty string for empty catalog', () => {
    expect(renderCatalogOneLiners(new ToolCatalog())).toBe('');
  });
});
```

**Step 2: Run to verify it fails**

Run: `npx vitest run tests/host/tool-catalog/render.test.ts`
Expected: FAIL.

**Step 3: Implement**

```ts
// src/host/tool-catalog/render.ts
import type { CatalogTool } from './types.js';
import { ToolCatalog } from './registry.js';

export function renderCatalogOneLiners(catalog: ToolCatalog): string {
  const tools = catalog.list();
  if (tools.length === 0) return '';

  const bySkill = new Map<string, CatalogTool[]>();
  for (const t of tools) {
    const arr = bySkill.get(t.skill) ?? [];
    arr.push(t);
    bySkill.set(t.skill, arr);
  }

  const lines: string[] = ['## Available tools', ''];
  for (const [skill, group] of bySkill) {
    lines.push(`### ${skill}`);
    for (const t of group) {
      const props = (t.schema.properties as Record<string, unknown>) ?? {};
      const required = new Set(Array.isArray(t.schema.required) ? t.schema.required as string[] : []);
      const params = Object.keys(props).map(p => required.has(p) ? p : `${p}?`).concat('_select?').join(', ');
      lines.push(`- ${t.name}(${params}) — ${t.summary}`);
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}
```

**Step 4: Run to verify**

Run: `npx vitest run tests/host/tool-catalog/render.test.ts`
Expected: PASS, 2/2.

**Step 5: Commit**

```bash
git add src/host/tool-catalog/render.ts tests/host/tool-catalog/render.test.ts
git commit -m "feat(tool-catalog): add one-liner prompt render"
```

---

## Phase 2: MCP adapter + catalog population (rollout step 2)

**Goal of phase:** When a skill with `mcpServers:` is activated, its tools populate the catalog. Existing `.ax/tools/` generation stays running — new path runs in parallel. No agent-facing behavior change yet.

### Task 2.1: Write the MCP adapter

**Files:**
- Create: `src/host/tool-catalog/adapters/mcp.ts`
- Create: `tests/host/tool-catalog/adapters/mcp.test.ts`

**Step 1: Write the failing test**

```ts
// tests/host/tool-catalog/adapters/mcp.test.ts
import { describe, test, expect } from 'vitest';
import { buildMcpCatalogTools } from '../../../../src/host/tool-catalog/adapters/mcp.js';

describe('buildMcpCatalogTools', () => {
  test('maps MCP tools to CatalogTool entries', () => {
    const mcpTools = [
      { name: 'list_issues', description: 'List issues in a cycle', inputSchema: { type: 'object', properties: { team: { type: 'string' } } } },
      { name: 'get_team', description: 'Find a team by name', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
    ];
    const result = buildMcpCatalogTools({ skill: 'linear', server: 'linear', tools: mcpTools });
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      name: 'mcp_linear_list_issues',
      skill: 'linear',
      summary: 'List issues in a cycle',
      dispatch: { kind: 'mcp', server: 'linear', toolName: 'list_issues' },
    });
  });

  test('applies include glob filter', () => {
    const mcpTools = [
      { name: 'list_issues', inputSchema: { type: 'object' } },
      { name: 'delete_issue', inputSchema: { type: 'object' } },
    ];
    const result = buildMcpCatalogTools({ skill: 'linear', server: 'linear', tools: mcpTools, include: ['list_*'] });
    expect(result.map(r => r.name)).toEqual(['mcp_linear_list_issues']);
  });

  test('falls back to name when description is missing', () => {
    const mcpTools = [{ name: 'ping', inputSchema: { type: 'object' } }];
    const result = buildMcpCatalogTools({ skill: 'demo', server: 'demo', tools: mcpTools });
    expect(result[0].summary).toBe('ping');
  });
});
```

**Step 2: Run to verify it fails**

Run: `npx vitest run tests/host/tool-catalog/adapters/mcp.test.ts`
Expected: FAIL.

**Step 3: Implement**

```ts
// src/host/tool-catalog/adapters/mcp.ts
import { minimatch } from 'minimatch';
import type { CatalogTool } from '../types.js';

interface McpToolInput {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface BuildMcpCatalogToolsInput {
  skill: string;
  server: string;
  tools: McpToolInput[];
  include?: string[];
  exclude?: string[];
}

export function buildMcpCatalogTools(input: BuildMcpCatalogToolsInput): CatalogTool[] {
  const filtered = input.tools.filter(t => {
    if (input.include?.length && !input.include.some(g => minimatch(t.name, g))) return false;
    if (input.exclude?.length && input.exclude.some(g => minimatch(t.name, g))) return false;
    return true;
  });

  return filtered.map(t => ({
    name: `mcp_${input.skill}_${t.name}`,
    skill: input.skill,
    summary: t.description ?? t.name,
    schema: t.inputSchema ?? { type: 'object' },
    dispatch: { kind: 'mcp' as const, server: input.server, toolName: t.name },
  }));
}
```

**Step 4: Run to verify**

Run: `npx vitest run tests/host/tool-catalog/adapters/mcp.test.ts`
Expected: PASS, 3/3.

**Step 5: Commit**

```bash
git add src/host/tool-catalog/adapters/ tests/host/tool-catalog/adapters/
git commit -m "feat(tool-catalog): add MCP adapter with include/exclude filters"
```

---

### Task 2.2: Populate the catalog during skill activation

**Files:**
- Modify: `src/host/skills/mcp-registry-sync.ts` (the file that already registers MCP servers)
- Modify: `src/host/server.ts` or equivalent — wherever session state is bootstrapped, to hold a `ToolCatalog` per session
- Create: `tests/host/skills/catalog-population.test.ts`

**Pre-step: Read the current wiring**

Read `src/host/skills/mcp-registry-sync.ts:23-38` and whatever calls it. Identify where to add a "after servers are registered, populate catalog with their tools" hook. The registry-sync is idempotent per server — the catalog population should be too.

**Step 1: Write the failing integration test**

```ts
// tests/host/skills/catalog-population.test.ts
import { describe, test, expect, vi } from 'vitest';
import { ToolCatalog } from '../../../src/host/tool-catalog/registry.js';
import { populateCatalogFromSkills } from '../../../src/host/skills/catalog-population.js';

describe('populateCatalogFromSkills', () => {
  test('populates catalog from skill snapshot MCP servers', async () => {
    const mcpClient = {
      listTools: vi.fn().mockResolvedValue([
        { name: 'list_issues', description: 'List', inputSchema: { type: 'object' } },
      ]),
    };
    const catalog = new ToolCatalog();
    await populateCatalogFromSkills({
      skills: [{ name: 'linear', frontmatter: { mcpServers: [{ name: 'linear' }] } } as never],
      getMcpClient: () => mcpClient as never,
      catalog,
    });
    expect(catalog.list()).toHaveLength(1);
    expect(catalog.get('mcp_linear_list_issues')).toBeDefined();
  });

  test('applies include filter from frontmatter', async () => {
    const mcpClient = {
      listTools: vi.fn().mockResolvedValue([
        { name: 'list_issues', inputSchema: {} },
        { name: 'delete_issue', inputSchema: {} },
      ]),
    };
    const catalog = new ToolCatalog();
    await populateCatalogFromSkills({
      skills: [{ name: 'linear', frontmatter: { mcpServers: [{ name: 'linear', include: ['list_*'] }] } } as never],
      getMcpClient: () => mcpClient as never,
      catalog,
    });
    expect(catalog.list().map(t => t.name)).toEqual(['mcp_linear_list_issues']);
  });
});
```

**Step 2: Run to verify it fails**

Run: `npx vitest run tests/host/skills/catalog-population.test.ts`
Expected: FAIL.

**Step 3: Implement** — create `src/host/skills/catalog-population.ts` with a `populateCatalogFromSkills({skills, getMcpClient, catalog})` function that iterates skills → servers → `listTools()` → `buildMcpCatalogTools()` → `catalog.register()`. Wrap each server's population in a try/catch so one bad server doesn't break the rest. Log failures.

**Step 4: Run to verify**

Run: `npx vitest run tests/host/skills/catalog-population.test.ts`
Expected: PASS.

**Step 5: Wire into the session bootstrap** — find where `registerMcpServersFromSnapshot` is called at agent-spawn time (host/server.ts or server-completions.ts). Right after MCP servers are registered, call `populateCatalogFromSkills` and `catalog.freeze()`. Attach the `ToolCatalog` to the session object so IPC handlers can reach it.

**Step 6: Add a session-level test**

```ts
// tests/host/server-session.test.ts — extend if exists, otherwise new
test('new session populates catalog from active skills', async () => {
  // Drive an agent spawn; assert session.catalog.list() contains expected MCP tools
});
```

**Step 7: Commit**

```bash
git add -A
git commit -m "feat(tool-catalog): populate from MCP servers at session start"
```

**Journal:** note the "parallel path" state — both `.ax/tools/` codegen and catalog population run now. Agent still uses the old path.

---

### Task 2.3: Ship the catalog to the agent via stdin payload

**Files:**
- Modify: `src/agent/runner.ts` — `AgentConfig` interface + `applyPayload()`
- Modify: `src/host/server-completions.ts` — agent-spawn payload construction
- Modify: `tests/agent/agent-setup.test.ts` (already exists, add cases)

**Pre-step:** Read `src/agent/runner.ts:39-74` (AgentConfig) and `src/agent/runner.ts:401` (applyPayload).

**Step 1: Add `catalog?: CatalogTool[]` to `AgentConfig`**

Import types from `src/host/tool-catalog/types.ts` into a shared location (move the types file to `src/types/catalog.ts` if it would create a host→agent import — agent MUST NOT import from `src/host/`). Likely action: move `src/host/tool-catalog/types.ts` to `src/types/catalog.ts`, re-export from the original path, and import from `src/types/catalog.ts` on the agent side.

**Step 2: Modify server-completions.ts to serialize the catalog into the stdin payload**

Pass `catalog.list()` under `catalog:` key in the JSON sent via stdin.

**Step 3: Write test verifying the agent receives the catalog**

```ts
test('agent receives catalog in stdin payload', async () => {
  const config: AgentConfig = {
    ipcSocket: '/tmp/test.sock', workspace: '/tmp', skills: [],
    catalog: [{ name: 'mcp_linear_x', skill: 'linear', summary: 's', schema: { type: 'object' }, dispatch: { kind: 'mcp', server: 'linear', toolName: 'x' } }],
  };
  const result = buildSystemPrompt(config);
  expect(result.systemPrompt).toContain('mcp_linear_x');
});
```

**Step 4: Commit**

```bash
git add -A
git commit -m "feat(tool-catalog): ship catalog to agent via stdin payload"
```

---

### Task 2.4: Render catalog in system prompt (behind config flag)

**Files:**
- Create: `src/agent/prompt/modules/tool-catalog.ts`
- Modify: `src/agent/prompt/builder.ts` — register new module
- Modify: `src/agent/agent-setup.ts` — pass catalog through
- Create: `tests/agent/prompt/modules/tool-catalog.test.ts`

**Step 1: Test first**

```ts
test('renders Available tools section when catalog is present', () => {
  const ctx = makeCtx({ catalog: [{ name: 'mcp_linear_x', skill: 'linear', summary: 's', schema: { type: 'object' }, dispatch: { kind: 'mcp', server: 'linear', toolName: 'x' } }] });
  const module = makeToolCatalogModule();
  expect(module.render(ctx)).toContain('mcp_linear_x');
});

test('renders empty string when catalog is empty or missing', () => {
  const ctx = makeCtx({ catalog: [] });
  expect(makeToolCatalogModule().render(ctx)).toBe('');
});
```

**Step 2: Implement module.** Use `renderCatalogOneLiners` from phase 1 — but note that lives in `src/host/`. Either (a) move to `src/shared/` or (b) duplicate the small render function on the agent side. Prefer (a). The module wraps a newly-instantiated `ToolCatalog` from the incoming array, then renders.

**Step 3: Register in builder.**

**Step 4: Plumb ctx.catalog through from `buildSystemPrompt(config)` — `config.catalog`.**

**Step 5: Commit**

```bash
git commit -m "feat(tool-catalog): render one-liner catalog in agent system prompt"
```

**Important:** at this stage, the catalog block appears in the prompt *in addition to* the existing `.ax/tools/` block from `tool-index-loader.ts`. That's intentional during the migration. Agent won't know what to do with catalog tools yet — they have no dispatch path. Next phase adds one.

---

## Phase 3: `describe_tools` + `call_tool` IPC handlers (rollout step 3)

**Goal of phase:** Agent can dispatch catalog tools via two new IPC actions, gated by `tool_dispatch.mode: indirect` in config.

### Task 3.1: Add `tool_dispatch` config shape

**Files:**
- Modify: `src/types.ts` (Config interface)
- Modify: `src/host/config.ts` or wherever defaults are applied
- Create: `tests/host/config/tool-dispatch.test.ts`

**Step 1: Test**

```ts
test('defaults tool_dispatch.mode to indirect', () => {
  const cfg = loadConfig({});
  expect(cfg.tool_dispatch.mode).toBe('indirect');
});

test('accepts direct | indirect', () => {
  expect(loadConfig({ tool_dispatch: { mode: 'direct' } }).tool_dispatch.mode).toBe('direct');
});

test('rejects unknown modes', () => {
  expect(() => loadConfig({ tool_dispatch: { mode: 'bogus' } })).toThrow();
});
```

**Step 2: Implement**

Add to Config interface:
```ts
tool_dispatch?: {
  mode: 'direct' | 'indirect';
  spill_threshold_bytes?: number;  // default 20480
};
```

Default applied in loader: `{ mode: 'indirect', spill_threshold_bytes: 20480 }`.

**Step 3: Commit**

```bash
git commit -m "feat(config): add tool_dispatch.mode + spill_threshold_bytes"
```

---

### Task 3.2: Define IPC schemas for `describe_tools` and `call_tool`

**Files:**
- Modify: `src/ipc-schemas.ts` — add two new actions via `ipcAction()` builder
- Create: `tests/ipc-schemas.test.ts` (or extend existing)

**Step 1: Test the schemas**

```ts
test('describe_tools schema accepts list of names', () => {
  const envelope = { action: 'describe_tools', requestId: 'r1', payload: { names: ['mcp_linear_x'] } };
  expect(() => IPCEnvelopeSchema.parse(envelope)).not.toThrow();
});

test('call_tool schema requires tool + args', () => {
  const envelope = { action: 'call_tool', requestId: 'r1', payload: { tool: 'mcp_linear_x', args: { team: 'p' } } };
  expect(() => IPCEnvelopeSchema.parse(envelope)).not.toThrow();
});

test('call_tool rejects missing args', () => {
  expect(() => IPCEnvelopeSchema.parse({ action: 'call_tool', requestId: 'r', payload: { tool: 'x' } })).toThrow();
});
```

**Step 2: Implement**

```ts
// src/ipc-schemas.ts — add new actions
export const DescribeToolsSchema = ipcAction('describe_tools', z.object({
  names: z.array(z.string()).min(1),
}).strict());

export const CallToolSchema = ipcAction('call_tool', z.object({
  tool: z.string(),
  args: z.record(z.unknown()),
}).strict());
```

**Step 3: Commit**

```bash
git commit -m "feat(ipc): add describe_tools + call_tool action schemas"
```

---

### Task 3.3: Implement `describe_tools` handler

**Files:**
- Create: `src/host/ipc-handlers/describe-tools.ts`
- Create: `tests/host/ipc-handlers/describe-tools.test.ts`

**Step 1: Test**

```ts
test('returns full schemas for named tools', async () => {
  const catalog = new ToolCatalog();
  catalog.register({ name: 'mcp_linear_x', skill: 'linear', summary: 'X', schema: { type: 'object', properties: { a: {} } }, dispatch: { kind: 'mcp', server: 'linear', toolName: 'x' } });
  const handler = createDescribeToolsHandler({ catalog });
  const result = await handler({ names: ['mcp_linear_x'] });
  expect(result).toEqual({ tools: [{ name: 'mcp_linear_x', summary: 'X', schema: expect.objectContaining({ type: 'object' }) }] });
});

test('returns an error block for unknown names', async () => {
  const handler = createDescribeToolsHandler({ catalog: new ToolCatalog() });
  const result = await handler({ names: ['mcp_nope_x'] });
  expect(result.unknown).toEqual(['mcp_nope_x']);
});
```

**Step 2: Implement** — handler takes `{names}`, returns `{tools: [{name, summary, schema}], unknown: [string]}`. Augments schema with `_select: {type: 'string', description: 'jq projection'}` before returning.

**Step 3: Wire into `src/host/ipc-server.ts` handler registration.**

**Step 4: Commit**

```bash
git commit -m "feat(ipc): implement describe_tools handler"
```

---

### Task 3.4: Implement `call_tool` handler (pass-through only, no projection yet)

**Files:**
- Create: `src/host/ipc-handlers/call-tool.ts`
- Create: `tests/host/ipc-handlers/call-tool.test.ts`

**Step 1: Test MCP dispatch**

```ts
test('dispatches MCP tool by catalog lookup', async () => {
  const mcpProvider = { callToolOnServer: vi.fn().mockResolvedValue({ issues: [{ id: 1 }] }) };
  const catalog = new ToolCatalog();
  catalog.register({ name: 'mcp_linear_list_issues', skill: 'linear', summary: 's', schema: { type: 'object' }, dispatch: { kind: 'mcp', server: 'linear', toolName: 'list_issues' } });
  const handler = createCallToolHandler({ catalog, mcpProvider });
  const result = await handler({ tool: 'mcp_linear_list_issues', args: { team: 'p' } });
  expect(mcpProvider.callToolOnServer).toHaveBeenCalledWith({ server: 'linear', tool: 'list_issues', args: { team: 'p' } });
  expect(result).toEqual({ result: { issues: [{ id: 1 }] } });
});

test('returns structured error for unknown tool', async () => {
  const handler = createCallToolHandler({ catalog: new ToolCatalog(), mcpProvider: {} as never });
  const result = await handler({ tool: 'mcp_bogus', args: {} });
  expect(result.error).toMatch(/unknown tool/i);
});

test('returns structured error when MCP provider throws', async () => {
  const mcpProvider = { callToolOnServer: vi.fn().mockRejectedValue(new Error('timeout')) };
  const catalog = new ToolCatalog();
  catalog.register({ name: 'mcp_linear_x', skill: 'linear', summary: 's', schema: { type: 'object' }, dispatch: { kind: 'mcp', server: 'linear', toolName: 'x' } });
  const handler = createCallToolHandler({ catalog, mcpProvider });
  const result = await handler({ tool: 'mcp_linear_x', args: {} });
  expect(result.error).toMatch(/timeout/);
});
```

**Step 2: Implement** — look up tool in catalog, dispatch based on `dispatch.kind`. For MCP, call `mcpProvider.callToolOnServer({server, tool, args})`. Strip `_select` from args before dispatch (will wire projection in next task). Structured errors — don't throw through the IPC boundary, return `{error: string, kind: 'unknown_tool' | 'dispatch_failed' | ...}`.

**Step 3: Commit**

```bash
git commit -m "feat(ipc): implement call_tool MCP dispatch (no projection yet)"
```

---

### Task 3.5: Register the agent-side tools

**Files:**
- Modify: `src/agent/tools/` (wherever built-ins are registered) — add `describe_tools` and `call_tool` tool-schema stubs that proxy via IPC
- Modify: `src/agent/ipc-client.ts` — add typed methods if the client uses a method-per-action pattern
- Create/Extend: `tests/agent/tools/describe-tools.test.ts`

**Pre-step:** Read `src/agent/tools/` to find the built-in tool registration pattern. (The reconnaissance didn't cover this specifically — list the directory first.)

**Step 1: Test the tool stubs exist and proxy correctly**

```ts
test('describe_tools agent tool calls IPC action', async () => {
  const ipc = { call: vi.fn().mockResolvedValue({ tools: [], unknown: [] }) };
  const tool = createDescribeToolsTool(ipc as never);
  await tool.execute({ names: ['x'] });
  expect(ipc.call).toHaveBeenCalledWith('describe_tools', { names: ['x'] });
});
```

**Step 2: Implement.**

**Step 3: Register conditionally on `mode === 'indirect'`.** In `direct` mode these tools shouldn't appear. Read `mode` from `AgentConfig.tool_dispatch.mode` (add this field to AgentConfig, ship from host).

**Step 4: Commit**

```bash
git commit -m "feat(agent): add describe_tools + call_tool built-ins (indirect mode)"
```

---

### Task 3.6: End-to-end smoke test for `indirect` dispatch

**Files:**
- Extend: `tests/e2e/regression.test.ts` with a new case
- Add scripted turn: `tests/e2e/scripts/tool-dispatch.ts`

Use the existing `ax-debug` tier 1 pattern (see `.claude/skills/ax-debug/SKILL.md`). Scripted turn: user asks "list issues"; mock Linear MCP returns a response; agent should produce a `call_tool` IPC request routing to the mocked MCP.

Commit message: `test(e2e): indirect dispatch smoke test via describe_tools + call_tool`.

---

## Phase 4: Projection (`_select`) + auto-spill (rollout step 4)

### Task 4.1: Choose and install a jq dependency

**Step 1:** Research `node-jq` vs `jq-wasm` vs shelling out to `/usr/bin/jq`. Prefer shelling out — `jq` is already in the sandbox image per the reconnaissance, and `node-jq` adds a native binding. But the `call_tool` handler runs in the *host* process, not the sandbox. Check if the host container/node image has `jq`. If not, add it to `container/host/Dockerfile` (or add `node-jq` as an npm dep).

Decide based on where `call_tool` runs. Default assumption: host side → add `jq` to host image.

**Step 2:** If adding a binary dep, modify `container/host/Dockerfile` to install `jq`.

**Step 3:** Write a tiny wrapper: `src/host/tool-catalog/jq.ts` exporting `applyJq(data: unknown, selector: string): unknown` that spawns `jq` as a subprocess with a 500ms timeout. Test it with good + bad selectors.

**Step 4: Commit**

```bash
git commit -m "feat(tool-catalog): add jq wrapper for _select projection"
```

---

### Task 4.2: Apply `_select` in call_tool handler

**Files:**
- Modify: `src/host/ipc-handlers/call-tool.ts`
- Extend: `tests/host/ipc-handlers/call-tool.test.ts`

**Step 1: Test**

```ts
test('applies _select projection to response', async () => {
  const mcpProvider = { callToolOnServer: vi.fn().mockResolvedValue({ issues: [{ id: 1, title: 't1' }] }) };
  const catalog = catalogWith('mcp_linear_list_issues');
  const handler = createCallToolHandler({ catalog, mcpProvider });
  const result = await handler({ tool: 'mcp_linear_list_issues', args: { _select: '.issues | length' } });
  expect(result).toEqual({ result: 1 });
});

test('returns actionable error on malformed _select', async () => {
  const mcpProvider = { callToolOnServer: vi.fn().mockResolvedValue({}) };
  const catalog = catalogWith('mcp_linear_list_issues');
  const handler = createCallToolHandler({ catalog, mcpProvider });
  const result = await handler({ tool: 'mcp_linear_list_issues', args: { _select: '.[' } });
  expect(result.error).toMatch(/_select/i);
});
```

**Step 2: Implement** — after dispatch, if `args._select` was present, run `applyJq(result, args._select)`. Catch jq errors and return `{error: "_select didn't parse: ..."}`.

**Step 3: Commit**

```bash
git commit -m "feat(tool-catalog): wire _select jq projection into call_tool"
```

---

### Task 4.3: Auto-spill responses over threshold

**Files:**
- Modify: `src/host/ipc-handlers/call-tool.ts`
- Extend: tests

The spill path writes `/tmp/tool-<requestId>.json` in the *sandbox*, not the host (the agent needs to read it via `bash`). That means the spill file needs to be written via a side channel to the sandbox filesystem — the IPC response itself can carry the file bytes, or the handler can write directly through the shared workspace mount.

**Design note:** since the agent process reads files via `bash cat` or `read_file` tool, the simplest path is: spill file lives inside the sandbox workspace at `/tmp/` which is a tmpfs inside the sandbox pod. The host can't write to the sandbox's `/tmp` directly without an IPC round-trip. Options:
  - A: have the agent write the spill file itself — call_tool returns `{_spill: full_response}`, agent-side handler persists to `/tmp/tool-<id>.json` and surfaces the stub to the model.
  - B: add a workspace-level `.ax/spill/` directory, write there from the host.

Pick A — avoids a new shared dir convention, keeps host logic simpler.

**Step 1: Test** (host side)

```ts
test('returns _truncated stub when response exceeds threshold', async () => {
  const big = { data: 'x'.repeat(30_000) };
  const mcp = { callToolOnServer: vi.fn().mockResolvedValue(big) };
  const handler = createCallToolHandler({ catalog: catalogWith('mcp_x_y'), mcpProvider: mcp, spillThresholdBytes: 20_480 });
  const result = await handler({ tool: 'mcp_x_y', args: {} });
  expect(result.truncated).toBe(true);
  expect(result.full).toEqual(big);  // passed back to the agent for spilling
  expect(result.preview).toBeDefined();
});
```

**Step 2: Test** (agent side — the stub-writing half)

```ts
test('agent persists spill file and surfaces stub', async () => {
  const tool = createCallToolTool({ ipc: { call: async () => ({ truncated: true, full: {big: 'x'}, preview: '{"big":"x"}' }) }, fs: memFs });
  const out = await tool.execute({ tool: 'mcp_x_y', args: {} });
  expect(out._truncated).toBe(true);
  expect(memFs.readSync(out._path)).toContain('big');
});
```

**Step 3: Implement both sides.**

**Step 4: Commit**

```bash
git commit -m "feat(tool-catalog): auto-spill responses >20KB to /tmp/tool-<id>.json"
```

---

### Task 4.4: E2E verification of Linear flow

Extend the e2e regression test added in Task 3.6 with a scripted turn pack for "what issues are in Product's current cycle?". Assert: 3 `call_tool` turns (get_team, list_cycles, list_issues), zero retries.

Commit: `test(e2e): verify Linear 3-turn cycle flow through indirect dispatch`.

---

## Phase 5: `direct` mode (rollout step 5)

### Task 5.1: Render catalog tools into `tools[]` for the LLM call

**Files:**
- Modify: `src/host/server-completions.ts` or `src/host/ipc-handlers/llm.ts` — wherever `tools[]` is constructed for the LLM call
- Create: `tests/host/llm-call-direct-mode.test.ts`

**Step 1: Test**

```ts
test('direct mode injects every catalog tool into tools[]', () => {
  const catalog = catalogWithThree();
  const tools = buildLlmToolsList({ mode: 'direct', catalog, builtIns: [/* bash etc */] });
  expect(tools.map(t => t.name)).toContain('mcp_linear_list_issues');
});

test('indirect mode injects only describe_tools + call_tool + built-ins', () => {
  const catalog = catalogWithThree();
  const tools = buildLlmToolsList({ mode: 'indirect', catalog, builtIns: [/* bash etc */] });
  expect(tools.map(t => t.name)).toContain('describe_tools');
  expect(tools.map(t => t.name)).toContain('call_tool');
  expect(tools.map(t => t.name)).not.toContain('mcp_linear_list_issues');
});
```

**Step 2: Implement.**

**Step 3: Commit.**

---

### Task 5.2: Route direct-mode tool calls through `call_tool` internally

When the LLM picks `mcp_linear_list_issues` directly, the agent receives that as a tool call. The agent's tool-dispatch layer recognizes the `mcp_` / `api_` prefix and forwards through the existing `call_tool` IPC path (with `_select` + spill semantics preserved). This keeps dispatch logic centralized.

Test + implement + commit.

---

### Task 5.3: Weak-model smoke test

Run the Linear e2e with `config.tool_dispatch.mode: direct` against a weak model (Haiku or the mock equivalent). Expected: arg-shape error rate improves vs indirect mode because constrained decoding is back.

Commit: `test(e2e): direct mode with weak model`.

---

## Phase 6: Delete legacy codegen, keep `execute_script` (rollout step 6)

**Do not start Phase 6 until Phases 1-5 pass green and have been smoke-tested end-to-end in dev (via `ax-debug` tier 0 or tier 2).** The entire point of the parallel-path migration is to be sure we don't regress.

### Scope revision (2026-04-20)

The original plan folded `execute_script` into the delete list with the justification *"bash + jq cover ad-hoc work."* That's wrong. `execute_script` isn't a codegen artifact — it's a qualitatively different primitive: **multi-tool orchestration in a single LLM turn** (compose, loop, paginate, aggregate). A 3-step workflow like "find team → find current cycle → paginate issues" costs 3+ LLM round-trips via `call_tool`, but 1 turn via `execute_script`. `_select` projects one result; `jq` in bash munges JSON; neither composes N tool calls.

Phase 6 now:

1. Keeps `execute_script` (the sandboxed JS VM).
2. Replaces its tool-reach mechanism: instead of `import { listIssues } from '/workspace/.ax/tools/linear/index.js'`, scripts call `await ax.callTool('mcp_linear_list_issues', args)` — a runtime-injected helper that funnels through the same `call_tool` IPC as the agent's direct `call_tool` tool. Single dispatch path; `_select` and auto-spill inherit automatically.
3. Deletes everything else that the original Phase 6 delete list identified: `src/host/toolgen/`, `.ax/tools/` write path, `tool-index-loader.ts`, tool-module-generation half of `tool-module-sync.ts`, runtime guards, prompt-side toolModuleIndex branch.

Net effect: all tool calls (direct, indirect, script-invoked) funnel through `call_tool`. No generated files. `execute_script` keeps its reason to exist.

---

### Task 6.1: Inject `ax.callTool` helper into the `execute_script` sandbox

**Files:**
- Modify: `src/agent/execute-script.ts`
- Test: `tests/agent/execute-script.test.ts`

**Design:** prepend a small preamble to every script before writing it to the tmp .mjs file. The preamble defines a `globalThis.ax = { callTool, describeTool, version: 1 }` object using the same `AX_HOST_URL` + `AX_IPC_TOKEN` envs that today's codegen already uses. The LLM writes scripts like:

```js
const issues = await ax.callTool('mcp_linear_list_issues', { team_id: 'x' });
console.log(JSON.stringify(issues).slice(0, 500));
```

No `import` lines. Discoverable from the tool description.

**Preamble shape:**

```js
// ax-preamble (injected by execute_script) — do not edit
globalThis.ax = (() => {
  const hostUrl = process.env.AX_HOST_URL;
  const token = process.env.AX_IPC_TOKEN;
  async function _ipc(action, body) {
    if (!hostUrl) throw new Error('AX_HOST_URL not set');
    const res = await fetch(hostUrl + '/internal/ipc', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
      },
      body: JSON.stringify({ action, ...body }),
    });
    if (!res.ok) throw new Error(`ipc ${action} failed: ${res.status} ${await res.text()}`);
    return res.json();
  }
  return {
    version: 1,
    async callTool(name, args = {}, opts = {}) {
      if (typeof name !== 'string' || !name) {
        throw new TypeError('ax.callTool(name, args) — name must be a non-empty string');
      }
      if (args === null || typeof args !== 'object') {
        throw new TypeError(`ax.callTool("${name}", args) — args must be an object`);
      }
      // Inline _select if the caller passed it via opts — avoids polluting args.
      const finalArgs = opts.select ? { ...args, _select: opts.select } : args;
      const result = await _ipc('call_tool', { tool: name, args: finalArgs });
      if (result && typeof result === 'object' && 'error' in result) {
        throw new Error(`call_tool("${name}"): ${result.error}`);
      }
      return result.result ?? result;
    },
    async describeTool(names) {
      const list = Array.isArray(names) ? names : [names];
      const result = await _ipc('describe_tools', { names: list });
      return result;
    },
  };
})();
```

**Step 1: Write failing tests** — small real-process tests that write a script calling `ax.callTool`, stand up a local fake `/internal/ipc` endpoint, and assert the IPC payload + the script's observed return value.

**Step 2: Implement** — preamble prepended in `executeScript()` before `writeFileSync`.

**Step 3: Commit** — `feat(execute-script): inject ax.callTool runtime helper (replaces codegen imports)`.

---

### Task 6.2: Update `execute_script` tool description for the new API

**Files:**
- Modify: `src/agent/tool-catalog.ts` (the `execute_script` entry near line 364)

Replace the current description (which still advertises `/workspace/.ax/tools/` imports) with the `ax.callTool` pattern. Include:

- A 3-line example of a multi-step call (team → cycle → issues).
- Explicit mention that output shape is not typed — log and inspect on first use, or pass `opts.select` with a jq filter to shape the response client-side.
- Note that errors come as thrown exceptions (not `{error}` envelopes) so the script can `try`/`catch`.
- Preserve the advice that only stdout is captured and is truncated at 10KB (spilled to `/tmp/ax-results/` for the rest).

**Step:** one-commit description rewrite plus a unit test covering the `{exampleOutput}` part of the description if one exists.

Commit: `docs(agent): rewrite execute_script description for ax.callTool API`.

---

### Task 6.3: Delete `.ax/tools/` generated code + codegen pipeline

**Delete:**
- `src/host/toolgen/` (whole directory)
- `src/agent/prompt/tool-index-loader.ts`
- The tool-module-generation half of `src/host/skills/tool-module-sync.ts` (keep `registerMcpServersFromSnapshot` state reconciler)
- The `toolModuleIndex` branch + response-wrapping hint in `src/agent/prompt/modules/runtime.ts`
- `.ax/tools/` directory write path — wherever `commitFiles` is called for tool modules
- The runtime guards introduced 2026-04-19 (enum union rendering, destructuring brace conversion, wrapping hint) — see `.claude/journal/host/skills.md` for the changed files
- Tests for all of the above

**Step 1:** Run `npm run build && npm test` after each file deletion batch; fix callers. When a caller wants to import from deleted code, confirm the catalog + `ax.callTool` path covers it — if not, you're deleting too early.

**Step 2:** Sweep for `.ax/tools/` path references (grep) — remove or replace. Sample:

```bash
rg -n "\.ax/tools/|toolgen|toolModuleIndex|tool-index-loader"
```

Every hit should be either a doc/skill reference updated in Task 6.4 or a test/source file deleted in this task.

**Step 3: Commit in logical chunks** (not one giant commit):

```bash
git commit -m "refactor(toolgen): delete codegen pipeline — superseded by tool-catalog + ax.callTool"
git commit -m "refactor(agent): delete tool-index-loader — superseded by catalog module"
git commit -m "refactor(skills): keep state reconciler, drop module generation"
git commit -m "refactor(prompt): drop response-wrapping hint (runtime guards unnecessary with ax.callTool)"
```

**Journal:** detailed entry. This is a milestone.

---

### Task 6.4: Port input-shape guards to `ax.callTool` (optional polish)

Today's codegen emits actionable `TypeError('listIssues expects a single object argument (keys: query, limit), ...')` before the IPC call — if the agent passes a bare string, it gets a clear shape error instead of a confusing Zod failure from the host. We want that back.

**Files:**
- Modify: `src/agent/execute-script.ts` preamble
- Test: extend `tests/agent/execute-script.test.ts`

**Approach:** the preamble has no catalog knowledge at script-write time. Two options:

- **(a) Runtime `describe_tools` lookup** — first `ax.callTool(name, ...)` call implicitly fetches `describe_tools([name])` and caches the input schema. Subsequent calls skip the lookup. Minor latency cost on first call; zero code generation.
- **(b) Ship a schema map in the preamble** — the script host injects `__AX_TOOL_SCHEMAS__` (a compact `{name: inputSchema}` map from the per-turn catalog) as a constant in the preamble, and `ax.callTool` validates against it locally. Zero latency; slightly larger script prelude.

Pick (b) for the latency win, unless the preamble size becomes painful on turns with huge catalogs. Benchmark at 50+ tools before committing to (b).

Commit: `feat(execute-script): validate ax.callTool args against catalog input schemas`.

---

### Task 6.5: Documentation sweep

- Skills at `.claude/skills/ax/` — any `ax-*` sub-skill that references `.ax/tools/`, the generated-import pattern, toolgen, PTC, response-wrapping, or tool-index-loader MUST be updated. Grep for those terms across the skills dir.
- `docs/web/` — same grep; update any pages referencing the deleted concepts. Add a short blurb on `ax.callTool` + `execute_script` if there's an overview page.
- `CLAUDE.md` — re-read; any outdated references updated.
- `.claude/lessons/` — scan for rotted advice referencing generated tool modules.

Commit: `docs: sweep references to deleted codegen; document ax.callTool`.

---

## Phase 7: OpenAPI adapter (rollout step 7)

### Task 7.1: Extend frontmatter schema with `openapi:` section

**Files:**
- Modify: `src/host/skills/frontmatter-schema.ts`
- Tests: extend `tests/host/skills/frontmatter-schema.test.ts`

Add:
```ts
openapi: z.array(z.object({
  spec: z.string().min(1),          // URL or workspace-relative path
  base_url: z.string().url(),
  auth: z.object({
    scheme: z.enum(['bearer', 'basic', 'api_key_header', 'api_key_query']),
    credential: z.string(),
  }).optional(),
  include: z.array(z.string()).optional(),
  exclude: z.array(z.string()).optional(),
}).strict()).optional(),
```

Commit.

---

### Task 7.2: Build the OpenAPI adapter

**Files:**
- Create: `src/host/tool-catalog/adapters/openapi.ts`
- Create: `tests/host/tool-catalog/adapters/openapi.test.ts`
- Create: `tests/fixtures/openapi/petstore-minimal.json`

Vendor a tiny spec as fixture (3-4 operations). Test cases: builds one catalog tool per operation, derives inputSchema from params + requestBody, captures outputSchema, applies include/exclude.

Use `swagger-parser` or `@apidevtools/swagger-parser` — well-established; add as dep. If the spec is v2 (Swagger) convert to v3 first or reject.

Commit.

---

### Task 7.3: Wire OpenAPI adapter into catalog population

Parallel to `populateCatalogFromSkills` for MCP. Iterates skill frontmatter's `openapi:` array, fetches spec (HTTP URL or workspace file), builds tools, registers.

Commit.

---

### Task 7.4: Dispatch OpenAPI calls in call_tool

For `dispatch.kind === 'openapi'`, call through the existing web proxy (credential injection + allowlist + audit). Tests with a mock HTTP server.

Commit.

---

### Task 7.5: E2E — small OpenAPI skill

Build a tiny fixture skill in `tests/e2e/fixtures/skills/petstore/` with `SKILL.md` + frontmatter using the petstore spec. Extend regression suite. Assert: agent can list + call operations.

Commit.

---

## Phase 8: Skill-creator updates (rollout step 8)

### Task 8.1: Warn on wide skills without `include:`

Skill-creator emits a warning when an MCP server exposes >20 tools and no `include:` filter is present. Same for OpenAPI with >30 operations.

Tests + implement + commit.

### Task 8.2: Formalize `scripts/` directory

Skill-creator nudges authors to put multi-step recipes in `.ax/skills/<name>/scripts/` rather than writing a script inline every session. Just a template suggestion — no code change required except to skill-creator prompt.

Commit.

---

## Verification plan (final milestone)

Before merging `feat/tool-dispatch-unification` back to main:

### Unit tests

Run the full suite:
```bash
npm run build && npm test
```
Expected: all green.

### Integration tests

```bash
npm run test:e2e
```
Expected: all green, including new cases for indirect dispatch, direct dispatch, Linear cycle flow, petstore OpenAPI.

### Manual verification

Using `ax-debug` tier 2 (kind cluster):

1. Install Linear skill. Confirm `.ax/tools/` is not regenerated (deleted in phase 6).
2. Send "what issues are in Product's current cycle?" — observe 3-4 `call_tool` IPC requests + one response with correct issues. Zero retries.
3. Measure system prompt token count with one 42-tool skill — target ~3K for one-liners.
4. Trigger a large response (list_issues without filter) — observe auto-spill to `/tmp/tool-*.json` + `_truncated` stub in agent context.
5. Switch `ax.yaml` to `tool_dispatch.mode: direct`, restart, verify tool calls still work. `tools[]` in the API call should include every catalog tool with full schemas.

### Production rollout

Stage on an internal environment first. Watch `.claude/journal/host/skills.md` for a week. If no retry-spiral complaints: ship.

---

## Final PR checklist

- [ ] All tests pass (`npm run build && npm test && npm run test:e2e`).
- [ ] Journal updated with phase-level entries.
- [ ] Lessons recorded for each non-obvious decision (jq binary location, spill file responsibility, module registration pattern).
- [ ] `CLAUDE.md` + `.claude/skills/ax/*` + `docs/web/` swept for references to deleted concepts.
- [ ] Manual smoke test in kind cluster documented with turn-count evidence.
- [ ] PR description summarizes what's deleted, what's added, and what breaks.

---

## Notes to the executor

**If you get stuck for ≥30 minutes on a task, stop and ask.** This plan is long; assumptions may not match reality. The reconnaissance was quick — expect surprises at the wiring boundaries (especially Tasks 2.2, 2.3, 3.5). It is cheaper to re-plan than to power through based on a wrong mental model.

**Don't skip the parallel-path migration (Phases 2-5).** The temptation to delete `.ax/tools/` early will be strong. Resist. The point of the parallel path is that any regression is easy to roll back by toggling config.

**Prefer smaller commits over larger ones** — this plan is conservative in commit boundaries. If a task's "implement" step feels like 200+ lines, split it.

**Use `ax-debug` tier 1 (e2e tests) for repro on bugs** — do not go to tier 2 unless you have a reason that tier 1 can't cover. See `.claude/skills/ax-debug/SKILL.md`.
