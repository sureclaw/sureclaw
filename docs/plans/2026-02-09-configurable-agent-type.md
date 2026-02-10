# Configurable Agent Type: pi-agent-core / pi-coding-agent / claude-code

## Context

AX currently hardcodes pi-agent-core's `Agent` class in `agent-runner.ts`. The plan to upgrade to pi-coding-agent's `createAgentSession()` was abandoned because it doesn't accept `streamFn`. However, pi-ai has a **provider registry** (`registerApiProvider()`) that allows registering custom LLM providers — we can register an IPC-based provider so `createAgentSession()` routes LLM calls through the host without needing `streamFn`. For claude-code, `ANTHROPIC_BASE_URL` can point to a proxy that translates the Anthropic Messages API to IPC calls.

This plan makes the agent type configurable via `ax.yaml`, giving users three options with different capability tradeoffs.

---

## Config

Add top-level `agent` field to `ax.yaml`:

```yaml
agent: pi-agent-core       # default — lightweight, ~50KB Agent class
# agent: pi-coding-agent   # persistent JSONL sessions, auto-compaction, extensions
# agent: claude-code        # claude-agent-sdk with full coding tools
```

---

## Task 0: Config Schema + Agent Runner Dispatch

**Files:**
- Modify: `src/config.ts` — add `agent` field (optional, default `'pi-agent-core'`)
- Modify: `src/providers/types.ts` — add `AgentType` type to `Config`
- Modify: `src/container/agent-runner.ts` — add `--agent` flag, dispatch to agent implementations
- Modify: `src/server.ts` — pass `config.agent` to spawn command

**Config schema change:**
```typescript
// src/config.ts
const ConfigSchema = z.strictObject({
  agent: z.enum(['pi-agent-core', 'pi-coding-agent', 'claude-code']).default('pi-agent-core'),
  profile: z.enum(PROFILE_NAMES),
  // ... rest unchanged
});
```

**Server spawn change** (`src/server.ts:298-309`):
```typescript
const agentType = config.agent ?? 'pi-agent-core';
command: [tsxBin, resolve('src/container/agent-runner.ts'),
  '--agent', agentType,
  '--ipc-socket', ipcSocketPath,
  '--workspace', workspace,
  '--skills', skillsDir,
],
```

**Agent runner dispatch** (`src/container/agent-runner.ts`):
- Add `--agent` to `parseArgs()`
- Keep current logic as `runPiCore()` (default)
- Dispatch: `pi-agent-core` → `runPiCore()`, `pi-coding-agent` → `runPiSession()`, `claude-code` → `runClaudeCode()`

---

## Task 1: Extract pi-agent-core into Standalone Function

**Files:**
- Modify: `src/container/agent-runner.ts` — extract `run()` logic into `runPiCore()`

Refactor the existing `run()` function into `runPiCore(config)`. No behavior change — just gives it a name so the dispatcher can call it. All existing tests continue to pass unchanged.

---

## Task 2: pi-coding-agent via Custom pi-ai Provider

**Files:**
- Create: `src/container/agents/pi-session.ts`
- Test: `tests/container/agents/pi-session.test.ts`

**Architecture:**

```
createAgentSession({ model: { api: 'ax-ipc' } })
  → Agent.prompt()
    → pi-ai's streamSimple(model, context, options)
      → getApiProvider('ax-ipc')  // registry lookup
        → IPC-based provider's streamSimple()
          → IPCClient.call({ action: 'llm_call', ... })
            → host LLM provider (with real API key)
```

**Implementation (`src/container/agents/pi-session.ts`):**

1. **Register IPC provider** — wrap existing `createIPCStreamFn` into a pi-ai `ApiProvider`:
   ```typescript
   import { registerApiProvider, clearApiProviders } from '@mariozechner/pi-ai';

   clearApiProviders(); // remove built-in providers (no network in sandbox)

   const ipcProvider: ApiProvider = {
     api: 'ax-ipc',
     stream: ipcStreamFn,       // reuse createIPCStreamFn logic
     streamSimple: ipcStreamFn,
   };
   registerApiProvider(ipcProvider);
   ```

2. **Create model object** with `api: 'ax-ipc'`

3. **Create session**:
   ```typescript
   import { createAgentSession, codingTools } from '@mariozechner/pi-coding-agent';

   const { session } = await createAgentSession({
     model: ipcModel,
     tools: codingTools,        // read, bash, edit, write from pi-coding-agent
     customTools: ipcToolDefs,  // memory, skills, web, audit as ToolDefinitions
     sessionManager: SessionManager.inMemory(), // or file-based for persistence
   });
   ```

4. **Send message and stream output**:
   ```typescript
   session.subscribe((event) => {
     // stream text_delta to stdout (same pattern as current agent-runner.ts:249-258)
   });
   await session.prompt(userMessage);
   ```

**Key reuse:**
- `createIPCStreamFn()` from `src/container/ipc-transport.ts` — adapt signature to match `ApiProvider.stream`
- `createIPCTools()` from `src/container/ipc-tools.ts` — convert to pi-coding-agent `ToolDefinition[]`
- `createLocalTools()` not needed — pi-coding-agent has its own `codingTools` (read, bash, edit, write)

**What this gains over pi-agent-core:**
- Auto-compaction (built-in, no manual `compactHistory()`)
- Persistent JSONL sessions with tree branching
- Extension system for lifecycle hooks
- Model failover with auth rotation
- Built-in coding tools (grep, find, ls) in addition to read/bash/edit/write

---

## Task 3: Anthropic API Proxy for claude-code

**Files:**
- Create: `src/anthropic-proxy.ts`
- Test: `tests/anthropic-proxy.test.ts`
- Modify: `src/server.ts` — start proxy when agent is `claude-code`

