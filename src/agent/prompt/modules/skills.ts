// src/agent/prompt/modules/skills.ts
import { BasePromptModule } from '../base-module.js';
import type { PromptContext } from '../types.js';

/**
 * Skills module: injects skill markdown files.
 * Priority 70 — late in prompt, after context.
 */
export class SkillsModule extends BasePromptModule {
  readonly name = 'skills';
  readonly priority = 70;
  readonly optional = true;

  shouldInclude(ctx: PromptContext): boolean {
    return ctx.skills.length > 0;
  }

  render(ctx: PromptContext): string[] {
    return [
      '## Skills',
      '',
      'Skills directory: ./skills',
      '',
      ctx.skills.join('\n---\n'),
    ];
  }
}
