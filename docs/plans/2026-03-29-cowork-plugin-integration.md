# Cowork Plugin Integration Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enable AX agents to install and use Claude Cowork plugins (skills, commands, MCP servers) with per-agent scoping, no-restart dynamic MCP connections, and TypeScript tool stub generation for sandboxed agents.

**Architecture:** Cowork plugins are file-based bundles (Markdown + JSON, no code) containing skills, slash commands, and MCP server configs. We parse them into AX's existing per-agent skill storage, add a new command registry, and build a per-agent MCP connection manager. At sandbox spin-up, the existing capnweb codegen generates typed TypeScript tool stubs from plugin MCP servers into `/tools/` for the agent to import directly. Existing `ax plugin` (npm provider packages) is renamed to `ax provider` to avoid naming collision.

**Tech Stack:** TypeScript, Zod validation, Kysely (DB), @inquirer/prompts (CLI), vitest (tests)

---

## Terminology

| Term | Meaning |
|------|---------|
| **Plugin** | A Cowork-style bundle: skills + commands + MCP configs (Markdown/JSON, no code) |
| **Provider** | An npm package implementing a provider contract (LLM, sandbox, memory, etc.) |

## Cowork Plugin File Structure

```
plugin-name/
+-- .claude-plugin/plugin.json   # metadata (name, version, description) -- install-time only
+-- skills/*/SKILL.md            # auto-triggered domain knowledge -- stored in DB
+-- commands/*.md                # explicit /slash-commands -- stored in DB
+-- .mcp.json                    # MCP server endpoints -- registered in McpConnectionManager
+-- CONNECTORS.md                # IGNORED (human setup docs, not used at runtime)
+-- README.md                    # IGNORED (human docs)
```

Key insight: `CONNECTORS.md` is purely human documentation. Cowork does not read it at runtime. The agent infers which MCP tools map to which categories from tool names/descriptions and `~~category` hints in skill files.

## How Each Runner Uses Plugins

| Component | Fast-path (in-process) | pi-coding-agent (sandboxed) |
|-----------|----------------------|----------------------------|
| Skills (`SKILL.md`) | Loaded from DB, injected into system prompt | Written to workspace, read via `read_file` |
| Commands (`*.md`) | Rendered by CommandsModule in prompt | Same -- CommandsModule in prompt |
| MCP tools | Host calls `mcp.listTools()` directly | **capnweb generates TypeScript stubs into `/tools/`** -- agent imports and calls them, batched over IPC via `tool_batch` |

The capnweb tool stub infrastructure (`src/host/capnweb/`) already handles generating typed TS wrappers from MCP tool schemas and writing them to the sandbox workspace. We just need to feed it per-agent plugin MCP tools alongside the global ones.

---

## Task 1: Plugin Types

Define shared types for the plugin system.

**Files:**
- Create: `src/plugins/types.ts`

**Step 1: Write types**

```typescript
// src/plugins/types.ts

/** Parsed Cowork plugin manifest (.claude-plugin/plugin.json). */
export interface PluginManifest {
  name: string;
  version: string;
  description: string;
  author?: string;
}

/** A single skill extracted from skills/*/SKILL.md. */
export interface PluginSkill {
  /** Directory name (e.g., 'call-prep'). */
  name: string;
  /** Full SKILL.md content. */
  content: string;
}

/** A slash command extracted from commands/*.md. */
export interface PluginCommand {
  /** File stem (e.g., 'forecast' from forecast.md). */
  name: string;
  /** Full command file content. */
  content: string;
}

/** An MCP server extracted from .mcp.json. */
export interface PluginMcpServer {
  /** Logical name (e.g., 'slack', 'hubspot'). */
  name: string;
  /** Server type (always 'http' for now). */
  type: string;
  /** MCP server endpoint URL. */
  url: string;
}

/** A fully parsed Cowork plugin bundle. */
export interface PluginBundle {
  manifest: PluginManifest;
  skills: PluginSkill[];
  commands: PluginCommand[];
  mcpServers: PluginMcpServer[];
}

/** Per-agent installed plugin record (stored in DB). */
export interface InstalledPlugin {
  pluginName: string;
  source: string;
  version: string;
  description: string;
  agentId: string;
  skillCount: number;
  commandCount: number;
  /** Full MCP server configs (persisted for restart recovery). */
  mcpServers: PluginMcpServer[];
  installedAt: string;
}
```

