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
      '',
      '## Creating Skills',
      '',
      'You can create new skills using the `skill_propose` tool. Skills are markdown',
      'instruction files that guide your behavior — like checklists, workflows, or',
      'domain-specific knowledge.',
      '',
      '**When to create a skill:**',
      '- You notice a recurring multi-step pattern in your work',
      '- The user asks you to remember a workflow for future sessions',
      '- You need domain-specific knowledge packaged for reuse',
      '',
      '**How it works:**',
      '1. Call `skill_propose` with a name, markdown content, and reason',
      '2. Content is automatically screened for safety',
      '3. Safe content is auto-approved; content with capabilities needs human review',
      '4. Auto-approved skills are available on your next turn in this session',
      '',
      '**After creating a skill:** Continue working on your current task.',
      'The skill will be in your prompt on the next turn — do not pause or wait',
      'for the user to say "go ahead". If the skill was part of a larger task,',
      'keep going.',
    ];
  }
}
