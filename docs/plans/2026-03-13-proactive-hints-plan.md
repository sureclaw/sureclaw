# Proactive Hints via Event Bus — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Wire proactive hint detection into cortex's `memorize()` LLM extraction pass, emit hints onto the existing event bus, and have the plainjob scheduler subscribe and gate them before injecting as agent messages. Delete the unused `scheduler/full` provider.

**Architecture:** Cortex extends its LLM extraction prompt to classify actionable items, then emits `StreamEvent`s with `type: 'memory.proactive_hint'`. The plainjob scheduler subscribes to the event bus at `start()`, applies confidence/cooldown/active-hours gating, and fires passing hints as `InboundMessage`s. Both providers receive the event bus via dependency injection in the registry.

**Tech Stack:** TypeScript, vitest, existing EventBusProvider interface, existing LLM extraction pipeline

---

### Task 1: Extend extractor to detect actionable items

**Files:**
- Modify: `src/providers/memory/cortex/extractor.ts:16-91`
- Test: `tests/providers/memory/cortex/extractor.test.ts`

**Step 1: Write the failing tests**

Add to `tests/providers/memory/cortex/extractor.test.ts`:

```typescript
it('extracts actionable flag and hintKind when present', async () => {
  const llmResponse = JSON.stringify([
    { content: 'Prefers dark mode', memoryType: 'profile', category: 'preferences' },
    { content: 'Need to update API keys by Friday', memoryType: 'event', category: 'work_life', actionable: true, hintKind: 'pending_task' },
  ]);
  const llm = mockLLM(llmResponse);
  const turns: ConversationTurn[] = [
    { role: 'user', content: 'I prefer dark mode. I need to update API keys by Friday.' },
  ];
  const items = await extractByLLM(turns, 'default', llm);
  expect(items).toHaveLength(2);
  expect(items[0].actionable).toBeUndefined();
  expect(items[0].hintKind).toBeUndefined();
  expect(items[1].actionable).toBe(true);
  expect(items[1].hintKind).toBe('pending_task');
});

it('ignores invalid hintKind values', async () => {
  const llmResponse = JSON.stringify([
    { content: 'Do the thing', memoryType: 'event', category: 'activities', actionable: true, hintKind: 'bogus_kind' },
  ]);
  const llm = mockLLM(llmResponse);
  const turns: ConversationTurn[] = [{ role: 'user', content: 'I need to do the thing' }];
  const items = await extractByLLM(turns, 'default', llm);
  expect(items[0].actionable).toBe(true);
  expect(items[0].hintKind).toBeUndefined();
});

it('treats actionable: false as not actionable', async () => {
  const llmResponse = JSON.stringify([
    { content: 'Something', memoryType: 'knowledge', category: 'knowledge', actionable: false },
  ]);
  const llm = mockLLM(llmResponse);
  const turns: ConversationTurn[] = [{ role: 'user', content: 'test' }];
  const items = await extractByLLM(turns, 'default', llm);
  expect(items[0].actionable).toBeUndefined();
});
```

**Step 2: Run tests to verify they fail**

Run: `npm test -- --run tests/providers/memory/cortex/extractor.test.ts`
Expected: FAIL — `actionable` and `hintKind` properties don't exist on the return type

**Step 3: Update the extraction prompt and parsing**

In `src/providers/memory/cortex/extractor.ts`:

Update `EXTRACTION_PROMPT` (line 16) — append to the existing bullet list before the "Only extract" line:

```typescript
const EXTRACTION_PROMPT = `Extract discrete facts, preferences, and action items from this conversation that should be remembered about the user. For each item:
- content: A short canonical statement using the SIMPLEST possible wording. Use "Subject verb object" form. Strip filler words, qualifiers, and synonyms. The SAME fact must ALWAYS produce the SAME wording regardless of how the user phrased it.
  Examples of canonical form:
  - "Prefers dark mode" (not "Likes to use dark mode in editors" or "Prefers using dark mode in all code editors")
  - "Uses TypeScript for all projects" (not "The user uses TypeScript for all of their projects")
  - "Runs tests before committing" (not "Always runs the test suite before making a commit")