**Step 2: Commit**

```bash
git add src/plugins/types.ts
git commit -m "feat: add Cowork plugin types"
```

---

## Task 2: Plugin Manifest Parser

Parse the Cowork plugin file structure into a `PluginBundle`.

**Files:**
- Create: `src/plugins/parser.ts`
- Test: `tests/plugins/parser.test.ts`

**Step 1: Write the failing tests**

```typescript
// tests/plugins/parser.test.ts
import { describe, it, expect } from 'vitest';
import { parsePluginManifest, parsePluginBundle } from '../../src/plugins/parser.js';

describe('parsePluginManifest', () => {
  it('parses a valid plugin.json', () => {
    const raw = { name: 'sales', version: '1.2.0', description: 'Sales plugin', author: { name: 'Anthropic' } };
    const result = parsePluginManifest(raw);
    expect(result.name).toBe('sales');
    expect(result.version).toBe('1.2.0');
  });

  it('rejects manifest without name', () => {
    expect(() => parsePluginManifest({ version: '1.0.0', description: 'x' })).toThrow();
  });

  it('rejects manifest without version', () => {
    expect(() => parsePluginManifest({ name: 'x', description: 'x' })).toThrow();
  });
});

describe('parsePluginBundle', () => {
  it('extracts skills from skills/ directory', () => {
    const files = new Map<string, string>([
      ['.claude-plugin/plugin.json', JSON.stringify({ name: 'sales', version: '1.0.0', description: 'Sales' })],
      ['skills/call-prep/SKILL.md', '# Call Prep\nPrepare for sales calls.'],
      ['skills/account-research/SKILL.md', '# Account Research\nResearch accounts.'],
    ]);
    const bundle = parsePluginBundle(files);
    expect(bundle.skills).toHaveLength(2);
    expect(bundle.skills.map(s => s.name)).toContain('call-prep');
  });

  it('extracts commands from commands/ directory', () => {
    const files = new Map<string, string>([
      ['.claude-plugin/plugin.json', JSON.stringify({ name: 'sales', version: '1.0.0', description: 'Sales' })],
      ['commands/forecast.md', '# /forecast\nGenerate weighted sales forecast.'],
    ]);
    const bundle = parsePluginBundle(files);
    expect(bundle.commands).toHaveLength(1);
    expect(bundle.commands[0].name).toBe('forecast');
  });

  it('extracts MCP servers from .mcp.json', () => {
    const files = new Map<string, string>([
      ['.claude-plugin/plugin.json', JSON.stringify({ name: 'sales', version: '1.0.0', description: 'Sales' })],
      ['.mcp.json', JSON.stringify({ mcpServers: { slack: { type: 'http', url: 'https://mcp.slack.com/mcp' } } })],
    ]);
    const bundle = parsePluginBundle(files);
    expect(bundle.mcpServers).toHaveLength(1);
    expect(bundle.mcpServers[0].name).toBe('slack');
    expect(bundle.mcpServers[0].url).toBe('https://mcp.slack.com/mcp');
  });

  it('ignores CONNECTORS.md and README.md', () => {
    const files = new Map<string, string>([
      ['.claude-plugin/plugin.json', JSON.stringify({ name: 'sales', version: '1.0.0', description: 'Sales' })],
      ['CONNECTORS.md', '# Connectors\nHuman docs only.'],
      ['README.md', '# Sales Plugin\nHuman docs.'],
    ]);
    const bundle = parsePluginBundle(files);
    expect(bundle.skills).toEqual([]);
    expect(bundle.commands).toEqual([]);
    expect(bundle.mcpServers).toEqual([]);
  });

  it('returns empty arrays when optional sections are missing', () => {
    const files = new Map<string, string>([
      ['.claude-plugin/plugin.json', JSON.stringify({ name: 'minimal', version: '1.0.0', description: 'Minimal' })],
    ]);
    const bundle = parsePluginBundle(files);
    expect(bundle.skills).toEqual([]);
    expect(bundle.commands).toEqual([]);
    expect(bundle.mcpServers).toEqual([]);
  });

  it('throws when plugin.json is missing', () => {
    const files = new Map<string, string>([['skills/foo/SKILL.md', 'some skill']]);
    expect(() => parsePluginBundle(files)).toThrow(/plugin\.json/i);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npm test -- --run tests/plugins/parser.test.ts`
