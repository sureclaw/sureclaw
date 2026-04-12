# Plan: Three Hermes-Inspired Features for AX
 
## Context
 
Comparative architecture analysis of Hermes, OpenClaw, and AX identified three high-value features from Hermes that align well with AX's security-first design: an autonomous learning loop, bounded always-in-context memory files, and cost/latency-aware model routing. This plan describes the high-level implementation approach for each.
 
Recommended implementation order: Feature 2 (smallest) -> Feature 3 (medium) -> Feature 1 (largest, benefits from the other two).
 
---
 
## Feature 1: Autonomous Learning Loop (Skills from Experience)
 
**Goal:** After completing tasks, evaluate whether reusable patterns emerged and propose them as SKILL.md files through the governance system.
 
### Key Files
 
| File | Change |
|------|--------|
| `src/host/server-completions.ts` | Post-completion hook after existing memorize call (~line 1554) to trigger evaluation |
| `src/host/ipc-handlers/governance.ts` | Extend `Proposal.type` union to include `'skill'`; add approval branch that calls `upsertSkill()` |
| `src/host/ipc-handlers/skills.ts` | Handle approved skill proposals via existing `upsertSkill` |
| `src/types.ts` | Add optional `learning` config section |
 
| New File | Purpose |
|----------|---------|
| `src/host/skill-extraction/evaluator.ts` | LLM call to evaluate conversation history and extract candidate SKILL.md |
| `src/host/skill-extraction/tracker.ts` | Counts completions per agent, triggers evaluation every N tasks (default 15) |
| `src/host/skill-extraction/prompts.ts` | Extraction prompt templates (following `src/providers/memory/cortex/prompts.ts` pattern) |
 
### Data Flow
 
1. `completion.done` EventBus event fires after task completion
2. `tracker.ts` increments per-agent counter; at threshold, calls `evaluator.ts`
3. Evaluator queries last N conversation turns from ConversationStore, makes LLM call (using `fast` task type) asking "is there a reusable pattern here?"
4. If yes, validates via `parseAgentSkill()`, then creates governance proposal with `type: 'skill'`
5. User approves/rejects via existing proposal review flow
6. On approval, `upsertSkill()` writes the SKILL.md; available to agent on next prompt build
 
### Config Addition
 
```typescript
// src/types.ts
learning?: {
  enabled: boolean;              // default: false
  evaluation_interval: number;   // tasks between evaluations, default 15
  auto_approve?: boolean;        // skip governance for yolo profile
};
```
 
### Design Decisions
 
- Evaluation runs **host-side** (trusted), not in the sandboxed agent
- Deduplication check against existing skills via `listSkills()` before proposing
- Cortex high-reinforcement memories are strong skill candidates (query salience scores)
 
### Open Questions
 
- How many conversation turns to include in the evaluation context? Raw turns vs Cortex summaries?
- Quality threshold for LLM-generated skills -- self-validation (parse check) sufficient?
- Multi-agent skill scoping via existing `agentId` on `SkillRecord`
 
---
 
## Feature 2: MEMORY.md + USER.md Bounded Memory Files
 
**Goal:** Two small, always-in-context markdown files curated by the agent -- MEMORY.md (~800 tokens, environment/project facts) and USER.md (~500 tokens, user preferences). Complements retrieval-based Cortex by being always loaded.
 
### Key Observation
 
USER.md already exists as a first-class identity file:
- Loaded in `src/agent/identity-loader.ts:67-69`
- Rendered in `src/agent/prompt/modules/identity.ts:57-59`
- Write-gated via `identity_write` IPC handler with scanner, taint budget, and admin checks
- The enhancement is adding explicit **bounded curation guidance** and token budget enforcement
 
MEMORY.md is new -- an agent-scoped file for durable environmental facts.
 
### Key Files to Modify
 
| File | Change |
|------|--------|
| `src/agent/prompt/types.ts:62` | Add `memory: string` to `IdentityFiles` interface |
| `src/agent/identity-loader.ts` | Load MEMORY.md alongside other identity files (~line 81) |
| `src/agent/prompt/modules/identity.ts` | Render MEMORY.md as `## Environment & Conventions` section; add token budget guidance to `renderEvolutionGuidance()` |
| `src/host/ipc-handlers/identity.ts` | Add content-length enforcement on write path (~3200 chars for MEMORY.md, ~2000 chars for USER.md) |
 
### No New Files Required
 
Entire infrastructure already exists. Changes are additive within existing files.
 
### Data Flow
 
**Read path:** `identity-loader.ts` loads MEMORY.md from workspace or DocumentStore -> passed through stdin payload -> `IdentityModule` renders it in prompt at priority 0
 
**Write path:** Agent calls `identity({ type: "write", file: "MEMORY.md", content: "..." })` -> existing security pipeline (scanner, taint budget, paranoid gate, admin gate) -> DocumentStore write
 
**Token budget enforcement:**
- Soft: prompt guidance in `renderEvolutionGuidance()` telling agent to keep MEMORY.md under ~800 tokens
- Hard: content-length check in `identity_write` handler, reject with error if exceeded
 