- memoryType: one of profile, event, knowledge, behavior, skill, tool
- category: one of personal_info, preferences, relationships, activities, goals, experiences, knowledge, opinions, habits, work_life
- actionable: (optional) true ONLY if this item implies something the user needs to do, be reminded about, or follow up on
- hintKind: (required if actionable is true) one of pending_task, follow_up, temporal_pattern

Only extract information the user explicitly states or clearly implies. Do not infer or speculate.

Respond with ONLY a JSON array: [{"content": "...", "memoryType": "...", "category": "...", "actionable": true, "hintKind": "..."}]
If nothing worth remembering, respond with: []`;
```

Add a valid hint kinds set:

```typescript
const VALID_HINT_KINDS = new Set(['pending_task', 'follow_up', 'temporal_pattern']);
```

Update the return type of `extractByLLM` — change `Promise<Omit<CortexItem, 'id'>[]>` to `Promise<(Omit<CortexItem, 'id'> & { actionable?: true; hintKind?: string })[]>`.

Update the `.map()` block (line 70) to include the new fields:

```typescript
.map(item => {
  const memoryType = validTypes.has(item.memoryType)
    ? item.memoryType as MemoryType
    : 'knowledge' as MemoryType;
  const category = VALID_CATEGORIES.has(item.category)
    ? item.category
    : defaultCategoryForType(memoryType);

  const actionable = (item as any).actionable === true ? true : undefined;
  const hintKind = actionable && VALID_HINT_KINDS.has((item as any).hintKind)
    ? (item as any).hintKind as string
    : undefined;

  return {
    content: item.content,
    memoryType,
    category,
    contentHash: computeContentHash(item.content),
    confidence: 0.85,
    reinforcementCount: 1,
    lastReinforcedAt: now,
    createdAt: now,
    updatedAt: now,
    scope,
    ...(actionable ? { actionable } : {}),
    ...(hintKind ? { hintKind } : {}),
  };
});
```

**Step 4: Run tests to verify they pass**

Run: `npm test -- --run tests/providers/memory/cortex/extractor.test.ts`
Expected: All PASS

**Step 5: Commit**

```bash
git add src/providers/memory/cortex/extractor.ts tests/providers/memory/cortex/extractor.test.ts
git commit -m "feat: extend LLM extractor with actionable and hintKind fields"
```

---

### Task 2: Emit proactive hint events from cortex memorize()

**Files:**
- Modify: `src/providers/memory/cortex/provider.ts:33-36,143-145,437-482`
- Test: `tests/providers/memory/cortex/provider.test.ts`

**Step 1: Write the failing test**

Add to `tests/providers/memory/cortex/provider.test.ts`. You'll need to check the existing test setup — it likely has a helper to create the provider. Add:

```typescript
import type { EventBusProvider, StreamEvent } from '../../../src/providers/eventbus/types.js';

function mockEventBus(): EventBusProvider & { events: StreamEvent[] } {
  const events: StreamEvent[] = [];
  return {
    events,
    emit(event: StreamEvent) { events.push(event); },
    subscribe: () => () => {},
    subscribeRequest: () => () => {},
    listenerCount: () => 0,
    close() {},
  };
}
```

Then the test:

```typescript
it('memorize emits proactive hint events for actionable items', async () => {
  // Mock LLM to return one actionable item
  const llmResponse = JSON.stringify([
    { content: 'Update API keys by Friday', memoryType: 'event', category: 'work_life', actionable: true, hintKind: 'pending_task' },
  ]);
  const llm = mockLLM(llmResponse);
  const eventbus = mockEventBus();
  const provider = await createTestProvider({ llm, eventbus });

  await provider.memorize!([
    { role: 'user', content: 'I need to update API keys by Friday' },
  ]);

  const hintEvents = eventbus.events.filter(e => e.type === 'memory.proactive_hint');
  expect(hintEvents).toHaveLength(1);
  expect(hintEvents[0].data.kind).toBe('pending_task');
  expect(hintEvents[0].data.suggestedPrompt).toBe('Update API keys by Friday');
  expect(hintEvents[0].data.confidence).toBe(0.85);
  expect(hintEvents[0].data.source).toBe('memory');
});

it('memorize does not emit events for non-actionable items', async () => {
  const llmResponse = JSON.stringify([
    { content: 'Prefers dark mode', memoryType: 'profile', category: 'preferences' },
  ]);
  const llm = mockLLM(llmResponse);
  const eventbus = mockEventBus();
  const provider = await createTestProvider({ llm, eventbus });

  await provider.memorize!([
    { role: 'user', content: 'I prefer dark mode' },
  ]);

  const hintEvents = eventbus.events.filter(e => e.type === 'memory.proactive_hint');
  expect(hintEvents).toHaveLength(0);
});

it('memorize works without eventbus (no crash)', async () => {
  const llmResponse = JSON.stringify([
    { content: 'Has a dog', memoryType: 'profile', category: 'personal_info', actionable: true, hintKind: 'follow_up' },
  ]);
  const llm = mockLLM(llmResponse);
  const provider = await createTestProvider({ llm }); // no eventbus

  // Should not throw
  await provider.memorize!([
    { role: 'user', content: 'I have a dog' },
  ]);
});
```

Note: You'll need to check how the existing `provider.test.ts` creates providers and adapt `createTestProvider` to pass the eventbus through. The provider's `CreateOptions` will need updating.

**Step 2: Run tests to verify they fail**

Run: `npm test -- --run tests/providers/memory/cortex/provider.test.ts`
Expected: FAIL — eventbus not accepted, no events emitted

**Step 3: Update cortex provider to accept eventbus and emit hints**

In `src/providers/memory/cortex/provider.ts`:

Add import:
```typescript
import type { EventBusProvider } from '../../eventbus/types.js';
import type { ProactiveHint } from '../types.js';
```

Update `CreateOptions` (line 33):
```typescript
export interface CreateOptions {
  llm?: LLMProvider;
  database?: DatabaseProvider;
  eventbus?: EventBusProvider;
}
```

Store the eventbus in `create()` (after line 145):
```typescript
const eventbus = opts?.eventbus;
```

In the `memorize()` method, after the dedup/insert loop (after line 462, before step 3 summary update), add hint emission:

```typescript
// Step 2b: Emit proactive hints for actionable items
if (eventbus) {
  for (const candidate of candidates) {
    if ('actionable' in candidate && candidate.actionable) {
      eventbus.emit({
        type: 'memory.proactive_hint',
        requestId: config.agent_name ?? 'main',
        timestamp: Date.now(),
        data: {
          source: 'memory',
          kind: ('hintKind' in candidate ? candidate.hintKind : undefined) ?? 'pending_task',
          reason: candidate.content,
          suggestedPrompt: candidate.content,
          confidence: candidate.confidence,
          scope,
        } satisfies ProactiveHint as Record<string, unknown>,
      });
    }
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `npm test -- --run tests/providers/memory/cortex/provider.test.ts`
Expected: All PASS

**Step 5: Commit**

```bash
git add src/providers/memory/cortex/provider.ts tests/providers/memory/cortex/provider.test.ts
git commit -m "feat: cortex memorize() emits proactive hint events via event bus"
```

---

### Task 3: Add hint gating to plainjob scheduler

**Files:**
- Modify: `src/providers/scheduler/plainjob.ts:1-233`
- Test: `tests/providers/scheduler/plainjob.test.ts`

**Step 1: Write the failing tests**

Add to `tests/providers/scheduler/plainjob.test.ts`:

```typescript
import type { EventBusProvider, StreamEvent } from '../../../src/providers/eventbus/types.js';
import { createHash } from 'node:crypto';