Expected: FAIL -- modules not found

**Step 3: Implement parser**

```typescript
// src/plugins/parser.ts
import { z } from 'zod';
import type { PluginManifest, PluginSkill, PluginCommand, PluginMcpServer, PluginBundle } from './types.js';
import { basename, dirname } from 'node:path';

const ManifestSchema = z.object({
  name: z.string().min(1).max(200),
  version: z.string().min(1).max(50),
  description: z.string().min(1).max(2000),
  author: z.object({ name: z.string() }).optional(),
});

const McpJsonSchema = z.object({
  mcpServers: z.record(
    z.string(),
    z.object({
      type: z.string().default('http'),
      url: z.string().url(),
    }),
  ),
});

export function parsePluginManifest(raw: unknown): PluginManifest {
  const parsed = ManifestSchema.parse(raw);
  return {
    name: parsed.name,
    version: parsed.version,
    description: parsed.description,
    author: parsed.author?.name,
  };
}

export function parsePluginBundle(files: Map<string, string>): PluginBundle {
  const manifestContent = files.get('.claude-plugin/plugin.json');
  if (!manifestContent) {
    throw new Error('Plugin is missing .claude-plugin/plugin.json');
  }
  const manifest = parsePluginManifest(JSON.parse(manifestContent));

  const skills: PluginSkill[] = [];
  for (const [path, content] of files) {
    if (path.match(/^skills\/[^/]+\/SKILL\.md$/)) {
      skills.push({ name: basename(dirname(path)), content });
    }
  }

  const commands: PluginCommand[] = [];
  for (const [path, content] of files) {
    if (path.match(/^commands\/[^/]+\.md$/)) {
      commands.push({ name: basename(path, '.md'), content });
    }
  }

  const mcpServers: PluginMcpServer[] = [];
  const mcpContent = files.get('.mcp.json');
  if (mcpContent) {
    const parsed = McpJsonSchema.parse(JSON.parse(mcpContent));
    for (const [name, server] of Object.entries(parsed.mcpServers)) {
      mcpServers.push({ name, type: server.type, url: server.url });
    }
  }

  return { manifest, skills, commands, mcpServers };
}
```

**Step 4: Run tests to verify they pass**

Run: `npm test -- --run tests/plugins/parser.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/plugins/parser.ts tests/plugins/parser.test.ts
git commit -m "feat: add Cowork plugin manifest parser"
```

---

## Task 3: Plugin Storage (Per-Agent)

Store installed plugin metadata and commands in the DB, scoped per agent.

**Files:**
- Create: `src/plugins/store.ts`
- Test: `tests/plugins/store.test.ts`

**Step 1: Write the failing tests**

Tests should cover: upsert/get/list/delete plugins per agent, upsert/list/delete commands per agent and plugin. Follow existing patterns from `tests/providers/storage/` for DocumentStore setup.

Key assertions:
- `listPlugins('pi')` returns only pi's plugins, not counsel's
- `deletePlugin` removes the record
- `deleteCommandsByPlugin` removes all commands for that plugin but not other plugins' commands

**Step 2: Run tests to verify they fail**

Run: `npm test -- --run tests/plugins/store.test.ts`
Expected: FAIL

**Step 3: Implement store**

Uses the existing `DocumentStore` interface (same as skills). Two collections:
- `'plugins'` with key `{agentId}/{pluginName}` storing `InstalledPlugin` as JSON
- `'commands'` with key `{agentId}/{commandName}` storing `CommandRecord` as JSON