### Design Decisions
 
- MEMORY.md is for "facts needed every turn" (project structure, conventions); Cortex is for "everything else"
- Agent reads current content before updating, merges in its own context window, then writes
- Last-writer-wins on concurrent USER.md updates is acceptable (updates are infrequent, content is curated summary)
- Starts empty; prompt guidance nudges agent to populate after first few conversations
 
---
 
## Feature 3: Cost/Latency-Aware Model Routing
 
**Goal:** Extend the LLM router to support three strategies: `explicit` (current), `cost` (cheapest meeting quality threshold), `latency` (fastest meeting quality threshold).
 
### Key Files to Modify
 
| File | Change |
|------|--------|
| `src/types.ts` | Add `routing` config section with strategy, quality thresholds, model overrides |
| `src/config.ts` | Zod schema for routing config |
| `src/providers/llm/router.ts` | Strategy selection in `resolveAndSortCandidates()`; metadata lookup |
 
| New File | Purpose |
|----------|---------|
| `src/providers/llm/model-metadata.ts` | Static registry: cost_per_1k_input/output, avg_latency_ms, quality_tier per model. Subsumes `context-windows.ts` |
 
### Interface Additions
 
```typescript
// src/providers/llm/model-metadata.ts
export type QualityTier = 'tier1' | 'tier2' | 'tier3';
export interface ModelMetadata {
  costPer1kInput: number;
  costPer1kOutput: number;
  avgLatencyMs: number;
  qualityTier: QualityTier;
  contextWindow: number;
}
 
// src/types.ts
export type RoutingStrategy = 'explicit' | 'cost' | 'latency';
routing?: {
  strategy: RoutingStrategy;           // default: 'explicit'
  min_quality_tier?: QualityTier;      // default: 'tier2'
  model_overrides?: Record<string, Partial<ModelMetadata>>;
};
```
 
### Data Flow
 
1. `router.ts create()` loads metadata for all candidates using prefix-matching (same pattern as existing `context-windows.ts:28-32`), merges config `model_overrides`
2. Per-request: `resolveAndSortCandidates(taskType)` gets base candidates, then:
   - `explicit`: use configured order (no change)
   - `cost`: filter by quality tier >= min, sort by total cost ascending
   - `latency`: filter by quality tier >= min, sort by avgLatencyMs ascending
3. Fallback loop (`router.ts:153-196`) runs with sorted list -- existing cooldown logic still applies
 
### Model Metadata Registry
 
Static prefix-matched entries, initial set:
- `claude-opus-4` -> tier1, $0.015/$0.075, ~2000ms
- `claude-sonnet-4` -> tier1, $0.003/$0.015, ~1200ms
- `claude-haiku-3-5` -> tier2, $0.0008/$0.004, ~600ms
- `gpt-4o` -> tier1, $0.0025/$0.01, ~800ms
- `gpt-4o-mini` -> tier2, $0.00015/$0.0006, ~400ms
- etc.
 
Subsumes `context-windows.ts` -- deprecate it, delegate `getContextWindow()` to new registry.
 
### Design Decisions
 
- One global strategy (not per-task-type in v1; v2 could add `routing.task_overrides`)
- Static pricing data updated with releases; users override via `model_overrides` for self-hosted
- Quality tiers: tier1 = frontier (best reasoning), tier2 = strong general-purpose, tier3 = fast/cheap
 
### Future Enhancement
 
Feed observed latencies from `TracedLLMProvider` spans back into metadata as exponential moving average, making the router adaptive to actual performance.
 
---
 
## Verification Plan
 
### Feature 2 (MEMORY.md)
- Unit test: `identity-loader.ts` loads MEMORY.md when present, returns empty string when absent
- Unit test: `identity_write` handler rejects MEMORY.md content exceeding 3200 chars
- Integration test: prompt output includes `## Environment & Conventions` section when MEMORY.md has content
- Manual: start agent, write to MEMORY.md via identity tool, verify it appears in next prompt
 
### Feature 3 (Cost/Latency Routing)
- Unit test: `model-metadata.ts` prefix matching returns correct metadata
- Unit test: router with `strategy: 'cost'` sorts candidates by cost ascending
- Unit test: router with `strategy: 'latency'` sorts candidates by latency ascending
- Unit test: quality tier filtering excludes tier3 models when `min_quality_tier: 'tier2'`
- Unit test: `model_overrides` in config override static registry values
- Integration test: end-to-end chat request with cost strategy selects cheapest qualifying model
 
### Feature 1 (Learning Loop)
- Unit test: tracker increments and triggers at configured interval
- Unit test: evaluator returns null for conversations with no reusable patterns
- Unit test: evaluator returns valid SKILL.md for pattern-rich conversations (mock LLM)
- Unit test: governance proposal created with `type: 'skill'` and valid content
- Unit test: proposal approval calls `upsertSkill()` with correct content
- Integration test: full cycle from completion -> evaluation -> proposal -> approval -> skill available in prompt