# Database MCP Provider Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the Activepieces MCP gateway with a database-backed provider that manages multiple per-agent HTTP/SSE MCP server definitions, with CLI and admin API management.

**Architecture:** New `database` MCP provider implements the existing `McpProvider` interface. Each agent can have multiple MCP server records in a `mcp_servers` DB table. The provider aggregates tools from all enabled servers for the requesting agent, prefixing tool names with server name to avoid collisions. Credentials are stored in the credential provider, referenced by placeholder syntax in headers.

**Tech Stack:** Kysely (DB), Zod (validation), existing CredentialProvider interface, HTTP fetch for MCP server communication.

---

### Task 1: Remove Activepieces — Delete Provider and Tests

**Files:**
- Delete: `src/providers/mcp/activepieces.ts`
- Delete: `tests/providers/mcp/activepieces.test.ts`
- Modify: `src/host/provider-map.ts:96-99`
- Modify: `src/config.ts:165-173`
- Modify: `src/types.ts:160-167`
- Modify: `src/cli/k8s-init.ts`
- Modify: `tests/cli/k8s-init.test.ts`

**Step 1: Delete activepieces files**

Delete `src/providers/mcp/activepieces.ts` and `tests/providers/mcp/activepieces.test.ts`.

**Step 2: Update provider-map.ts**

In `src/host/provider-map.ts`, change the mcp entry from:
```typescript
  mcp: {
    none:         '../providers/mcp/none.js',
    activepieces: '../providers/mcp/activepieces.js',
  },
```
To:
```typescript
  mcp: {
    none:     '../providers/mcp/none.js',
    database: '../providers/mcp/database.js',
  },
```

**Step 3: Remove mcp config block from config.ts**

In `src/config.ts`, delete the entire `mcp:` Zod block (lines 165-173):
```typescript
  mcp: z.strictObject({
    url: z.string().url().default('http://localhost:8080'),
    ...
  }).optional(),
```

**Step 4: Remove mcp field from types.ts**

In `src/types.ts`, delete the `mcp?` field and its comment from the Config interface (lines 160-167).

**Step 5: Remove activepieces from k8s-init.ts**

In `src/cli/k8s-init.ts`:
- Remove `mcpUrl` from `InitOptions` interface
- Remove `--mcp-url` CLI arg parsing
- Remove the MCP provider YAML generation block (~lines 200-206)
- Remove the Activepieces MCP wizard question block (~lines 352-365)

**Step 6: Update k8s-init tests**

In `tests/cli/k8s-init.test.ts`, remove test assertions referencing `activepieces` or `mcpUrl`.

**Step 7: Verify build**

Run: `npm run build`
Expected: No compile errors.

**Step 8: Commit**

```
git commit -m "refactor: remove activepieces MCP provider"
```

---

### Task 2: Add Database Migration for mcp_servers Table

**Files:**
- Modify: `src/providers/storage/migrations.ts`

**Step 1: Add migration**

In `src/providers/storage/migrations.ts`, add after `storage_005_chat_sessions`:

```typescript
    storage_006_mcp_servers: {
      async up(db: Kysely<any>) {
        await db.schema
          .createTable('mcp_servers')
          .ifNotExists()
          .addColumn('id', 'text', col => col.primaryKey())
          .addColumn('agent_id', 'text', col => col.notNull())
          .addColumn('name', 'text', col => col.notNull())
          .addColumn('url', 'text', col => col.notNull())
          .addColumn('headers', 'text')
          .addColumn('enabled', 'integer', col => col.notNull().defaultTo(1))
          .addColumn('created_at', isSqlite ? 'text' : 'timestamptz', col =>
            col.notNull().defaultTo(isSqlite ? sql`(datetime('now'))` : sql`NOW()`))
          .addColumn('updated_at', isSqlite ? 'text' : 'timestamptz', col =>
            col.notNull().defaultTo(isSqlite ? sql`(datetime('now'))` : sql`NOW()`))
          .execute();

        await db.schema
          .createIndex('idx_mcp_servers_agent')
          .ifNotExists()
          .on('mcp_servers')
          .column('agent_id')
          .execute();

        await db.schema
          .createIndex('idx_mcp_servers_unique')
          .ifNotExists()
          .unique()
          .on('mcp_servers')
          .columns(['agent_id', 'name'])
          .execute();
      },
      async down(db: Kysely<any>) {
        await db.schema.dropTable('mcp_servers').ifExists().execute();
      },
    },
```