```typescript
// src/plugins/store.ts
import type { DocumentStore } from '../providers/storage/types.js';
import type { InstalledPlugin } from './types.js';

// Plugin CRUD -- same pattern as src/providers/storage/skills.ts
function pluginKey(agentId: string, pluginName: string): string {
  return `${agentId}/${pluginName}`;
}

export interface PluginUpsertInput {
  pluginName: string;
  source: string;
  version: string;
  description: string;
  agentId: string;
  skillCount: number;
  commandCount: number;
  mcpServers: Array<{ name: string; type: string; url: string }>;
}

export async function upsertPlugin(documents: DocumentStore, input: PluginUpsertInput): Promise<void>;
export async function getPlugin(documents: DocumentStore, agentId: string, pluginName: string): Promise<InstalledPlugin | null>;
export async function listPlugins(documents: DocumentStore, agentId: string): Promise<InstalledPlugin[]>;
export async function deletePlugin(documents: DocumentStore, agentId: string, pluginName: string): Promise<boolean>;

// Command CRUD
export interface CommandRecord {
  name: string;
  pluginName: string;
  agentId: string;
  content: string;
  installedAt: string;
}

export async function upsertCommand(documents: DocumentStore, input: { name: string; pluginName: string; agentId: string; content: string }): Promise<void>;
export async function listCommands(documents: DocumentStore, agentId: string): Promise<CommandRecord[]>;
export async function deleteCommandsByPlugin(documents: DocumentStore, agentId: string, pluginName: string): Promise<void>;
```

**Step 4: Run tests to verify they pass**

Run: `npm test -- --run tests/plugins/store.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/plugins/store.ts tests/plugins/store.test.ts
git commit -m "feat: add per-agent plugin and command storage"
```

---

## Task 4: Plugin Fetcher (GitHub, Local, URL)

Fetch plugin files from various sources into a `Map<string, string>`.

**Files:**
- Create: `src/plugins/fetcher.ts`
- Test: `tests/plugins/fetcher.test.ts`

**Step 1: Write the failing tests**

Test `parsePluginSource()` for all source types (GitHub slug, local path, URL) and `fetchPluginFiles()` for local directory reads.

**Step 2: Run tests to verify they fail**

Run: `npm test -- --run tests/plugins/fetcher.test.ts`
Expected: FAIL

**Step 3: Implement fetcher**

Three source types:
- **Local** (`./path` or `/absolute`): read directory recursively, skip `.git`, `node_modules`, binary extensions
- **GitHub** (`owner/repo` or `owner/repo/subdir`): shallow clone via `execFileSync('git', ['clone', ...])` to temp dir, read, clean up
- **URL** (`https://github.com/...`): parse GitHub URL, delegate to GitHub fetcher

**SECURITY:** Use `execFileSync` (not `execSync`) for git clone to prevent shell injection. Import pattern:

```typescript
import { execFileSync } from 'node:child_process';
// ...
execFileSync('git', ['clone', '--depth', '1', '--single-branch', repoUrl, tmpDir], {
  stdio: 'pipe',
  timeout: 60_000,
});
```

**Step 4: Run tests to verify they pass**

Run: `npm test -- --run tests/plugins/fetcher.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/plugins/fetcher.ts tests/plugins/fetcher.test.ts
git commit -m "feat: add plugin fetcher for GitHub, local, and URL sources"
```

---

## Task 5: Per-Agent MCP Connection Manager

Registry tracking which MCP server endpoints are available per agent. In-memory (repopulated from DB on startup).

**Files:**
- Create: `src/plugins/mcp-manager.ts`
- Test: `tests/plugins/mcp-manager.test.ts`

**Step 1: Write the failing tests**

```typescript
// Key test cases:
// - starts with no connections
// - addServer registers for specific agent
// - servers scoped to agents (pi vs counsel don't see each other's)
// - removeServer removes one
// - removeServersByPlugin removes all servers tagged with that plugin
// - listServers returns PluginMcpServer[] (without internal pluginName tag)
```

**Step 2: Run tests to verify they fail**

Run: `npm test -- --run tests/plugins/mcp-manager.test.ts`
Expected: FAIL

**Step 3: Implement**

```typescript
// src/plugins/mcp-manager.ts
// Internal structure: Map<agentId, Map<serverName, ManagedServer>>
// ManagedServer = PluginMcpServer + optional pluginName for bulk removal
// Methods: addServer, removeServer, removeServersByPlugin, listServers, getServerUrls
```

No async, no HTTP connections -- this is just a registry. The actual MCP protocol connections happen when `prepareToolStubs()` queries each server's tools at sandbox spin-up time.

**Step 4: Run tests to verify they pass**

Run: `npm test -- --run tests/plugins/mcp-manager.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/plugins/mcp-manager.ts tests/plugins/mcp-manager.test.ts
git commit -m "feat: add per-agent MCP connection manager"
```