**Architecture:**

```
claude-code (in sandbox)
  → HTTP to proxy socket (Anthropic Messages API: POST /v1/messages)
    → proxy translates to IPC format
      → IPC call to host's IPC server
        → host's LLM provider (with real API key)
          → streams response back in Anthropic SSE format
```

**The proxy** is a lightweight HTTP server on a Unix socket (~100 LOC):

1. **Receives** POST `/v1/messages` in Anthropic Messages API format
2. **Extracts**: model, messages, system, tools, max_tokens, stream
3. **Translates to IPC**: `{ action: 'llm_call', model, messages, tools, maxTokens }`
4. **Sends IPC call** to host via `IPCClient`
5. **Converts response** back to Anthropic Messages API format
6. **Streams back** as SSE (content_block_delta events) or returns full JSON

**Server integration** (`src/server.ts`):
```typescript
if (config.agent === 'claude-code') {
  const proxySocketPath = join(ipcSocketDir, 'anthropic-proxy.sock');
  startAnthropicProxy(proxySocketPath, ipcSocketPath);
  // Pass proxySocketPath to agent via --proxy-socket arg
}
```

**Why IPC translation (not forward proxy):** Preserves AX's security pipeline — LLM calls go through the host's `handleIPC`, which does audit logging and taint budget tracking. A forward proxy would bypass all of this.

---

## Task 4: claude-code Agent Runner

**Files:**
- Create: `src/container/agents/claude-code.ts`
- Create: `src/container/agents/mcp-ipc-bridge.ts` — MCP server exposing IPC tools
- Test: `tests/container/agents/claude-code.test.ts`

**Implementation (`src/container/agents/claude-code.ts`):**

1. **Route fetch through Unix socket** (same pattern as `src/cli/send.ts:112-115`):
   ```typescript
   import { setGlobalDispatcher, Agent } from 'undici';
   setGlobalDispatcher(new Agent({ connect: { socketPath: proxySocketPath } }));
   ```

2. **Set env vars**:
   ```typescript
   process.env.ANTHROPIC_BASE_URL = 'http://localhost';
   process.env.ANTHROPIC_API_KEY = 'ax-proxy';  // proxy doesn't validate keys
   ```

3. **Run claude-agent-sdk**:
   ```typescript
   import { query } from '@anthropic-ai/claude-agent-sdk';

   for await (const message of query({
     prompt: userMessage,
     options: {
       allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
       cwd: workspace,
       systemPrompt: systemPrompt,
       mcpServers: {
         ax: {
           command: tsxBin,
           args: [resolve('src/container/agents/mcp-ipc-bridge.ts'),
                  '--ipc-socket', ipcSocketPath],
         },
       },
     },
   })) {
     // stream text to stdout
   }
   ```

4. **MCP-IPC bridge** (`src/container/agents/mcp-ipc-bridge.ts`):
   - Standalone MCP server (stdin/stdout transport)
   - Exposes IPC tools as MCP tools: `memory_query`, `memory_write`, `web_search`, `web_fetch`, `skill_read`, `audit_query`
   - Each tool call → `IPCClient.call()` → returns result

**What this gains:**
- claude-agent-sdk's full coding capabilities (Read, Write, Edit, Bash, Glob, Grep, WebSearch, Task subagents)
- AX's IPC tools available via MCP (memory, skills, web, audit)
- LLM calls route through host (security preserved)
- No API keys in sandbox

---

## Task 5: Tests

**Files:**
- Modify: `tests/config.test.ts` — agent field validation
- Create: `tests/container/agents/pi-session.test.ts`
- Create: `tests/anthropic-proxy.test.ts`
- Create: `tests/container/agents/claude-code.test.ts`

**Test coverage:**
- Config: accepts all 3 values, defaults to `pi-agent-core`, rejects unknown
- pi-session: custom provider registration, IPC routing, session creation
- Anthropic proxy: Messages API → IPC translation, streaming SSE, error handling
- claude-code: env var setup, MCP bridge tool exposure (structural tests)
- Server: `--agent` flag passed to spawn command based on config

---

## Task 6: Journal + Lessons

Update `.claude/journal.md` and `.claude/lessons.md`.

---

## File Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/config.ts` | Modify | Add `agent` field to schema |
| `src/providers/types.ts` | Modify | Add `agent` to Config type |
| `src/container/agent-runner.ts` | Modify | Add `--agent` dispatch |
| `src/server.ts` | Modify | Pass agent type + start proxy if claude-code |
| `src/container/agents/pi-session.ts` | Create | pi-coding-agent with IPC provider |
| `src/container/agents/claude-code.ts` | Create | claude-agent-sdk runner |
| `src/container/agents/mcp-ipc-bridge.ts` | Create | MCP server exposing IPC tools |
| `src/anthropic-proxy.ts` | Create | Anthropic Messages API → IPC proxy |

**Existing code reused:**
- `createIPCStreamFn()` from `src/container/ipc-transport.ts`
- `createIPCTools()` from `src/container/ipc-tools.ts`
- `createSocketFetch()` pattern from `src/cli/send.ts`
- `IPCClient` from `src/container/ipc-client.ts`

---

## Verification

1. `npm test` — all existing tests pass
2. Config test: `agent: pi-agent-core` (default), `agent: pi-coding-agent`, `agent: claude-code` all validate
3. Smoke test each agent type:
   ```bash
   # pi-agent-core (default)
   npm start && npm run send "what is 2+2"

   # pi-coding-agent
   # (edit ax.yaml: agent: pi-coding-agent)
   npm start && npm run send "what is 2+2"

   # claude-code
   # (edit ax.yaml: agent: claude-code)
   npm start && npm run send "what is 2+2"
   ```
4. Verify LLM calls route through host (check server logs for `llm_call` events)
