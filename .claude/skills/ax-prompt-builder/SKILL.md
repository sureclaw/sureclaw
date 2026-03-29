---
name: ax-prompt-builder
description: Use when modifying or extending the agent prompt system — adding modules, adjusting priority ordering, token budgeting, or bootstrap mode in src/agent/prompt/
---

## Overview

The prompt builder assembles the agent's system prompt from a pipeline of ordered, composable modules. Each module contributes a section (identity, security, skills, delegation, etc.) and can be conditionally included or dropped based on context and token budget. The builder handles bootstrap mode (first-run identity discovery), graceful degradation when context is tight, and produces a `ToolFilterContext` for context-aware tool filtering.

## Key Files

| File | Responsibility | Key Exports |
|---|---|---|
| `src/agent/prompt/builder.ts` | Orchestrates modules, builds final prompt | `PromptBuilder`, `PromptResult` |
| `src/agent/prompt/types.ts` | Core interfaces, PromptContext, IdentityFiles | `PromptContext`, `PromptModule`, `IdentityFiles`, `isBootstrapMode()` |
| `src/agent/prompt/base-module.ts` | Abstract base with token estimation | `BasePromptModule` |
| `src/agent/prompt/budget.ts` | Token allocation and module dropping | `allocateModules()` |
| `src/agent/prompt/modules/identity.ts` | SOUL, IDENTITY, USER, bootstrap | `IdentityModule` (priority 0) |
| `src/agent/prompt/modules/injection-defense.ts` | Injection attack recognition, taint display | `InjectionDefenseModule` (priority 5) |
| `src/agent/prompt/modules/security.ts` | Security boundaries and constraints | `SecurityModule` (priority 10) |
| `src/agent/prompt/modules/tool-style.ts` | Tool invocation instructions | `ToolStyleModule` (priority 12) |
| `src/agent/prompt/modules/memory-recall.ts` | Memory recall pattern instructions | `MemoryRecallModule` (priority 60) |
| `src/agent/prompt/modules/skills.ts` | Skill markdown files | `SkillsModule` (priority 70) |
| `src/agent/prompt/modules/commands.ts` | Plugin commands | `CommandsModule` (priority 72) |
| `src/agent/prompt/modules/delegation.ts` | Agent delegation instructions + runner selection | `DelegationModule` (priority 75) |
| `src/agent/prompt/modules/heartbeat.ts` | Heartbeat checklist and scheduler tools | `HeartbeatModule` (priority 80) |
| `src/agent/prompt/modules/runtime.ts` | Agent type, sandbox, profile | `RuntimeModule` (priority 90) |
| `src/agent/prompt/modules/reply-gate.ts` | Reply optionality logic | `ReplyGateModule` (priority 95) |

## PromptContext

Every module receives a `PromptContext` with:

```typescript
interface PromptContext {
  agentType: string;          // 'pi-coding-agent' | 'claude-code'
  workspace: string;          // Absolute path (sanitized by RuntimeModule)
  sandboxType: string;        // 'docker' | 'apple' | 'k8s' | 'subprocess' etc.
  profile: string;            // 'paranoid' | 'balanced' | 'yolo'
  taintRatio: number;         // 0.0-1.0
  taintThreshold: number;     // Profile-dependent threshold
  identityFiles: IdentityFiles;
  contextContent: string;     // CONTEXT.md content
  skills: string[];           // Loaded skill markdown strings
  commands?: PluginCommand[]; // Plugin commands from installed Cowork plugins
  maxTokens: number;          // Context window size
  historyTokens: number;      // Tokens consumed by conversation history
}
```

## Module Priority Order

| Priority | Module | Required? | Optional? | Bootstrap? |
|---|---|---|---|---|
| 0 | identity | Yes | No | Yes (shows BOOTSTRAP.md only) |
| 5 | injection-defense | No | No | Skipped |
| 10 | security | No | No | Skipped |
| 12 | tool-style | No | No | Skipped |
| 60 | memory-recall | No | No | Included |
| 70 | skills | Yes (if skills exist) | Yes | Included |
| 72 | commands | Yes (if commands exist) | Yes | Included |
| 75 | delegation | Yes (if not bootstrap) | Yes | Skipped |
| 80 | heartbeat | Yes (if content exists) | Yes | Skipped |
| 90 | runtime | No | Yes | Skipped |
| 95 | reply-gate | No | No | Skipped |

## Token Budget System

`allocateModules()` in `budget.ts`:

1. Reserve 4096 tokens for output
2. Available = `maxTokens - historyTokens - 4096`
3. Always include required modules (non-optional)
4. Add optional modules by priority until budget exhausted
5. If a module has `renderMinimal()`, try that before dropping entirely
6. Returns list of modules with their render mode (full or minimal)

`PromptBuilder.build(ctx)` returns `PromptBuildResult` which includes:
- `content`: Joined prompt text
- `metadata`: moduleCount, tokenEstimates, buildTimeMs
- `ToolFilterContext`: flags for context-aware tool filtering (used by runners)

## Delegation Module

The `DelegationModule` (priority 75):
- Documents the `agent_delegate` tool for delegating tasks to sub-agents
- Provides runner selection guidance (pi-coding-agent for coding tasks, claude-code for general tasks)
- **Optional** and excluded during bootstrap mode
- Contributes to `ToolFilterContext` (delegation tools available only when module is included)

## Bootstrap Mode

Detected by `isBootstrapMode(ctx)`: `identityFiles.soul` is empty AND `identityFiles.bootstrap` is non-empty.

In bootstrap mode:
- IdentityModule renders only BOOTSTRAP.md content
- InjectionDefense, Security, ToolStyle, Delegation, Heartbeat, Runtime, ReplyGate modules skip
- MemoryRecall, Skills still render if present

## Common Tasks

**Adding a new prompt module:**
1. Create `src/agent/prompt/modules/<name>.ts` extending `BasePromptModule`
2. Set `name`, `priority` (0-100), and optionally `optional = true`
3. Implement `shouldInclude(ctx)` and `render(ctx)`
4. Optionally implement `renderMinimal(ctx)` for budget-constrained fallback
5. Register in `PromptBuilder` constructor in `builder.ts` (add to modules array)
6. Add test in `tests/agent/prompt/modules/<name>.test.ts`
7. If the module should affect tool availability, update `ToolFilterContext` logic in `buildSystemPrompt()` and `filterTools()` in `tool-catalog.ts`

## Gotchas

- **Token estimation is approximate**: 1 token ~ 4 characters. Don't rely on exact counts.
- **Module ordering matters**: Modules at the top have more influence on LLM behavior.
- **Bootstrap mode disables most modules**: Don't add critical runtime info to modules that skip in bootstrap.
- **`render()` returns `string[]`, not a single string**: Lines joined with `\n` by the builder.
- **Workspace path is sanitized**: RuntimeModule strips host username from paths.
- **`optional` defaults to `false`**: Modules without `optional = true` are never budget-dropped.
- **`renderMinimal()` is a soft fallback**: Budget system tries minimal before dropping.
- **ToolFilterContext couples prompt and tools**: Excluded prompt modules automatically exclude corresponding tools via `filterTools()`. If you add a module that controls tool availability, update both the builder and tool catalog.