---

## Task 6: Plugin Install/Uninstall Orchestrator

Wire fetcher + parser + store + skill upsert + MCP manager into a single install flow.

**Files:**
- Create: `src/plugins/install.ts`
- Test: `tests/plugins/install.test.ts`

**Step 1: Write the failing tests**

Mock the fetcher (avoid real git clones). Test that `installPlugin()`:
- Parses the bundle and stores skills with `plugin:{pluginName}:{skillName}` IDs
- Stores commands in the command collection
- Registers MCP servers in the McpConnectionManager
- Stores plugin metadata in the plugins collection
- Adds MCP server domains to proxy allowlist
- Audit logs the install

Test that `uninstallPlugin()`:
- Removes skills with the plugin prefix
- Removes commands for the plugin
- Removes MCP servers from the manager
- Removes the plugin record

**Step 2: Run tests to verify they fail**

Run: `npm test -- --run tests/plugins/install.test.ts`
Expected: FAIL

**Step 3: Implement**

```typescript
// src/plugins/install.ts

export interface InstallPluginInput {
  source: string;
  agentId: string;
  documents: DocumentStore;
  mcpManager: McpConnectionManager;
  audit?: AuditProvider;
  domainList?: ProxyDomainList;
  sessionId?: string;
}

export interface InstallPluginResult {
  installed: boolean;
  pluginName?: string;
  version?: string;
  skillCount?: number;
  commandCount?: number;
  mcpServerCount?: number;
  mcpServerNames?: string[];
  reason?: string;
}

export async function installPlugin(input: InstallPluginInput): Promise<InstallPluginResult> {
  // 1. Fetch files (parsePluginSource + fetchPluginFiles)
  // 2. Parse bundle (parsePluginBundle)
  // 3. Store skills via upsertSkill() with id `plugin:{name}:{skillName}`
  //    - Use existing inferMcpApps() for MCP app hints
  // 4. Store commands via upsertCommand()
  // 5. Register MCP servers in mcpManager.addServer() -- LIVE, no restart
  // 6. Add MCP domains to proxy allowlist
  // 7. Store plugin metadata via upsertPlugin() (includes mcpServers for restart recovery)
  // 8. Audit log
}

export async function uninstallPlugin(input: { ... }): Promise<{ ok: boolean; reason?: string }> {
  // Reverse of install: delete skills, commands, MCP servers, plugin record
}
```

**Step 4: Run tests to verify they pass**

Run: `npm test -- --run tests/plugins/install.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/plugins/install.ts tests/plugins/install.test.ts
git commit -m "feat: add plugin install/uninstall orchestrator"
```

---

## Task 7: IPC Schemas and Handler for Plugin Management

Add IPC actions so agents can request plugin install/remove/list.

**Files:**
- Modify: `src/ipc-schemas.ts` -- add 3 new schemas
- Create: `src/host/ipc-handlers/plugins.ts`
- Modify: `src/host/ipc-server.ts` -- register handlers
- Test: `tests/host/ipc-handlers/plugins.test.ts`

**Step 1: Write the failing test**

Test that `plugin_list_cowork` returns empty for a new agent.

**Step 2: Run test to verify it fails**

Run: `npm test -- --run tests/host/ipc-handlers/plugins.test.ts`
Expected: FAIL

**Step 3: Add IPC schemas to `src/ipc-schemas.ts`**

```typescript
// Use _cowork suffix to avoid collision with existing plugin_list/plugin_status schemas
export const CoworkPluginInstallSchema = ipcAction('plugin_install_cowork', {
  source: safeString(1000),
});

export const CoworkPluginUninstallSchema = ipcAction('plugin_uninstall_cowork', {
  pluginName: safeString(200),
});

export const CoworkPluginListSchema = ipcAction('plugin_list_cowork', {});
```

**Step 4: Create handler**

```typescript
// src/host/ipc-handlers/plugins.ts
// Delegates to installPlugin/uninstallPlugin/listPlugins
// Uses ctx.agentId for per-agent scoping
```

**Step 5: Register in ipc-server.ts**

Import and wire `createPluginHandlers` alongside existing handlers. Pass `mcpManager` from server setup.

**Step 6: Run tests**

