# Plan: Async Parallel Delegation via Orchestrator (with `wait` option)

## Context

When the LLM returns multiple `agent_delegate` tool calls in a single response, they execute sequentially (~17s each = ~51s for 3). The bottleneck is pi-agent-core's `executeToolCalls` loop, which awaits each tool one-at-a-time.

The orchestration infrastructure (`src/host/orchestration/`) is already built — Supervisor, Directory, Orchestrator, messaging — but NOT wired into delegation. The current `handleDelegate` in `server.ts:255` still synchronously awaits `processCompletion()` for each child agent.

**Solution:** Make `agent_delegate` fire-and-forget **by default**. Child agents register with the Orchestrator and run concurrently. The LLM uses existing `agent_orch_status` / `agent_orch_list` to poll for completion and read results from `handle.metadata.result`. A new `wait` boolean parameter preserves the blocking behavior for sequential chains where one agent's output feeds the next. No new tools needed.

## Flow

### Parallel — `wait` omitted or `false` (default)

```
LLM response: 3x agent_delegate tool calls (independent tasks)

Sequential tool execution (pi-agent-core, unchanged):
  1. agent_delegate("Research A") → registers child in Orchestrator, spawns in background
     → returns {handleId: "uuid-1", status: "started"}  (~ms)
  2. agent_delegate("Research B") → same
     → returns {handleId: "uuid-2", status: "started"}  (~ms)
  3. agent_delegate("Research C") → same
     → returns {handleId: "uuid-3", status: "started"}  (~ms)

All 3 children running concurrently via Orchestrator.

Next LLM turn:
  LLM calls agent_orch_list(state: ["completed","failed"])
  → returns snapshots with metadata.result for each finished child

Total: ~17s (max of 3) instead of ~51s (sum of 3)
```

### Sequential — `wait: true` (blocking, for dependent chains)

```
LLM needs output from agent A before it can formulate agent B's task:

  1. agent_delegate({ task: "Research topic X", wait: true })
     → blocks until child finishes
     → returns {response: "findings about X..."}  (~17s)

  2. LLM reads findings, formulates summary task

  3. agent_delegate({ task: "Summarize: <findings>", wait: true })
     → blocks until child finishes
     → returns {response: "summary..."}  (~17s)

Total: ~34s (sum of 2) — same as today, no polling overhead
```

## Steps

### 1. Create Orchestrator in server.ts, pass to IPC handler

**File:** `src/host/server.ts`

- Import `createOrchestrator` from `./orchestration/orchestrator.js`
- Create instance with existing `eventBus` and `providers.audit`:
  ```typescript
  const orchestrator = createOrchestrator(eventBus, providers.audit);
  ```
- Pass `orchestrator` to `createIPCHandler` options (line ~288):
  ```typescript
  const handleIPC = createIPCHandler(providers, {
    ...existing opts,
    orchestrator,
  });
  ```
- Call `orchestrator.shutdown()` in `stopServer()` (before closing IPC server)

This also activates the already-coded orchestration IPC handlers (`agent_orch_list`, `agent_orch_status`, etc.) which are currently dead code because no orchestrator is passed.

### 2. Add `wait` field to IPC schema and DelegateRequest

**File:** `src/ipc-schemas.ts`

Add `wait` to `AgentDelegateSchema`:
```typescript
export const AgentDelegateSchema = ipcAction('agent_delegate', {
  task: safeString(50_000),
  context: safeString(100_000).optional(),
  runner: z.enum(['pi-coding-agent', 'claude-code']).optional(),
  model: safeString(128).optional(),
  maxTokens: z.number().int().min(1).max(200_000).optional(),
  timeoutSec: z.number().int().min(5).max(600).optional(),
  wait: z.boolean().optional(),   // default false; true = block and return response
});
```

**File:** `src/host/ipc-server.ts`

Add `wait` to `DelegateRequest`:
```typescript
export interface DelegateRequest {
  task: string;
  context?: string;
  runner?: AgentType;
  model?: string;
  maxTokens?: number;
  timeoutSec?: number;
  wait?: boolean;
}
```

