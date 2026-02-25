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
      '### Writing good delegation calls',
      '',
      'Keep `task` and `context` **minimal and self-contained**. The sub-agent has',
      'no access to your conversation history, identity files, or system prompt.',
      'It only sees what you put in `task` and `context`.',
      '',
      '- **`task`**: A clear, specific instruction. Include acceptance criteria.',
      '- **`context`**: Only the facts the sub-agent needs — not your full context.',
      '  Write a concise summary of who you are and what the project is about.',
      '  Do NOT paste your entire SOUL.md, IDENTITY.md, or conversation history.',
      '  A few sentences of relevant background is almost always enough.',
      '',
      'Bad: pasting 2000 words of project documentation into `context`.',
      'Good: "This is a TypeScript project using vitest for tests. The codebase',
      'follows a provider contract pattern with co-located types."',
      '',
      '### Other parameters',
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
      'Keep context minimal — a few sentences of relevant background, not your full identity or history.',
    ];
  }
}