Run: `npm test -- --run tests/host/ipc-handlers/plugins.test.ts`
Expected: PASS

Run: `npm test -- --run` (full suite -- check sync tests, knownInternalActions if needed)
Expected: PASS

**Step 7: Commit**

```bash
git add src/ipc-schemas.ts src/host/ipc-handlers/plugins.ts src/host/ipc-server.ts tests/host/ipc-handlers/plugins.test.ts
git commit -m "feat: add IPC schemas and handlers for Cowork plugin management"
```

---

## Task 8: Rename `ax plugin` to `ax provider`, New `ax plugin` for Cowork

**Files:**
- Create: `src/cli/provider.ts` -- copy existing `src/cli/plugin.ts` with renamed strings
- Rewrite: `src/cli/plugin.ts` -- new Cowork plugin CLI
- Modify: `src/cli/index.ts` -- add `provider` subcommand

**Step 1: Move existing plugin CLI to provider CLI**

Copy `src/cli/plugin.ts` to `src/cli/provider.ts`. Rename all user-facing strings:
- `ax plugin add` -> `ax provider add`
- `ax plugin remove` -> `ax provider remove`
- etc.
- Export `runProvider` instead of `runPlugin`

**Step 2: Rewrite `src/cli/plugin.ts` for Cowork plugins**

```
ax plugin install <source> [--agent <name>]   Install a Cowork plugin
ax plugin remove <name> [--agent <name>]      Remove an installed plugin
ax plugin list [--agent <name>]               List installed plugins
```

Default agent: `'main'`. Delegates to `installPlugin`/`uninstallPlugin`/`listPlugins`.

Output format for install:
```
Plugin "sales" v1.2.0 installed for agent "pi".

  Components:
    9 skills
    3 commands
    8 MCP servers (slack, hubspot, clay, ...)

  MCP servers may need authentication.
  Connect them in the dashboard: http://localhost:8080/admin/connectors
```

**Step 3: Update `src/cli/index.ts`**

Add `provider` subcommand pointing to `runProvider`. Keep `plugin` pointing to new `runPlugin`.

**Step 4: Run tests**

Run: `npm test -- --run`
Expected: PASS

**Step 5: Commit**

```bash
git add src/cli/plugin.ts src/cli/provider.ts src/cli/index.ts
git commit -m "feat: rename npm plugins to providers, add Cowork plugin CLI"
```

---

## Task 9: Config Schema -- Per-Agent Plugins

Add `plugins` field to `ax.yaml` for declarative plugin configuration.

**Files:**
- Modify: `src/types.ts` -- add `PluginDeclaration` and `plugins` to `Config`
- Modify: `src/config.ts` -- add Zod schema for `plugins`
- Test: verify existing config tests pass

**Step 1: Add to `src/types.ts`**

```typescript
export interface PluginDeclaration {
  source: string;
  agents: string[];
}

export interface Config {
  // ... existing fields ...
  plugins?: PluginDeclaration[];
}
```

**Step 2: Add Zod schema in `src/config.ts`**

```typescript
// Inside ConfigSchema, add:
plugins: z.array(z.strictObject({
  source: z.string().min(1).max(1000),
  agents: z.array(z.string().min(1).max(100)).min(1),
})).optional(),
```

Example `ax.yaml`:
```yaml
plugins:
  - source: anthropics/knowledge-work-plugins/sales
    agents: [pi]
  - source: ./plugins/internal-legal
    agents: [counsel]
```

**Step 3: Run all tests**

Run: `npm test -- --run`
Expected: PASS (no existing test should break -- field is optional)

**Step 4: Commit**

```bash
git add src/config.ts src/types.ts
git commit -m "feat: add per-agent plugins config field to ax.yaml"
```

---

## Task 10: Commands Prompt Module

Surface installed commands in the agent prompt.

**Files:**
- Create: `src/agent/prompt/modules/commands.ts`
- Modify: `src/agent/prompt/types.ts` -- add `commands` to `PromptContext`
- Modify: `src/agent/prompt/builder.ts` -- register module
- Test: `tests/agent/prompt/modules/commands.test.ts`

**Step 1: Write the failing test**

Test that `shouldInclude` returns false with no commands, true with commands. Test that `render` produces a table with `/command-name` entries.

**Step 2: Run test to verify it fails**

