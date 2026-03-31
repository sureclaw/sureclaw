# Grep & Glob Tools Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add dedicated `grep` and `glob` tools to the pi-coding-agent, replacing raw bash `rg`/`find` usage with structured, context-window-safe alternatives.

**Architecture:** Two new singleton tools in the `sandbox` category, following the same IPC pattern as `bash`/`read_file`/`write_file`/`edit_file`. Each tool has: IPC Zod schema, tool catalog entry, host-side handler (spawns `rg`/`find`), local-sandbox method (container-local with audit gate), and MCP server definition (for claude-code runner).

**Tech Stack:** TypeBox (tool catalog), Zod (IPC schemas), Node.js `child_process.spawn` (host handlers), ripgrep `rg` (grep backend), `find` (glob backend)

---

### Task 1: IPC Schemas

**Files:**
- Modify: `src/ipc-schemas.ts:408-445` (sandbox tools section)

**Step 1: Add `SandboxGrepSchema` and `SandboxGlobSchema` to ipc-schemas.ts**

Add after the existing `SandboxEditFileSchema` block (around line 427), before the Sandbox Audit Gate section:

```typescript
export const SandboxGrepSchema = ipcAction('sandbox_grep', {
  pattern: safeString(10_000),
  path: safeString(1024).optional(),
  glob: safeString(1024).optional(),
  max_results: z.number().int().min(1).max(10_000).optional(),
  include_line_numbers: z.boolean().optional(),
  context_lines: z.number().int().min(0).max(20).optional(),
});

export const SandboxGlobSchema = ipcAction('sandbox_glob', {
  pattern: safeString(1024),
  path: safeString(1024).optional(),
  max_results: z.number().int().min(1).max(10_000).optional(),
});
```

**Step 2: Update `SandboxApproveSchema` enum to include new operations**

Change the operation enum from:
```typescript
operation: z.enum(['bash', 'read', 'write', 'edit']),
```
to:
```typescript
operation: z.enum(['bash', 'read', 'write', 'edit', 'grep', 'glob']),
```

**Step 3: Run tests to verify schemas register correctly**

Run: `npm test -- --run tests/agent/tool-catalog-sync.test.ts`
Expected: The sync test will now see `sandbox_grep` and `sandbox_glob` in IPC_SCHEMAS but not in the catalog — it will fail, which is expected (fixed in Task 2).

**Step 4: Commit**

```bash
git add src/ipc-schemas.ts
git commit -m "feat: add IPC schemas for sandbox_grep and sandbox_glob"
```

---

### Task 2: Tool Catalog Entries

**Files:**
- Modify: `src/agent/tool-catalog.ts:423-468` (sandbox section)

**Step 1: Add `grep` and `glob` tool entries to TOOL_CATALOG**

Add after the `edit_file` entry (around line 467), before the closing `] as const;`:

```typescript
  {
    name: 'grep',
    label: 'Search File Contents',
    description:
      'Search file contents using regex patterns. Returns matching lines with context.\n\n' +
      'Use this instead of running grep/rg via bash — it limits output to protect your context window.\n\n' +
      'Parameters:\n' +
      '- pattern: Regex pattern to search for (required)\n' +
      '- path: Directory to search in, relative to workspace (default: ".")\n' +
      '- glob: File filter pattern, e.g. "*.ts", "*.{js,jsx}" (optional)\n' +
      '- max_results: Maximum matching lines to return (default: 100)\n' +
      '- include_line_numbers: Show line numbers (default: true)\n' +
      '- context_lines: Lines of context around each match (default: 0)',
    parameters: Type.Object({
      pattern: Type.String({ description: 'Regex pattern to search for' }),
      path: Type.Optional(Type.String({ description: 'Directory to search in, relative to workspace (default: ".")' })),
      glob: Type.Optional(Type.String({ description: 'File filter pattern, e.g. "*.ts", "*.{js,jsx}"' })),
      max_results: Type.Optional(Type.Number({ description: 'Maximum matching lines to return (default: 100)' })),
      include_line_numbers: Type.Optional(Type.Boolean({ description: 'Show line numbers (default: true)' })),
      context_lines: Type.Optional(Type.Number({ description: 'Lines of context around each match (default: 0)' })),
    }),
    category: 'sandbox',
    singletonAction: 'sandbox_grep',
  },
  {
    name: 'glob',
    label: 'Find Files',
    description:
      'Find files by name or path pattern. Returns matching file paths.\n\n' +
      'Use this instead of running find/ls via bash — it limits output to protect your context window.\n\n' +
      'Parameters:\n' +
      '- pattern: Glob pattern, e.g. "**/*.ts", "src/**/*.test.*" (required)\n' +
      '- path: Base directory, relative to workspace (default: ".")\n' +
      '- max_results: Maximum files to return (default: 100)',
    parameters: Type.Object({
      pattern: Type.String({ description: 'Glob pattern, e.g. "**/*.ts", "src/**/*.test.*"' }),
      path: Type.Optional(Type.String({ description: 'Base directory, relative to workspace (default: ".")' })),
      max_results: Type.Optional(Type.Number({ description: 'Maximum files to return (default: 100)' })),
    }),
    category: 'sandbox',
    singletonAction: 'sandbox_glob',
  },
```