**Step 2: Verify build and tests**

Run: `npm run build && npm test -- --run tests/providers/storage/`
Expected: PASS

**Step 3: Commit**

```
git commit -m "feat: add mcp_servers database migration"
```

---

### Task 3: Add agentId to McpProvider listTools Filter

**Files:**
- Modify: `src/providers/mcp/types.ts:32`
- Modify: `src/host/inprocess.ts:169`

**Step 1: Update McpProvider interface**

In `src/providers/mcp/types.ts:32`, change:
```typescript
  listTools(filter?: { apps?: string[]; query?: string }): Promise<McpToolSchema[]>;
```
To:
```typescript
  listTools(filter?: { apps?: string[]; query?: string; agentId?: string }): Promise<McpToolSchema[]>;
```

**Step 2: Pass agentId in discoverTools**

In `src/host/inprocess.ts:169`, change:
```typescript
  const filter = hinted.length > 0 ? { apps: hinted } : { apps: installedApps };
```
To:
```typescript
  const filter = hinted.length > 0 ? { apps: hinted, agentId } : { apps: installedApps, agentId };
```

**Step 3: Verify build**

Run: `npm run build`
Expected: PASS

**Step 4: Commit**

```
git commit -m "feat: add agentId to McpProvider listTools filter"
```

---

### Task 4: Implement Database MCP Provider

**Files:**
- Create: `src/providers/mcp/database.ts`
- Create: `tests/providers/mcp/database.test.ts`

**Step 1: Write test file**

Create `tests/providers/mcp/database.test.ts` with tests for:
- `resolveHeaders()` — resolves `{CRED_NAME}` placeholders via credential provider
- `resolveHeaders()` — leaves placeholder if credential not found
- `parseServerFromToolName()` — extracts server name and tool name from `server__tool` format
- `parseServerFromToolName()` — returns undefined for unprefixed names
- Module exports `create` function

**Step 2: Run test to verify it fails**

Run: `npm test -- --run tests/providers/mcp/database.test.ts`
Expected: FAIL — module not found

**Step 3: Write provider implementation**

Create `src/providers/mcp/database.ts` with:

- **`CircuitBreaker` class** — per-server, threshold 5, cooldown 30s (same pattern as old activepieces)
- **`DatabaseMcpProvider` class** implementing `McpProvider`:
  - `listTools(filter)` — queries `mcp_servers` by `agent_id`, connects to each enabled server via JSON-RPC `tools/list`, prefixes tool names with `{server}__`, caches with 60s TTL
  - `callTool(call)` — parses server from tool prefix, resolves credential headers, forwards via JSON-RPC `tools/call`, taint-tags result
  - `credentialStatus()` — checks if header placeholders can be resolved
  - `storeCredential()` — delegates to credential provider
  - `listApps()` — returns unique server names from DB
- **CRUD helpers** (exported for CLI/admin): `addMcpServer()`, `removeMcpServer()`, `listMcpServers()`, `updateMcpServer()`, `testMcpServer()`
- **`resolveHeaders()`** and **`parseServerFromToolName()`** exported for testing
- **`create(config, name, { database, credentials })`** factory

Key details:
- Tool name separator is double underscore (`__`) to avoid conflicts with single underscores in tool names
- JSON-RPC 2.0 protocol for MCP server communication (`tools/list`, `tools/call`)
- Per-server circuit breakers — one server failing doesn't affect others
- `listTools` returns `[]` for servers with open circuit breakers (graceful degradation)
- All results taint-tagged as `{ source: 'mcp:{server}:{tool}', trust: 'external' }`

**Step 4: Run tests**

Run: `npm test -- --run tests/providers/mcp/database.test.ts`
Expected: PASS

**Step 5: Commit**

```
git commit -m "feat: add database-backed MCP provider"
```

---

### Task 5: Wire Database MCP Provider in Registry

**Files:**
- Modify: `src/host/registry.ts:110-113`

**Step 1: Update MCP loading with deps**

