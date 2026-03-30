# MCP CLI Tools Design

## Problem

The current TypeScript stub approach for MCP tool access has a large fragility surface:
- Node `--experimental-strip-types` (unstable API)
- Proxy `.then()` not being a real thenable
- Import path resolution (`.ts` vs `.js`, relative paths)
- Shell escaping of JSON args
- Prompt engineering to teach LLMs how to use stubs
- Cache invalidation when runtime template changes

## Solution

Replace TypeScript stubs with **one executable CLI per MCP server** in `./bin/`:

```
linear list issues --team Product --cycle ea2d2a1b
linear get issue --id PROD-2410
linear --help
```

## Design

### File Structure

```
/workspace/bin/linear     # #!/usr/bin/env node, chmod +x, plain JS
/workspace/bin/github      # one file per MCP server
```

`./bin/` is in PATH. The system prompt lists available tools:

```
**MCP tools** (in PATH — run <tool> --help for usage):
  linear
```

### CLI Interface

All parameters are flags. No positional args.

```bash
# List/query
linear list issues --team Product --cycle ea2d2a1b --limit 50
linear list teams
linear list cycles --teamId 32a14af8

# Get by ID
linear get issue --id PROD-2410
linear get team --id 32a14af8

# Create/update
linear save issue --title "Bug report" --team Product --priority 2
linear create document --title "Notes" --content "..."

# Delete
linear delete comment --id abc123
```

### Help Output

Grouped by resource, compact:

```
Usage: linear <verb> <resource> [--flags]

Issues:
  list issues     List issues [--team, --cycle, --assignee, --state, --label, --limit, --cursor]
  get issue       Get issue details [--id, --includeRelations]
  save issue      Create/update issue [--id, --title, --team, --state, --assignee, --priority]

Cycles:
  list cycles     List cycles [--teamId, --type]

Teams:
  list teams      List teams [--limit]
  get team        Get team details [--id]
...
```

### Argument Parsing

- `process.argv` → verb + noun + `--flag value` pairs
- If stdin is piped JSON object, its keys are merged as params
- Explicit `--flags` override stdin keys

```bash
# Direct call
linear list cycles --teamId 32a14af8

# Piped — stdin JSON merged with flags
linear list teams | jq '{ teamId: .[0].id }' | linear list cycles

# Flags override stdin
linear list teams | jq '{ teamId: .[0].id }' | linear list cycles --type active
```

### Output Format

- Stdout: clean JSON (for piping)
- Stderr: errors (don't pollute pipes)
- Exit code 0 on success, 1 on error
- If result is an object with a single array property (e.g. `{ teams: [...] }`), output just the array

### Generated Code Structure

One self-contained JS file per MCP server:

```js
#!/usr/bin/env node
// Auto-generated CLI for linear MCP server. Do not edit.

// ── IPC ──
async function ipc(tool, params) {
  const res = await fetch(`${process.env.AX_HOST_URL}/internal/ipc`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.AX_IPC_TOKEN}`,
    },
    body: JSON.stringify({ action: 'tool_batch', calls: [{ tool, args: params }] }),
  });
  if (!res.ok) { process.stderr.write(`Error: HTTP ${res.status}\n`); process.exit(1); }
  const { results } = await res.json();
  return results[0];
}

// ── Tool registry (generated from MCP schemas) ──
const TOOLS = {
  'list issues': {
    tool: 'list_issues',
    desc: 'List issues',
    group: 'Issues',
    params: ['limit', 'team', 'cycle', 'assignee', 'state', 'label', 'cursor'],
  },
  'get issue': {
    tool: 'get_issue',
    desc: 'Get issue details',
    group: 'Issues',
    params: ['id', 'includeRelations', 'includeCustomerNeeds'],
  },
  // ... all tools
};

// ── Argv parser, stdin, help, runner (~40 lines) ──
```

The `TOOLS` map is the only generated part. The argv parser, help formatter,
stdin handling, and IPC client are identical for every server.

### IPC Transport

HTTP only — no Unix socket. These CLIs only run inside k8s sandboxes where
`AX_HOST_URL` and `AX_IPC_TOKEN` are always set.

### Codegen Changes

Replace `src/host/capnweb/codegen.ts`:
- `generateRuntime()` → removed (no shared runtime file)
- `generateToolStub()` → removed (no per-tool files)
- `generateBarrel()` → removed (no barrel)
- New: `generateCLI(server, tools)` → single JS file with shebang
- New: `mcpToolToCLICommand(tool)` → parses `list_issues` → `{ verb: 'list', noun: 'issues' }`

### Runner Changes

`src/agent/runner.ts` `applyPayload()`:
- Instead of writing files to `agentWorkspace/tools/`, write to `workspace/bin/`
- Set `chmod +x` on each file
- `./bin/` is already in PATH

### Prompt Changes

`src/agent/prompt/modules/runtime.ts`:
- Remove all tool stub prompt text
- Add single line: `**MCP tools** (in PATH — run <tool> --help for usage): linear`
- Remove `hasToolStubs` / `toolStubServers` context — replace with `mcpCLIs: string[]`

### What Gets Removed

- `src/host/capnweb/codegen.ts` — `generateRuntime()`, `generateToolStub()`, `generateBarrel()`
- `agent/tools/` directory and all generated `.ts` files
- `_runtime.ts` template (HTTP IPC, socket IPC, Proxy batching)
- `hasToolStubs` / `toolStubServers` in prompt context
- `scanToolStubServers()` in agent-setup.ts
- Barrel scanning logic
- Import path handling
- `--experimental-strip-types` dependency