**Step 2: Run the catalog sync test**

Run: `npm test -- --run tests/agent/tool-catalog-sync.test.ts`
Expected: PASS — both schemas and catalog entries now exist.

**Step 3: Run ipc-tools test to see tool count failure**

Run: `npm test -- --run tests/agent/ipc-tools.test.ts`
Expected: FAIL — tool count tests will expect 18 but get 20. This is expected (fixed in Task 6).

**Step 4: Commit**

```bash
git add src/agent/tool-catalog.ts
git commit -m "feat: add grep and glob entries to tool catalog"
```

---

### Task 3: Host-Side Handlers

**Files:**
- Modify: `src/host/ipc-handlers/sandbox-tools.ts`

**Step 1: Add `sandbox_grep` handler**

Add after the `sandbox_edit_file` handler (around line 187), before the Sandbox Audit Gate section:

```typescript
    sandbox_grep: async (req: any, ctx: IPCContext) => {
      const workspace = resolveWorkspace(opts, ctx);
      const maxResults = req.max_results ?? 100;
      const includeLineNumbers = req.include_line_numbers !== false;
      const contextLines = req.context_lines ?? 0;

      // Build rg command
      const args: string[] = ['--no-heading', '--color', 'never'];
      if (includeLineNumbers) args.push('-n');
      if (contextLines > 0) args.push('-C', String(contextLines));
      if (req.glob) args.push('--glob', req.glob);
      args.push('--', req.pattern);

      // Resolve search path within workspace
      const searchPath = req.path
        ? safeWorkspacePath(workspace, req.path)
        : workspace;
      args.push(searchPath);

      return new Promise<{ matches: string; truncated: boolean; count: number }>((resolve) => {
        const child = spawn('rg', args, {
          cwd: workspace,
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        let output = '';
        let lineCount = 0;
        let truncated = false;

        child.stdout.on('data', (chunk: Buffer) => {
          if (truncated) return;
          const text = chunk.toString('utf-8');
          const lines = text.split('\n');
          for (const line of lines) {
            if (lineCount >= maxResults) {
              truncated = true;
              return;
            }
            if (line || lineCount > 0) {
              output += (output ? '\n' : '') + line;
              if (line) lineCount++;
            }
          }
        });

        child.on('close', async (code) => {
          await providers.audit.log({
            action: 'sandbox_grep',
            sessionId: ctx.sessionId,
            args: { pattern: req.pattern.slice(0, 200), path: req.path },
            result: code === 0 || code === 1 ? 'success' : 'error',
          });
          // rg exits 1 for "no matches" — that's not an error
          resolve({ matches: output, truncated, count: lineCount });
        });

        child.on('error', async (err) => {
          await providers.audit.log({
            action: 'sandbox_grep',
            sessionId: ctx.sessionId,
            args: { pattern: req.pattern.slice(0, 200) },
            result: 'error',
          });
          resolve({ matches: `Error: ${err.message}`, truncated: false, count: 0 });
        });
      });
    },
```

**Step 2: Add `sandbox_glob` handler**

Add after the `sandbox_grep` handler:

```typescript
    sandbox_glob: async (req: any, ctx: IPCContext) => {
      const workspace = resolveWorkspace(opts, ctx);
      const maxResults = req.max_results ?? 100;

      // Resolve base path within workspace
      const basePath = req.path
        ? safeWorkspacePath(workspace, req.path)
        : workspace;

      // Use rg --files with glob pattern for fast file listing
      const args: string[] = ['--files', '--glob', req.pattern, '--color', 'never'];
      args.push(basePath);

      return new Promise<{ files: string[]; truncated: boolean; count: number }>((resolve) => {
        const child = spawn('rg', args, {
          cwd: workspace,
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        const files: string[] = [];
        let buffer = '';
        let truncated = false;

        child.stdout.on('data', (chunk: Buffer) => {
          if (truncated) return;
          buffer += chunk.toString('utf-8');
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            if (!line) continue;
            if (files.length >= maxResults) {
              truncated = true;
              return;
            }
            // Return relative paths from workspace root
            files.push(line.startsWith(workspace) ? line.slice(workspace.length + 1) : line);
          }
        });

        child.on('close', async (code) => {
          // Process any remaining buffer content
          if (buffer && !truncated && files.length < maxResults) {
            files.push(buffer.startsWith(workspace) ? buffer.slice(workspace.length + 1) : buffer);
          }
          await providers.audit.log({
            action: 'sandbox_glob',
            sessionId: ctx.sessionId,
            args: { pattern: req.pattern, path: req.path },
            result: code === 0 || code === 1 ? 'success' : 'error',
          });
          resolve({ files, truncated, count: files.length });
        });

        child.on('error', async (err) => {
          await providers.audit.log({
            action: 'sandbox_glob',
            sessionId: ctx.sessionId,
            args: { pattern: req.pattern },
            result: 'error',
          });
          resolve({ files: [], truncated: false, count: 0 });
        });
      });
    },
```

**Step 3: Run the sandbox-tools test to verify existing tests still pass**

Run: `npm test -- --run tests/host/ipc-handlers/sandbox-tools.test.ts`
Expected: PASS — existing tests unaffected.

**Step 4: Commit**

```bash
git add src/host/ipc-handlers/sandbox-tools.ts
git commit -m "feat: add sandbox_grep and sandbox_glob host handlers"
```

---

### Task 4: Local Sandbox Execution (Container Mode)

**Files:**
- Modify: `src/agent/local-sandbox.ts`

**Step 1: Add `grep` method to local sandbox**

Add after the `editFile` method (around line 142), before the closing `};`:

```typescript
    async grep(pattern: string, opts?: {
      path?: string;
      glob?: string;
      max_results?: number;
      include_line_numbers?: boolean;
      context_lines?: number;
    }): Promise<{ matches: string; truncated: boolean; count: number }> {
      const approval = await approve({ operation: 'grep', path: opts?.path ?? '.' });
      if (!approval.approved) {
        return { matches: `Denied: ${approval.reason ?? 'denied by host policy'}`, truncated: false, count: 0 };
      }

      const maxResults = opts?.max_results ?? 100;
      const includeLineNumbers = opts?.include_line_numbers !== false;
      const contextLines = opts?.context_lines ?? 0;

      const args: string[] = ['--no-heading', '--color', 'never'];
      if (includeLineNumbers) args.push('-n');
      if (contextLines > 0) args.push('-C', String(contextLines));
      if (opts?.glob) args.push('--glob', opts.glob);
      args.push('--', pattern);

      const searchPath = opts?.path
        ? safeWorkspacePath(opts.path)
        : workspace;
      args.push(searchPath);

      return new Promise<{ matches: string; truncated: boolean; count: number }>((resolve) => {
        const child = spawn('rg', args, {
          cwd: workspace,
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        let output = '';
        let lineCount = 0;
        let truncated = false;

        child.stdout.on('data', (chunk: Buffer) => {
          if (truncated) return;
          const text = chunk.toString('utf-8');
          const lines = text.split('\n');
          for (const line of lines) {
            if (lineCount >= maxResults) { truncated = true; return; }
            if (line || lineCount > 0) {
              output += (output ? '\n' : '') + line;
              if (line) lineCount++;
            }
          }
        });

        child.on('close', () => {
          report({ operation: 'grep', path: opts?.path ?? '.', success: true });
          resolve({ matches: output, truncated, count: lineCount });
        });

        child.on('error', (err) => {
          report({ operation: 'grep', path: opts?.path ?? '.', success: false, error: err.message });
          resolve({ matches: `Error: ${err.message}`, truncated: false, count: 0 });
        });
      });
    },
```

**Step 2: Add `glob` method to local sandbox**

Add after the `grep` method:

```typescript
    async glob(pattern: string, opts?: {
      path?: string;
      max_results?: number;
    }): Promise<{ files: string[]; truncated: boolean; count: number }> {
      const approval = await approve({ operation: 'glob', path: opts?.path ?? '.' });
      if (!approval.approved) {
        return { files: [], truncated: false, count: 0 };
      }

      const maxResults = opts?.max_results ?? 100;
      const basePath = opts?.path
        ? safeWorkspacePath(opts.path)
        : workspace;

      const args: string[] = ['--files', '--glob', pattern, '--color', 'never', basePath];

      return new Promise<{ files: string[]; truncated: boolean; count: number }>((resolve) => {
        const child = spawn('rg', args, {
          cwd: workspace,
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        const files: string[] = [];
        let buffer = '';
        let truncated = false;

        child.stdout.on('data', (chunk: Buffer) => {
          if (truncated) return;
          buffer += chunk.toString('utf-8');
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            if (!line) continue;
            if (files.length >= maxResults) { truncated = true; return; }
            files.push(line.startsWith(workspace) ? line.slice(workspace.length + 1) : line);
          }
        });

        child.on('close', () => {
          if (buffer && !truncated && files.length < maxResults) {
            files.push(buffer.startsWith(workspace) ? buffer.slice(workspace.length + 1) : buffer);
          }
          report({ operation: 'glob', path: opts?.path ?? '.', success: true });
          resolve({ files, truncated, count: files.length });
        });

        child.on('error', (err) => {
          report({ operation: 'glob', path: opts?.path ?? '.', success: false, error: err.message });
          resolve({ files: [], truncated: false, count: 0 });
        });
      });
    },
```