In `src/host/registry.ts`, change:
```typescript
  const mcp = config.providers.mcp
    ? await loadProvider('mcp', config.providers.mcp, config)
    : undefined;
```
To:
```typescript
  let mcp;
  if (config.providers.mcp === 'database') {
    const mcpModPath = resolveProviderPath('mcp', 'database');
    const mcpMod = await import(mcpModPath);
    mcp = await mcpMod.create(config, 'database', { database, credentials });
  } else if (config.providers.mcp) {
    mcp = await loadProvider('mcp', config.providers.mcp, config);
  }
```

**Step 2: Verify build**

Run: `npm run build`
Expected: PASS

**Step 3: Commit**

```
git commit -m "feat: wire database MCP provider with DB and credential deps"
```

---

### Task 6: Add CLI mcp Command

**Files:**
- Create: `src/cli/mcp.ts`
- Modify: `src/cli/index.ts`

**Step 1: Create CLI handler**

Create `src/cli/mcp.ts` with:
- `runMcp(args)` — routes to subcommands
- `handleAdd(args)` — parses `<agent> <name> --url <url> [--header "K: V"]...`, validates URL, calls `addMcpServer()`
- `handleRemove(args)` — parses `<agent> <name>`, calls `removeMcpServer()`
- `handleList(args)` — parses `<agent>`, calls `listMcpServers()`, pretty-prints table
- `handleTest(args)` — parses `<agent> <name>`, calls `testMcpServer()`, prints tools or error
- `loadDeps()` — loads config, database, runs migrations, loads credentials

**Step 2: Register in CLI router**

In `src/cli/index.ts`:
- Add `mcp?: (args: string[]) => Promise<void>` to `CommandHandlers`
- Add `case 'mcp':` to switch
- Add `'mcp'` to `knownCommands` set
- Add handler: `mcp: async (mcpArgs) => { const { runMcp } = await import('./mcp.js'); await runMcp(mcpArgs); }`
- Update `showHelp()` with `ax mcp <command>` line

**Step 3: Verify build**

Run: `npm run build`
Expected: PASS

**Step 4: Commit**

```
git commit -m "feat: add ax mcp CLI commands (add/remove/list/test)"
```

---

### Task 7: Add Admin API Endpoints for MCP Servers

**Files:**
- Modify: `src/host/server-admin.ts`

**Step 1: Add MCP server endpoints**

In `handleAdminAPI()`, before the final `sendError(res, 404)`, add:

- `GET /admin/api/agents/:id/mcp-servers` — calls `listMcpServers(providers.database.db, id)`
- `POST /admin/api/agents/:id/mcp-servers` — parses body `{name, url, headers?}`, calls `addMcpServer()`
- `DELETE /admin/api/agents/:id/mcp-servers/:name` — calls `removeMcpServer()`
- `PUT /admin/api/agents/:id/mcp-servers/:name` — parses body, calls `updateMcpServer()`
- `POST /admin/api/agents/:id/mcp-servers/:name/test` — calls `testMcpServer()`

Pattern: use regex matches like the existing routes, lazy-import `../providers/mcp/database.js` for CRUD helpers. Guard `providers.database` existence. Return 404 if server not found for delete/update.

**Step 2: Verify build**

Run: `npm run build`
Expected: PASS

**Step 3: Commit**

```
git commit -m "feat: add admin API endpoints for MCP server management"
```

---

### Task 8: Update Documentation and Skills

**Files:**
- Modify: `README.md`
- Modify: `.claude/skills/ax-host/SKILL.md`
- Modify: `.claude/skills/ax-cli/SKILL.md`

**Step 1: Update README.md**

- Replace `activepieces` with `database` in MCP provider table
- Remove Activepieces Docker/K8s deployment YAML examples
- Update config example to show `mcp: database`
- Add `ax mcp` CLI usage

**Step 2: Update skills**

- `ax-host/SKILL.md`: Replace activepieces MCP references with database provider
- `ax-cli/SKILL.md`: Add mcp command, remove activepieces from k8s-init

**Step 3: Commit**

```
git commit -m "docs: update MCP provider references for database provider"
```

---

### Task 9: Verify End-to-End

**Step 1: Run full test suite**

Run: `npm test`
Expected: PASS

**Step 2: Run build**

Run: `npm run build`
Expected: PASS

**Step 3: Search for remaining activepieces references**

Search source and test files for "activepieces". Only docs/plans historical files should remain.
Expected: No matches in `src/` or `tests/`

**Step 4: Final commit if needed**

```
git commit -m "chore: final cleanup of activepieces references"
```
