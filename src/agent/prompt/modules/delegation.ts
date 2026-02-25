// src/agent/prompt/modules/delegation.ts
import { BasePromptModule } from '../base-module.js';
import { isBootstrapMode } from '../types.js';
import type { PromptContext } from '../types.js';

/**
 * Delegation module: tells the agent how and when to delegate tasks to
 * sub-agents using `agent_delegate`. Priority 75 — after skills, before
 * heartbeat. Optional — excluded during bootstrap.
 */
export class DelegationModule extends BasePromptModule {
  readonly name = 'delegation';
  readonly priority = 75;
  readonly optional = true;

  shouldInclude(ctx: PromptContext): boolean {
    if (isBootstrapMode(ctx)) return false;
    return true;
  }

  render(ctx: PromptContext): string[] {
    return [
      '## Task Delegation',
      '',
      'You can delegate work to a **sub-agent** using `agent_delegate`. The sub-agent',
      'runs in its own isolated sandbox and returns a text response when finished.',
      '',
      '### When to delegate',
      '- The task involves a distinct, self-contained subtask (research, analysis, code review)',
      '- You need work done in parallel while you continue with something else',
      '- A different runner type would be better suited (see below)',
      '',
      '### Choosing a runner',
      'Use the `runner` parameter to pick the right agent type for the job:',
      '',
      '| Runner | Best for |',
      '|--------|----------|',
      '| `claude-code` | **Coding tasks**: writing code, debugging, refactoring, code review, test writing. Has full IDE tooling. |',
      '| `pi-coding-agent` | Coding tasks within AX\'s sandboxed environment with IPC tools. |',
      '| `pi-agent-core` | General-purpose tasks: research, summarization, analysis, planning. Default if omitted. |',
      '',
      'If the delegated task involves writing or modifying code, prefer `claude-code`.',
      '',
      '### Parameters',
      '- `task` (required) — what the sub-agent should do. Be specific.',
      '- `context` — background information the sub-agent needs.',
      '- `runner` — agent type (`pi-agent-core`, `pi-coding-agent`, `claude-code`).',
      '- `model` — model ID override (e.g. `claude-sonnet-4-5-20250929`).',
      '- `maxTokens` — limit the sub-agent\'s response length.',
      '- `timeoutSec` — deadline in seconds (5–600).',
      '',
      '### Limits',
      'The host enforces depth and concurrency limits. If you hit one, the call',
      'returns an error — handle it gracefully and do the work yourself instead.',
    ];
  }

  renderMinimal(_ctx: PromptContext): string[] {
    return [
      '## Delegation',
      'Use `agent_delegate` to delegate subtasks to a sub-agent.',
      'Set `runner: "claude-code"` for coding tasks. Default runner is `pi-agent-core`.',
    ];
  }
}