Note: Add `import { spawn } from 'node:child_process';` at the top if not already imported (it's not — only `readFileSync`, `writeFileSync`, `mkdirSync` are imported).

**Step 3: Commit**

```bash
git add src/agent/local-sandbox.ts
git commit -m "feat: add grep and glob to local sandbox executor"
```

---

### Task 5: IPC Tool Routing

**Files:**
- Modify: `src/agent/ipc-tools.ts:60-72` (sandbox routing switch)

**Step 1: Add grep and glob to the local sandbox routing switch**

In the `if (sandbox && spec.category === 'sandbox')` block, add two new cases:

```typescript
          case 'sandbox_grep':
            return text(JSON.stringify(await sandbox.grep(
              callParams.pattern as string,
              {
                path: callParams.path as string | undefined,
                glob: callParams.glob as string | undefined,
                max_results: callParams.max_results as number | undefined,
                include_line_numbers: callParams.include_line_numbers as boolean | undefined,
                context_lines: callParams.context_lines as number | undefined,
              },
            )));
          case 'sandbox_glob':
            return text(JSON.stringify(await sandbox.glob(
              callParams.pattern as string,
              {
                path: callParams.path as string | undefined,
                max_results: callParams.max_results as number | undefined,
              },
            )));
```

**Step 2: Commit**

```bash
git add src/agent/ipc-tools.ts
git commit -m "feat: route grep and glob tools through local sandbox"
```

---

### Task 6: MCP Server (Claude Code Runner)

**Files:**
- Modify: `src/agent/mcp-server.ts:300-340` (sandbox tools section)

**Step 1: Add grep and glob MCP tool definitions**

Add after the `edit_file` tool definition (around line 339), before the closing `];`:

```typescript
    // ── Grep (search file contents) ──
    tool('grep', getToolDescription('grep'),
      {
        pattern: z.string().describe('Regex pattern to search for'),
        path: z.string().optional().describe('Directory to search in, relative to workspace (default: ".")'),
        glob: z.string().optional().describe('File filter pattern, e.g. "*.ts", "*.{js,jsx}"'),
        max_results: z.number().optional().describe('Maximum matching lines to return (default: 100)'),
        include_line_numbers: z.boolean().optional().describe('Show line numbers (default: true)'),
        context_lines: z.number().optional().describe('Lines of context around each match (default: 0)'),
      },
      sandbox
        ? async (args) => textResult(await sandbox.grep(args.pattern, {
            path: args.path,
            glob: args.glob,
            max_results: args.max_results,
            include_line_numbers: args.include_line_numbers,
            context_lines: args.context_lines,
          }))
        : (args) => {
            const params = Object.fromEntries(Object.entries(args).filter(([_, v]) => v !== undefined));
            return ipcCall('sandbox_grep', params);
          },
    ),

    // ── Glob (find files by pattern) ──
    tool('glob', getToolDescription('glob'),
      {
        pattern: z.string().describe('Glob pattern, e.g. "**/*.ts", "src/**/*.test.*"'),
        path: z.string().optional().describe('Base directory, relative to workspace (default: ".")'),
        max_results: z.number().optional().describe('Maximum files to return (default: 100)'),
      },
      sandbox
        ? async (args) => textResult(await sandbox.glob(args.pattern, {
            path: args.path,
            max_results: args.max_results,
          }))
        : (args) => {
            const params = Object.fromEntries(Object.entries(args).filter(([_, v]) => v !== undefined));
            return ipcCall('sandbox_glob', params);
          },
    ),
```

**Step 2: Commit**

```bash
git add src/agent/mcp-server.ts
git commit -m "feat: add grep and glob tools to MCP server"
```

---

### Task 7: Tool Style Prompt Update

**Files:**
- Modify: `src/agent/prompt/modules/tool-style.ts`

**Step 1: Add guidance to prefer grep/glob over bash equivalents**

In the `render()` method, add a new section after the Errors paragraph:

```typescript
      '',
      '**Search**: Prefer `grep` over `bash` + `rg`/`grep` for content search, and',
      '`glob` over `bash` + `find`/`ls` for file discovery. These tools limit output',
      'to avoid flooding your context window.',
```

And in `renderMinimal()`, append to the existing line:

```typescript
      '## Tools',
      'Don\'t narrate routine tool calls. Batch independent calls. Try alternatives on failure. Use grep/glob instead of bash for search.',
```

**Step 2: Commit**

```bash
git add src/agent/prompt/modules/tool-style.ts
git commit -m "feat: update tool-style prompt to prefer grep/glob over bash"
```

---

### Task 8: Tests

**Files:**
- Modify: `tests/host/ipc-handlers/sandbox-tools.test.ts`
- Modify: `tests/agent/ipc-tools.test.ts`
- Modify: `tests/sandbox-isolation.test.ts`

**Step 1: Add sandbox_grep tests to sandbox-tools.test.ts**

Add a new describe block after the `sandbox_edit_file` section:

```typescript
  // ── sandbox_grep ──

  describe('sandbox_grep', () => {
    test('finds matching lines in files', async () => {
      writeFileSync(join(workspace, 'test.ts'), 'const foo = 1;\nconst bar = 2;\nconst foobar = 3;\n');
      const handlers = createSandboxToolHandlers(providers, { workspaceMap });
      const result = await handlers.sandbox_grep({ pattern: 'foo' }, ctx);
      expect(result.matches).toContain('foo');
      expect(result.count).toBeGreaterThanOrEqual(2);
    });

    test('respects max_results limit', async () => {
      const lines = Array.from({ length: 50 }, (_, i) => `line ${i} match`).join('\n');
      writeFileSync(join(workspace, 'big.txt'), lines);
      const handlers = createSandboxToolHandlers(providers, { workspaceMap });
      const result = await handlers.sandbox_grep({ pattern: 'match', max_results: 5 }, ctx);
      expect(result.count).toBe(5);
      expect(result.truncated).toBe(true);
    });

    test('returns empty for no matches', async () => {
      writeFileSync(join(workspace, 'empty.txt'), 'nothing here');
      const handlers = createSandboxToolHandlers(providers, { workspaceMap });
      const result = await handlers.sandbox_grep({ pattern: 'zzz_no_match' }, ctx);
      expect(result.count).toBe(0);
    });

    test('filters by glob pattern', async () => {
      writeFileSync(join(workspace, 'code.ts'), 'const x = 1;');
      writeFileSync(join(workspace, 'readme.md'), 'const y = 2;');
      const handlers = createSandboxToolHandlers(providers, { workspaceMap });
      const result = await handlers.sandbox_grep({ pattern: 'const', glob: '*.ts' }, ctx);
      expect(result.matches).toContain('code.ts');
      expect(result.matches).not.toContain('readme.md');
    });

    test('audits the grep operation', async () => {
      writeFileSync(join(workspace, 'a.txt'), 'hello');
      const handlers = createSandboxToolHandlers(providers, { workspaceMap });
      await handlers.sandbox_grep({ pattern: 'hello' }, ctx);
      expect(providers.audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'sandbox_grep',
          sessionId: 'test-session',
          result: 'success',
        }),
      );
    });
  });
```

**Step 2: Add sandbox_glob tests to sandbox-tools.test.ts**

```typescript
  // ── sandbox_glob ──

  describe('sandbox_glob', () => {
    test('finds files matching pattern', async () => {
      writeFileSync(join(workspace, 'app.ts'), '');
      writeFileSync(join(workspace, 'app.test.ts'), '');
      mkdirSync(join(workspace, 'src'), { recursive: true });
      writeFileSync(join(workspace, 'src', 'index.ts'), '');
      const handlers = createSandboxToolHandlers(providers, { workspaceMap });
      const result = await handlers.sandbox_glob({ pattern: '*.ts' }, ctx);
      expect(result.files.length).toBeGreaterThanOrEqual(2);
    });

    test('respects max_results limit', async () => {
      for (let i = 0; i < 20; i++) {
        writeFileSync(join(workspace, `file${i}.txt`), '');
      }
      const handlers = createSandboxToolHandlers(providers, { workspaceMap });
      const result = await handlers.sandbox_glob({ pattern: '*.txt', max_results: 5 }, ctx);
      expect(result.files.length).toBe(5);
      expect(result.truncated).toBe(true);
    });

    test('returns empty for no matches', async () => {
      writeFileSync(join(workspace, 'file.txt'), '');
      const handlers = createSandboxToolHandlers(providers, { workspaceMap });
      const result = await handlers.sandbox_glob({ pattern: '*.xyz' }, ctx);
      expect(result.files.length).toBe(0);
    });

    test('audits the glob operation', async () => {
      const handlers = createSandboxToolHandlers(providers, { workspaceMap });
      await handlers.sandbox_glob({ pattern: '*.ts' }, ctx);
      expect(providers.audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'sandbox_glob',
          sessionId: 'test-session',
          result: 'success',
        }),
      );
    });
  });
```

**Step 3: Update tool count in ipc-tools.test.ts**

Change line 157:
```typescript
  test('total tool count is 20 without filter', () => {
    // ...
    expect(tools.length).toBe(20);
  });
```

Change line 226:
```typescript
    // memory(1) + web(1) + audit(1) + identity(1) + agent(1) + image(1) + credential(1) + skill(1) + sandbox(6) = 14 tools
    expect(names).toContain('grep');
    expect(names).toContain('glob');
    expect(tools.length).toBe(14);
```

**Step 4: Update MCP tool count in sandbox-isolation.test.ts**

Change the `exposes exactly 18 IPC tools` test (line 427):
- Update test name to `'exposes exactly 20 IPC tools'`
- Add `'grep', 'glob'` to the expected array
- Change `expect(Object.keys(tools).length).toBe(18)` to `.toBe(20)`

**Step 5: Run full test suite**

Run: `npm test -- --run`
Expected: ALL PASS

**Step 6: Commit**

```bash
git add tests/host/ipc-handlers/sandbox-tools.test.ts tests/agent/ipc-tools.test.ts tests/sandbox-isolation.test.ts
git commit -m "test: add grep/glob handler tests, update tool count assertions"
```

---

### Task 9: Update Prompt Module Test (if needed)

**Files:**
- Check: `tests/agent/prompt/` for any tests that assert on ToolStyleModule output

**Step 1: Search for affected tests**

Run: `grep -r "tool.style\|ToolStyle\|narrat" tests/agent/prompt/`

If tests assert on exact ToolStyleModule render output, update them to include the new "Search" section.

**Step 2: Run full test suite again to catch any stragglers**

Run: `npm test -- --run`
Expected: ALL PASS

**Step 3: Commit (if changes needed)**

```bash
git add tests/
git commit -m "test: update prompt module tests for grep/glob guidance"
```

---

### Summary of All Files Modified

| File | Change |
|------|--------|
| `src/ipc-schemas.ts` | Add `SandboxGrepSchema`, `SandboxGlobSchema`, update `SandboxApproveSchema` enum |
| `src/agent/tool-catalog.ts` | Add `grep` and `glob` tool entries |
| `src/host/ipc-handlers/sandbox-tools.ts` | Add `sandbox_grep` and `sandbox_glob` handlers |
| `src/agent/local-sandbox.ts` | Add `grep()` and `glob()` methods, import `spawn` |
| `src/agent/ipc-tools.ts` | Add routing cases for `sandbox_grep` and `sandbox_glob` |
| `src/agent/mcp-server.ts` | Add `grep` and `glob` MCP tool definitions |
| `src/agent/prompt/modules/tool-style.ts` | Add guidance to prefer grep/glob over bash |
| `tests/host/ipc-handlers/sandbox-tools.test.ts` | Add grep/glob handler tests |
| `tests/agent/ipc-tools.test.ts` | Update tool count: 18→20, 12→14 |
| `tests/sandbox-isolation.test.ts` | Update MCP tool count: 18→20 |