### 3. Make agent_delegate fire-and-forget OR blocking, based on `wait`

**File:** `src/host/ipc-handlers/delegation.ts`

Current behavior (always blocking):
```
activeDelegations++
await onDelegate()
activeDelegations--
return { response }
```

New behavior — branch on `req.wait`:

```typescript
activeDelegations++;

// Always register with Orchestrator for observability
const handle = orchestrator.register({
  agentId: `delegate-${ctx.agentId}`,
  agentType: (req.runner ?? 'pi-coding-agent') as AgentType,
  parentId: null,
  sessionId: ctx.sessionId,
  userId: ctx.userId ?? 'unknown',
  activity: req.task.slice(0, 200),
});
orchestrator.supervisor.transition(handle.id, 'running', 'Processing delegation');

if (req.wait) {
  // ── Blocking mode (wait: true) ─────────────────────────
  // Preserves current behavior: await result, return it directly.
  try {
    const response = await opts.onDelegate(delegateReq, childCtx);
    handle.metadata.result = response;
    orchestrator.supervisor.complete(handle.id, response.slice(0, 500));
    return { response };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    handle.metadata.error = msg;
    orchestrator.supervisor.fail(handle.id, msg);
    return { ok: false, error: `Delegation failed: ${msg}` };
  } finally {
    activeDelegations--;
  }
} else {
  // ── Fire-and-forget mode (default) ─────────────────────
  const promise = opts.onDelegate(delegateReq, childCtx);
  promise.then(result => {
    handle.metadata.result = result;
    orchestrator.supervisor.complete(handle.id, result.slice(0, 500));
  }).catch(err => {
    handle.metadata.error = err instanceof Error ? err.message : String(err);
    orchestrator.supervisor.fail(handle.id, handle.metadata.error);
  }).finally(() => {
    activeDelegations--;
  });

  // Return immediately
  return { handleId: handle.id, status: 'started' };
}
```

Key details:
- **Both paths** register with Orchestrator → every delegation is observable
- **`wait: true`**: `activeDelegations` decrements in `finally` after await (same as current code)
- **`wait: false`/omitted**: `activeDelegations` decrements in `.finally()` when background promise settles
- Result/error always stored in `handle.metadata` regardless of mode
- Supervisor state transitions: `spawning → running → completed/failed`

### 4. Update agent_delegate tool description and add `wait` parameter

**File:** `src/agent/tool-catalog.ts`

Update description to document both modes:
```typescript
description:
  'Delegate a task to a sub-agent running in its own sandbox. ' +
  'By default returns immediately with a handleId — use agent_orch_status or ' +
  'agent_orch_list to poll for completion and read results from metadata.result. ' +
  'Pass wait: true to block until the sub-agent finishes and return the response directly. ' +
  'Use wait: true when the next step depends on this agent\'s output. ' +
  'Subject to depth and concurrency limits.',
```

Add `wait` to parameters:
```typescript
parameters: Type.Object({
  task: Type.String({ description: 'The task description for the sub-agent' }),
  context: Type.Optional(Type.String({ ... })),
  runner: Type.Optional(Type.String({ ... })),
  model: Type.Optional(Type.String({ ... })),
  maxTokens: Type.Optional(Type.Number({ ... })),
  timeoutSec: Type.Optional(Type.Number({ ... })),
  wait: Type.Optional(Type.Boolean({
    description: 'If true, block until sub-agent completes and return response directly. Default: false (fire-and-forget).',
  })),
}),
```

### 5. Update delegation prompt module with both patterns

**File:** `src/agent/prompt/modules/delegation.ts`

Teach the LLM **both** the parallel and sequential patterns:

**Parallel (default, `wait` omitted):**
- `agent_delegate` returns immediately with `{handleId, status: "started"}`
- Delegate ALL independent tasks first, then poll for results
- Use `agent_orch_list` with `state: ["completed","failed"]` to see which children finished
- Use `agent_orch_status(handleId)` to read individual results from `metadata.result`
- If not all done yet, poll again on next turn
- Pattern: fan-out → poll → collect