Run: `npm test -- --run tests/agent/prompt/modules/commands.test.ts`
Expected: FAIL

**Step 3: Implement module**

```typescript
// src/agent/prompt/modules/commands.ts
// Priority 72 (just after skills at 70)
// Renders a table: | Command | Plugin | Description |
// Description extracted from first non-header line of command content
// shouldInclude: only when commands exist
```

**Step 4: Add `commands` to `PromptContext`**

```typescript
// In src/agent/prompt/types.ts:
commands?: Array<{ name: string; pluginName: string; content: string }>;
```

**Step 5: Register in builder.ts**

```typescript
import { CommandsModule } from './modules/commands.js';
// Add to module list
```

**Step 6: Run tests**

Run: `npm test -- --run tests/agent/prompt/modules/commands.test.ts`
Expected: PASS

Run: `npm test -- --run` (check prompt module count in integration tests -- may need updating)
Expected: PASS

**Step 7: Commit**

```bash
git add src/agent/prompt/modules/commands.ts src/agent/prompt/types.ts src/agent/prompt/builder.ts tests/agent/prompt/modules/commands.test.ts
git commit -m "feat: add commands prompt module for plugin slash commands"
```

---

## Task 11: Wire Plugin MCP Servers into Tool Stub Generation

At sandbox spin-up, include per-agent plugin MCP tools in the tool stub generation alongside global MCP tools.

**Files:**
- Modify: `src/host/server-completions.ts` -- query plugin MCP servers during stub generation
- Modify: `src/host/inprocess.ts` -- use McpConnectionManager for fast-path tool discovery

**Step 1: Understand current flow**

Currently in `server-completions.ts` (around line 880):
```typescript
const mcpTools = await providers.mcp.listTools();
const stubs = await prepareToolStubs({ documents, agentName, tools: mcpTools });
```

This only queries the global MCP provider. We need to also query per-agent plugin MCP servers.

**Step 2: Add McpConnectionManager to server deps**

Pass `mcpManager` through to `server-completions.ts`. On sandbox spin-up, merge tools from:
1. Global MCP provider (`providers.mcp.listTools()`) -- existing
2. Per-agent plugin MCP servers (`mcpManager.getServerUrls(agentName)`) -- new

```typescript
// Pseudocode for the change in server-completions.ts:
const allMcpTools: McpToolSchema[] = [];

// Existing: global MCP provider
if (providers.mcp) {
  allMcpTools.push(...await providers.mcp.listTools());
}

// New: per-agent plugin MCP servers
const pluginServerUrls = mcpManager.getServerUrls(agentName);
for (const url of pluginServerUrls) {
  const tools = await queryMcpServerTools(url); // generic MCP HTTP client
  allMcpTools.push(...tools);
}

const stubs = await prepareToolStubs({ documents, agentName, tools: allMcpTools });
```

**NOTE:** `queryMcpServerTools(url)` is a new generic MCP HTTP client function that speaks the MCP protocol to discover tools from a remote server. This is distinct from the Activepieces-specific client. See Task 13 (follow-up).

For the initial implementation, the MCP servers from plugins can be queried using the same HTTP pattern as `activepieces.ts` -- POST to the server's tool listing endpoint. The exact protocol depends on whether these are standard MCP HTTP servers (streamable HTTP transport). The MCP SDK's `Client` class handles this.

**Step 3: Update fast-path (inprocess.ts)**

Add `mcpManager` to `FastPathDeps`. In `discoverTools()`, query plugin MCP servers alongside the global provider.

**Step 4: Run tests**

Run: `npm test -- --run`
Expected: PASS

**Step 5: Commit**

```bash
git add src/host/server-completions.ts src/host/inprocess.ts
git commit -m "feat: wire plugin MCP servers into tool stub generation"
```

---

## Task 12: Reload Plugin State on Server Startup

On startup, repopulate the in-memory McpConnectionManager from stored plugin records, and auto-install declared plugins from config.

**Files:**
- Create: `src/plugins/startup.ts`
- Modify: `src/host/server.ts` (or `host-process.ts`) -- call on startup
- Test: `tests/plugins/startup.test.ts`

**Step 1: Write the failing test**

Test that `reloadPluginState` repopulates the MCP manager from stored plugin records.