function createMockEventBus(): EventBusProvider & { fire(event: StreamEvent): void } {
  const listeners: Array<(event: StreamEvent) => void> = [];
  return {
    emit() {},
    subscribe(fn) {
      listeners.push(fn);
      return () => {
        const idx = listeners.indexOf(fn);
        if (idx >= 0) listeners.splice(idx, 1);
      };
    },
    subscribeRequest: () => () => {},
    listenerCount: () => listeners.length,
    close() {},
    fire(event: StreamEvent) {
      for (const fn of listeners) fn(event);
    },
  };
}

function hintEvent(overrides: Partial<StreamEvent['data']> = {}): StreamEvent {
  return {
    type: 'memory.proactive_hint',
    requestId: 'main',
    timestamp: Date.now(),
    data: {
      source: 'memory',
      kind: 'pending_task',
      reason: 'Update API keys',
      suggestedPrompt: 'Update API keys by Friday',
      confidence: 0.9,
      scope: 'default',
      ...overrides,
    },
  };
}
```

Then add tests in a new `describe('proactive hints')` block:

```typescript
describe('proactive hints', () => {
  test('fires hint as InboundMessage when confidence exceeds threshold', async () => {
    const eventbus = createMockEventBus();
    const scheduler = await create(mockConfig, { jobStore: new MemoryJobStore(), eventbus });
    const received: InboundMessage[] = [];

    await scheduler.start((msg) => received.push(msg));
    stopFn = () => scheduler.stop();

    eventbus.fire(hintEvent({ confidence: 0.9 }));
    await new Promise(r => setTimeout(r, 10));

    const hints = received.filter(m => m.sender.startsWith('hint:'));
    expect(hints).toHaveLength(1);
    expect(hints[0].sender).toBe('hint:pending_task');
    expect(hints[0].content).toBe('Update API keys by Friday');
  });

  test('suppresses hint below confidence threshold', async () => {
    const eventbus = createMockEventBus();
    const scheduler = await create(mockConfig, { jobStore: new MemoryJobStore(), eventbus });
    const received: InboundMessage[] = [];

    await scheduler.start((msg) => received.push(msg));
    stopFn = () => scheduler.stop();

    eventbus.fire(hintEvent({ confidence: 0.3 }));
    await new Promise(r => setTimeout(r, 10));

    expect(received.filter(m => m.sender.startsWith('hint:'))).toHaveLength(0);
  });

  test('cooldown prevents duplicate hint firing', async () => {
    const eventbus = createMockEventBus();
    const scheduler = await create(mockConfig, { jobStore: new MemoryJobStore(), eventbus });
    const received: InboundMessage[] = [];

    await scheduler.start((msg) => received.push(msg));
    stopFn = () => scheduler.stop();

    eventbus.fire(hintEvent());
    await new Promise(r => setTimeout(r, 10));
    expect(received.filter(m => m.sender.startsWith('hint:'))).toHaveLength(1);

    // Same hint again — should be suppressed by cooldown
    eventbus.fire(hintEvent());
    await new Promise(r => setTimeout(r, 10));
    expect(received.filter(m => m.sender.startsWith('hint:'))).toHaveLength(1);
  });

  test('different hints fire independently (no cross-cooldown)', async () => {
    const eventbus = createMockEventBus();
    const scheduler = await create(mockConfig, { jobStore: new MemoryJobStore(), eventbus });
    const received: InboundMessage[] = [];

    await scheduler.start((msg) => received.push(msg));
    stopFn = () => scheduler.stop();

    eventbus.fire(hintEvent({ suggestedPrompt: 'Task A' }));
    eventbus.fire(hintEvent({ suggestedPrompt: 'Task B' }));
    await new Promise(r => setTimeout(r, 10));

    expect(received.filter(m => m.sender.startsWith('hint:'))).toHaveLength(2);
  });

  test('stop unsubscribes from eventbus', async () => {
    const eventbus = createMockEventBus();
    const scheduler = await create(mockConfig, { jobStore: new MemoryJobStore(), eventbus });
    const received: InboundMessage[] = [];

    await scheduler.start((msg) => received.push(msg));
    await scheduler.stop();

    eventbus.fire(hintEvent());
    await new Promise(r => setTimeout(r, 10));

    expect(received.filter(m => m.sender.startsWith('hint:'))).toHaveLength(0);
  });

  test('works without eventbus (backward compatible)', async () => {
    const scheduler = await create(mockConfig, { jobStore: new MemoryJobStore() });
    await scheduler.start(() => {});
    await scheduler.stop();
    // No crash — test passes if we get here
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npm test -- --run tests/providers/scheduler/plainjob.test.ts`
Expected: FAIL — eventbus not accepted, no hint handling

**Step 3: Add hint gating to plainjob**

In `src/providers/scheduler/plainjob.ts`:

Add imports:
```typescript
import { createHash } from 'node:crypto';
import type { EventBusProvider } from '../eventbus/types.js';
import type { ProactiveHint } from '../memory/types.js';
```

Update deps interface (line 18):
```typescript
interface PlainJobSchedulerDeps {
  jobStore?: JobStore;
  database?: DatabaseProvider;
  eventbus?: EventBusProvider;
}
```

After the `agentName` declaration (after line 65), add hint gating state:

```typescript
// ─── Proactive hint gating ─────────────────────────
const confidenceThreshold = config.scheduler.proactive_hint_confidence_threshold ?? 0.7;
const cooldownSec = config.scheduler.proactive_hint_cooldown_sec ?? 1800;
const cooldownMap = new Map<string, number>();
let unsubscribeHints: (() => void) | null = null;

function hintSignature(hint: ProactiveHint): string {
  return createHash('sha256')
    .update(`${hint.kind}:${hint.scope}:${hint.suggestedPrompt}`)
    .digest('hex')
    .slice(0, 16);
}

function handleProactiveHint(hint: ProactiveHint): void {
  if (!onMessageHandler) return;
  if (hint.confidence < confidenceThreshold) return;
  if (!isWithinActiveHours(activeHours)) return;

  const sig = hintSignature(hint);
  const lastFired = cooldownMap.get(sig);
  if (lastFired !== undefined) {
    const elapsed = (Date.now() - lastFired) / 1000;
    if (elapsed < cooldownSec) return;
  }

  cooldownMap.set(sig, Date.now());

  onMessageHandler({
    id: randomUUID(),
    session: schedulerSession(`hint:${hint.kind}`),
    sender: `hint:${hint.kind}`,
    content: hint.suggestedPrompt,
    attachments: [],
    timestamp: new Date(),
  });
}
```

In `start()` (after the cron timer setup, around line 175), subscribe to eventbus:

```typescript
// Subscribe to proactive hints from event bus
if (deps.eventbus) {
  unsubscribeHints = deps.eventbus.subscribe((event) => {
    if (event.type !== 'memory.proactive_hint') return;
    handleProactiveHint(event.data as ProactiveHint);
  });
}
```

In `stop()` (before the `onMessageHandler = null` line, around line 189), unsubscribe:

```typescript
if (unsubscribeHints) {
  unsubscribeHints();
  unsubscribeHints = null;
}
```

**Step 4: Run tests to verify they pass**

Run: `npm test -- --run tests/providers/scheduler/plainjob.test.ts`
Expected: All PASS

**Step 5: Commit**

```bash
git add src/providers/scheduler/plainjob.ts tests/providers/scheduler/plainjob.test.ts
git commit -m "feat: plainjob scheduler subscribes to proactive hints via event bus"
```

---

### Task 4: Wire eventbus to memory and scheduler in registry

**Files:**
- Modify: `src/host/registry.ts:75-78,131-134`

**Step 1: Update memory provider loading (line 78)**

Change:
```typescript
const memory = await memoryMod.create(config, config.providers.memory, { llm: tracedLlm, database });
```
To:
```typescript
const memory = await memoryMod.create(config, config.providers.memory, { llm: tracedLlm, database, eventbus });
```

**Step 2: Update scheduler loading (line 131-134)**

Change:
```typescript
async function loadScheduler(config: Config, database?: DatabaseProvider) {
  const modulePath = resolveProviderPath('scheduler', config.providers.scheduler);
  const mod = await import(modulePath);
  return mod.create(config, { database });
}
```
To:
```typescript
async function loadScheduler(config: Config, database?: DatabaseProvider, eventbus?: import('../providers/eventbus/types.js').EventBusProvider) {
  const modulePath = resolveProviderPath('scheduler', config.providers.scheduler);
  const mod = await import(modulePath);
  return mod.create(config, { database, eventbus });
}
```

And update the call site (line 103):
```typescript
scheduler:   await loadScheduler(config, database, eventbus),
```

**Step 3: Run the full test suite**

Run: `npm test -- --run`
Expected: All PASS

**Step 4: Commit**

```bash
git add src/host/registry.ts
git commit -m "feat: wire eventbus to cortex and plainjob via registry"
```

---

### Task 5: Clean up — remove scheduler/full and stale interface methods

**Files:**
- Delete: `src/providers/scheduler/full.ts`
- Delete: `tests/providers/scheduler/full.test.ts`
- Modify: `src/host/provider-map.ts:74`
- Modify: `src/providers/scheduler/types.ts:1-3,51-54`
- Modify: `src/providers/memory/types.ts:55`
- Modify: `src/providers/shared-types.ts:21-25`

**Step 1: Delete scheduler/full files**

```bash
rm src/providers/scheduler/full.ts tests/providers/scheduler/full.test.ts
```

**Step 2: Remove `full` from provider map**

In `src/host/provider-map.ts`, remove line 74:
```typescript
    full:     '../providers/scheduler/full.js',
```

**Step 3: Remove `recordTokenUsage` and `listPendingHints` from SchedulerProvider**

In `src/providers/scheduler/types.ts`, remove lines 51-54:
```typescript
  /** Record tokens used so budget tracking can suppress hints. */
  recordTokenUsage?(tokens: number): void;
  /** List hints that were queued (budget exceeded). */
  listPendingHints?(): ProactiveHint[];
```

Also remove the `ProactiveHint` import (line 3):
```typescript
import type { ProactiveHint } from '../shared-types.js';
```

**Step 4: Remove `onProactiveHint` from MemoryProvider**

In `src/providers/memory/types.ts`, remove line 55:
```typescript
  onProactiveHint?(handler: (hint: ProactiveHint) => void): void;
```

**Step 5: Clean up shared-types re-exports**

In `src/providers/shared-types.ts`, update lines 21-25. Remove `MemoryProvider` re-export (nothing outside memory should import it from shared-types now that the scheduler doesn't need it for the callback). Keep `ProactiveHint` since the scheduler still uses the type:

```typescript
// ─── Memory types (used by scheduler for proactive hints) ───
export type {
  ProactiveHint,
} from './memory/types.js';
```

**Step 6: Check for remaining references to full/recordTokenUsage/listPendingHints/onProactiveHint**

Run:
```bash
grep -r "scheduler/full\|recordTokenUsage\|listPendingHints\|onProactiveHint" src/ tests/ --include="*.ts" -l
```

Fix any remaining references (likely just the deleted files).

**Step 7: Run the full test suite**

Run: `npm test -- --run`
Expected: All PASS

**Step 8: Run build**

Run: `npm run build`
Expected: No type errors

**Step 9: Commit**

```bash
git add -u
git commit -m "refactor: remove scheduler/full and stale hint interface methods"
```

---

### Task 6: Final verification

**Step 1: Run full test suite**

Run: `npm test -- --run`
Expected: All PASS

**Step 2: Run build**

Run: `npm run build`
Expected: Clean compilation

**Step 3: Verify no stale references**

Run:
```bash
grep -r "scheduler/full\|onProactiveHint\|recordTokenUsage\|listPendingHints" src/ tests/ --include="*.ts"
```

Expected: No matches (only docs/plans may reference these)
