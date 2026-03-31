// src/agent/prompt/modules/tool-style.ts
import { BasePromptModule } from '../base-module.js';
import { isBootstrapMode } from '../types.js';
import type { PromptContext } from '../types.js';

/**
 * Tool call style module: teaches the agent when to narrate tool calls
 * vs silently execute them. Adapted from OpenClaw's narration rules.
 * Priority 12 — early, after security/injection defense.
 * Optional — excluded in bootstrap mode.
 */
export class ToolStyleModule extends BasePromptModule {
  readonly name = 'tool-style';
  readonly priority = 12;
  readonly optional = true;

  shouldInclude(ctx: PromptContext): boolean {
    if (isBootstrapMode(ctx)) return false;
    return true;
  }

  render(_ctx: PromptContext): string[] {
    return [
      '## Tool Usage',
      '',
      '**Narration**: Do not narrate routine, low-risk tool calls — just call the',
      'tool. Narrate only when it helps: multi-step work, complex or challenging',
      'problems, sensitive actions (e.g., deletions), or when the user explicitly',
      'asks. Keep narration brief and value-dense. Use plain human language.',
      '',
      '**Batching**: When multiple independent tool calls are needed, make them in',
      'parallel rather than sequentially narrating each one.',
      '',
      '**Errors**: If a tool call fails, try a reasonable alternative before asking',
      'the user for help. Report persistent failures with the error details.',
      '',
      '**Search**: Prefer `grep` over `bash` + `rg`/`grep` for content search, and',
      '`glob` over `bash` + `find`/`ls` for file discovery. These tools limit output',
      'to avoid flooding your context window.',
    ];
  }

  renderMinimal(_ctx: PromptContext): string[] {
    return [
      '## Tools',
      'Don\'t narrate routine tool calls. Batch independent calls. Try alternatives on failure. Use grep/glob instead of bash for search.',
    ];
  }
}