**Step 2: Run test to verify it fails**

Run: `npm test -- --run tests/plugins/startup.test.ts`
Expected: FAIL

**Step 3: Implement**

```typescript
// src/plugins/startup.ts

/**
 * Reload: Repopulate McpConnectionManager from stored plugin records.
 * Called on startup since the manager is in-memory only.
 */
export async function reloadPluginMcpServers(
  documents: DocumentStore,
  mcpManager: McpConnectionManager,
): Promise<void> {
  // List all plugin keys, extract agent IDs, load each, re-register MCP servers
}

/**
 * Auto-install: Read config.plugins, install any that aren't already in DB.
 */
export async function autoInstallDeclaredPlugins(
  config: Config,
  documents: DocumentStore,
  mcpManager: McpConnectionManager,
  audit?: AuditProvider,
): Promise<void> {
  if (!config.plugins?.length) return;
  for (const decl of config.plugins) {
    for (const agentId of decl.agents) {
      // Check if already installed (by source or derived plugin name)
      // If not, call installPlugin()
    }
  }
}
```

**Step 4: Wire into server startup**

After `loadProviders()`, create `McpConnectionManager`, then:
1. `reloadPluginMcpServers(documents, mcpManager)` -- restore from DB
2. `autoInstallDeclaredPlugins(config, documents, mcpManager, audit)` -- install missing

**Step 5: Run tests**

Run: `npm test -- --run tests/plugins/startup.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add src/plugins/startup.ts src/host/server.ts tests/plugins/startup.test.ts
git commit -m "feat: reload plugin state and auto-install on startup"
```

---

## Summary of New Files

```
src/plugins/
+-- types.ts            # PluginManifest, PluginBundle, InstalledPlugin, etc.
+-- parser.ts           # Parse Cowork plugin file structure
+-- fetcher.ts          # Fetch from GitHub, local dir, URL
+-- store.ts            # Per-agent plugin + command DB storage
+-- install.ts          # Install/uninstall orchestrator
+-- mcp-manager.ts      # Per-agent MCP server registry (in-memory)
+-- startup.ts          # Reload from DB + auto-install on startup

src/cli/
+-- plugin.ts           # REWRITTEN: Cowork plugin CLI
+-- provider.ts         # NEW: moved existing npm provider CLI here

src/host/ipc-handlers/
+-- plugins.ts          # NEW: IPC handlers for plugin_install/uninstall/list_cowork

src/agent/prompt/modules/
+-- commands.ts         # NEW: slash command prompt module

tests/plugins/
+-- parser.test.ts
+-- fetcher.test.ts
+-- store.test.ts
+-- install.test.ts
+-- mcp-manager.test.ts
+-- startup.test.ts
```

## Modified Files

| File | Change |
|------|--------|
| `src/ipc-schemas.ts` | 3 new IPC action schemas (`_cowork` suffix) |
| `src/config.ts` | `plugins` field in ConfigSchema |
| `src/types.ts` | `PluginDeclaration`, `plugins` in Config |
| `src/host/ipc-server.ts` | Register plugin handlers, pass mcpManager |
| `src/host/server-completions.ts` | Query per-agent plugin MCP tools for stub generation |
| `src/host/inprocess.ts` | Accept McpConnectionManager for fast-path |
| `src/host/server.ts` | Create McpConnectionManager, startup hooks |
| `src/agent/prompt/types.ts` | `commands` field in PromptContext |
| `src/agent/prompt/builder.ts` | Register CommandsModule |
| `src/cli/index.ts` | Add `provider` subcommand |

## Follow-Up Work (Not in This Plan)

1. **Generic MCP HTTP client** -- Function to query arbitrary MCP servers (from `.mcp.json` URLs) for their tool schemas using the MCP protocol. Currently the only MCP client is the Activepieces-specific one. Needed for Task 11 to actually discover tools from plugin MCP servers.

2. **Dashboard UI** -- Admin "Plugins" tab for browsing, installing, managing plugins per agent. Connector auth OAuth flows.

3. **Plugin update** -- `ax plugin update <name>` to re-fetch and upgrade.

4. **Plugin marketplace/registry** -- Central discovery beyond GitHub.

5. **Connector auth flows** -- OAuth/API key setup for MCP servers declared in plugins.