**Sequential (`wait: true`):**
- `agent_delegate` with `wait: true` blocks and returns `{response: "..."}` directly
- Use when the **next delegation depends on this one's output**
- No polling needed — result comes back in the same tool response
- Pattern: delegate → read result → delegate next

**Decision rule to include in prompt:**
> If the tasks are independent of each other, omit `wait` to run them concurrently.
> If you need this agent's output before you can formulate the next task, pass `wait: true`.

### 6. Wire Orchestrator into TestHarness

**File:** `tests/e2e/harness.ts`

- Import `createEventBus` and `createOrchestrator`
- Create both in `TestHarness` constructor
- Pass `orchestrator` to `createIPCHandler`
- Expose `orchestrator` as a public field for test assertions
- Call `orchestrator.shutdown()` in `dispose()`

### 7. Update existing delegation tests + add parallel and sequential tests

**File:** `tests/e2e/scenarios/agent-delegation.test.ts`

**Existing test updates** — default `agent_delegate` (no `wait`) now returns `{handleId, status: "started"}` instead of `{response}`:
- Tests that check `result.response` → either add `wait: true` to preserve behavior, or assert `result.handleId` exists + `result.status === "started"` and poll via `agent_orch_status`
- Multi-turn test: after `agent_delegate` tool call, the tool result shape depends on `wait`

**New parallel test cases (fire-and-forget, `wait` omitted):**
1. **Fire-and-forget**: `agent_delegate` returns `{handleId, status: "started"}` immediately
2. **Result in Orchestrator**: after background settles, `agent_orch_status(handleId)` has `metadata.result`
3. **Parallel timing**: 3 delegates with artificial delay, total time ≈ max (not sum)
4. **Partial failure**: 1 of 3 throws, handle shows `state: "failed"` with `metadata.error`
5. **Concurrency limit**: 4th delegate rejected when `maxConcurrent=3`
6. **agent_orch_list finds children**: list with session filter returns all spawned handles

**New sequential test cases (`wait: true`):**
7. **wait: true returns response directly**: same shape as current behavior `{response: "..."}`
8. **wait: true error returns structured error**: `{ok: false, error: "Delegation failed: ..."}`
9. **Sequential chain**: delegate A with `wait: true`, read result, use it as context for delegate B with `wait: true` — verify B received A's output
10. **Mixed mode**: 2 parallel (no `wait`) + 1 sequential (`wait: true`) in same session — parallel ones run concurrently, sequential one blocks

## Files Modified

| File | Change |
|------|--------|
| `src/host/server.ts` | Create Orchestrator, pass to IPC handler, shutdown |
| `src/ipc-schemas.ts` | Add `wait: z.boolean().optional()` to `AgentDelegateSchema` |
| `src/host/ipc-server.ts` | Add `wait?: boolean` to `DelegateRequest` |
| `src/host/ipc-handlers/delegation.ts` | Branch on `req.wait`: blocking or fire-and-forget |
| `src/agent/tool-catalog.ts` | Update description + add `wait` parameter |
| `src/agent/prompt/modules/delegation.ts` | Teach both parallel and sequential patterns |
| `tests/e2e/harness.ts` | Wire Orchestrator into TestHarness |
| `tests/e2e/scenarios/agent-delegation.test.ts` | Update existing + add parallel & sequential tests |

## What's NOT Changing

- **No new tool** — existing `agent_orch_status` / `agent_orch_list` do the job for async polling
- **No changes to `IPCHandlerOptions`** — already has `orchestrator?: Orchestrator`
- **No changes to orchestration handlers** — `agent_orch_status` already returns `metadata` in snapshot
- **No changes to `scripted-llm.ts`** — no multi-tool-use helper needed

## Verification

1. `npm run build` — TypeScript compiles clean
2. `npm test` — all existing tests pass (with delegation test updates)
3. New parallel-delegate tests pass
4. New `wait: true` sequential tests pass
5. Manual: run a prompt triggering 3 independent `agent_delegate` calls → confirm all 3 spawn at ~same timestamp, `agent_orch_list` returns all results
6. Manual: run a prompt with dependent tasks → confirm LLM uses `wait: true` and chains results correctly
