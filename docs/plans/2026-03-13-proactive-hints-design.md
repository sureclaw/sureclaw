# Proactive Hints via Event Bus

**Date:** 2026-03-13
**Status:** Approved

## Summary

Add proactive hint support to the cortex memory provider, using the existing event bus to decouple memory from the scheduler. The cortex `memorize()` LLM call detects actionable items (pending tasks, follow-ups) and emits them as `StreamEvent`s. The plainjob scheduler subscribes to hint events and applies gating (confidence threshold, cooldown, active hours) before firing them as `InboundMessage`s to the agent. The unused `scheduler/full` provider is deleted.

## Motivation

The `scheduler/full` provider had proactive hint support but used an in-memory job store (no persistence) and was wired via a direct `onProactiveHint` callback on the memory provider. Nobody configures it — every deployment uses `scheduler: plainjob`. Meanwhile, cortex's `memorize()` already runs an LLM extraction pass but doesn't detect actionable signals. This design unifies both by:

1. Making the LLM extractor classify actionability in the same call
2. Using the existing event bus (works in-process and over NATS) instead of a direct callback
3. Porting the useful gating logic into the production scheduler

## Event Flow

```
cortex.memorize()
  -> extractByLLM() returns items with optional actionable + hintKind fields
  -> for each actionable item:
       eventbus.emit({
         type: 'memory.proactive_hint',
         requestId: agentId,       // scopes to agent in multi-agent deployments
         timestamp: Date.now(),
         data: { source, kind, reason, suggestedPrompt, confidence, scope }
       })

plainjob scheduler.start()
  -> eventbus.subscribe(listener)
  -> listener filters type === 'memory.proactive_hint'
  -> applies gating: confidence >= threshold, within active hours, not in cooldown
  -> onMessageHandler({ sender: 'hint:<kind>', content: suggestedPrompt, ... })
```

The admin SSE stream sees all hint events for free (emission and suppression are visible).

## Design Details

### 1. Extractor Changes (`src/providers/memory/cortex/extractor.ts`)

Add two optional fields to the extraction prompt output schema:

```
- actionable: (optional) true if this item implies something the user needs to do,
  be reminded about, or follow up on
- hintKind: (optional, if actionable) one of pending_task, follow_up, temporal_pattern
```

Updated JSON output example:
```json
[
  {"content": "Prefers dark mode", "memoryType": "profile", "category": "preferences"},
  {"content": "Need to update API keys by Friday", "memoryType": "event", "category": "work_life",
   "actionable": true, "hintKind": "pending_task"}
]
```

Same LLM call, same token budget. The LLM is already reading the full conversation and classifying items — it's in the best position to judge actionability.

Parse the new fields in the extractor return type. Items without `actionable: true` are unchanged.

### 2. Cortex Provider Changes (`src/providers/memory/cortex/provider.ts`)

Accept `eventbus` in `CreateOptions`. After `memorize()` inserts items, emit a `StreamEvent` for each actionable candidate:

```typescript
if (eventbus) {
  for (const candidate of candidates) {
    if (candidate.actionable) {
      eventbus.emit({
        type: 'memory.proactive_hint',
        requestId: agentId ?? 'main',
        timestamp: Date.now(),
        data: {
          source: 'memory',
          kind: candidate.hintKind ?? 'pending_task',
          reason: candidate.content,
          suggestedPrompt: candidate.content,
          confidence: candidate.confidence,
          scope,
        },
      });
    }
  }
}
```

### 3. Plainjob Scheduler Changes (`src/providers/scheduler/plainjob.ts`)

Accept `eventbus` in `PlainJobSchedulerDeps`. In `start()`, subscribe to the event bus and filter for `memory.proactive_hint` events.

Gating logic (ported from `scheduler/full`, simplified):

- **Confidence threshold** — `config.scheduler.proactive_hint_confidence_threshold` (default 0.7)
- **Active hours** — reuse existing `isWithinActiveHours()` check
- **Cooldown** — sha256 signature of `kind:scope:suggestedPrompt`, tracked in `Map<string, number>`. Default 30 minutes via `config.scheduler.proactive_hint_cooldown_sec` (default 1800)

On `stop()`, call the unsubscribe function returned by `eventbus.subscribe()`.

Dropped from `full.ts` (not needed yet):
- Token budget tracking (`recordTokenUsage` / `listPendingHints`) — nothing reports usage back
- Audit logging — event bus provides visibility via admin SSE

### 4. Registry Wiring (`src/host/registry.ts`)

Pass eventbus to both providers:

```typescript
const memory = await memoryMod.create(config, name, { llm: tracedLlm, database, eventbus });
const scheduler = await mod.create(config, { database, eventbus });
```

Load order already has eventbus created before memory and scheduler.

### 5. Cleanup

| Action | File |
|--------|------|
| Delete | `src/providers/scheduler/full.ts` |
| Delete | `tests/providers/scheduler/full.test.ts` |
| Remove `full` entry | `src/host/provider-map.ts` |
| Remove `onProactiveHint` | `src/providers/memory/types.ts` (MemoryProvider interface) |
| Remove re-export | `src/providers/shared-types.ts` (MemoryProvider re-export stays, just callback removed) |
| Remove `recordTokenUsage`, `listPendingHints` | `src/providers/scheduler/types.ts` (SchedulerProvider interface) |

The `ProactiveHint` type itself remains — it's used as the event payload.

## Files Changed

| File | Change |
|------|--------|
| `src/providers/memory/cortex/extractor.ts` | Add `actionable` + `hintKind` to prompt and parsing |
| `src/providers/memory/cortex/provider.ts` | Accept eventbus dep, emit hints after memorize |
| `src/providers/scheduler/plainjob.ts` | Accept eventbus dep, subscribe + gating logic |
| `src/host/registry.ts` | Pass eventbus to memory and scheduler |
| `src/providers/memory/types.ts` | Remove `onProactiveHint` from interface |
| `src/providers/scheduler/types.ts` | Remove `recordTokenUsage`, `listPendingHints` |
| `src/host/provider-map.ts` | Remove `full` entry |
| `src/providers/scheduler/full.ts` | Delete |
| `tests/providers/scheduler/full.test.ts` | Delete |

## Testing

- Unit test: extractor returns `actionable` and `hintKind` fields when present
- Unit test: cortex `memorize()` emits `memory.proactive_hint` events for actionable items
- Unit test: plainjob subscribes, applies gating, fires `InboundMessage` for passing hints
- Unit test: cooldown prevents duplicate hint firing
- Unit test: confidence below threshold suppresses hint
- Unit test: hints outside active hours are suppressed
