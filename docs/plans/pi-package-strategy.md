# Pi Package Strategy: Staged Adoption

> **For**: Claude Code — context for understanding which pi packages are used and why.

## Rationale

The pi ecosystem is layered. We adopt it bottom-up across stages to keep early
milestones minimal while gaining access to production-hardened features later
without rewriting container code.

## Stage 0–1: `pi-agent-core` + `pi-ai`

**Dependencies**: `@mariozechner/pi-agent-core`, `@mariozechner/pi-ai`, `@sinclair/typebox`

The container instantiates pi-agent-core's `Agent` class directly:

```typescript
import { Agent } from '@mariozechner/pi-agent-core';

const agent = new Agent({
  initialState: { systemPrompt, model, tools },
  streamFn: (model, messages, options) => ipc.stream('llm_call', { ... }),
});
```

**What this gives us**:

- Agent loop (prompt → LLM call → tool execution → result → repeat until done)
- Tool argument validation via TypeBox schemas + AJV (errors returned to LLM for self-correction)
- Event streaming via `agent.subscribe()` (message_start, tool_execution_start, etc.)
- Message queuing: `agent.steer()` (interrupt after current tool) and `agent.followUp()` (wait until idle)
- `streamFn` override to route all LLM calls through IPC credential proxy
- State management (`agent.state.messages`, `agent.state.tools`)

**What we handle ourselves**:

- Session persistence: just an in-memory message array in the container. Host can optionally snapshot it.
- Compaction: not needed yet at Stage 0 (short sessions, CLI channel only)
- Model failover: single provider at Stage 0, no failover needed
- Extensions: none needed yet — taint markers injected via `transformContext` callback on the Agent

**Why not pi-coding-agent yet**: It pulls in `SessionManager` (JSONL tree format),
the extension runner, `DefaultResourceLoader`, `SettingsManager`, `AuthStorage`,
`ModelRegistry`, compaction logic, and has a transitive dependency on `pi-tui`. None
of this is needed for a walking skeleton. The Agent class from pi-agent-core is ~50KB
and does exactly what we need.

## Stage 2+: Add `pi-coding-agent`

**New dependency**: `@mariozechner/pi-coding-agent`

The container swaps `new Agent(...)` for `createAgentSession(...)`:

```typescript
import { createAgentSession, SessionManager, SettingsManager } from '@mariozechner/pi-coding-agent';

const { session } = await createAgentSession({
  sessionManager: SessionManager.open('/session/session.jsonl'),
  settingsManager: SettingsManager.inMemory({ compaction: { enabled: true } }),
  authStorage,
  modelRegistry,
  model: resolvedModel,
  tools: [],
  customTools: axTools,
  // streamFn still routes through IPC — same as Stage 0
});
```

`AgentSession` wraps pi-agent-core's `Agent` and adds:

| Feature | What it does | Why we need it at Stage 2 |
|---------|--------------|---------------------------|
| `SessionManager.open()` | JSONL tree-structured persistence with branching | Assistant runs 24/7 with heartbeats — needs durable sessions that survive container restarts |
| Compaction extensions | Auto-summarize old messages when context fills up | Long-running assistant sessions will hit context limits within hours |
| `ModelRegistry` + auth rotation | Multi-provider model resolution with failover and API key rotation | Stage 2 introduces `llm-multi` — need graceful failover between Anthropic/OpenAI/Ollama |
| Extension system | Lifecycle hooks: `before_stream`, `tool_call`, `tool_result`, etc. | Cleaner integration point for taint marker injection, memory context loading, scanner hooks |
| `SettingsManager` | Typed config with file + override merging | Per-agent settings (compaction thresholds, retry policy, thinking level) |

**What does NOT change**:

- Container image: same sandbox container
- Container entrypoint: same `agent-runner.ts` — just the agent instantiation line changes
- IPC transport: same `ipc-transport.ts`, same `streamFn` proxy pattern
- Tool definitions: same `local-tools.ts` + `ipc-tools.ts`
- Host IPC proxy: unchanged
- Trust boundaries: unchanged

The upgrade from pi-agent-core to pi-coding-agent is a swap of ~10 lines in `agent-runner.ts`.
Everything else — tools, IPC, container config, capability enforcement — stays identical.

## Summary

|  | Stage 0–1 | Stage 2+ |
|--|-----------|----------|
| Agent class | `Agent` from pi-agent-core | `AgentSession` via `createAgentSession` from pi-coding-agent |
| Sessions | In-memory | Persistent JSONL with tree branching |
| Compaction | None | Auto-compaction with safeguard extension |
| Model failover | Single provider | Multi-provider with auth rotation |
| Extensions | None (use `transformContext` callback) | Full extension system for lifecycle hooks |
| Container code change | — | ~10 lines in agent-runner.ts |
| Dependencies | pi-agent-core, pi-ai, typebox | + pi-coding-agent |
