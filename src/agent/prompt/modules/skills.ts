// src/agent/prompt/modules/skills.ts
import { BasePromptModule } from '../base-module.js';
import type { PromptContext } from '../types.js';

/**
 * Skills module: progressive disclosure of available skills.
 * Only compact summaries are injected; the agent calls `skill({ type: "read" })`
 * to load full instructions on demand.
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
    const rows = ctx.skills
      .map(s => {
        const warn = s.warnings?.length ? ` \u26A0 ${s.warnings.join(', ')}` : '';
        return `| ${s.name} | ${s.description}${warn} |`;
      })
      .join('\n');

    // Collect skills with missing deps for install guidance
    const skillsWithWarnings = ctx.skills.filter(s => s.warnings?.length);

    const lines = [
      '## Available Skills',
      '',
      'Before replying, scan this list for a skill that matches the current task.',
      'If exactly one skill clearly applies: read the skill file from ./user/skills/ or',
      './agent/skills/ to load its full instructions, then follow them. If multiple could',
      'apply: choose the most specific one, then read and follow it. If none clearly',
      'apply: do not load any skill \u2014 just respond normally.',
      '',
      'Never read more than one skill up front; only read after selecting.',
      '',
      '| Skill | Description |',
      '|-------|-------------|',
      rows,
    ];

    // Surface install guidance when skills have missing dependencies
    if (skillsWithWarnings.length > 0) {
      lines.push(
        '',
        '### Missing Dependencies',
        '',
        'Some skills have missing binary dependencies (marked with \u26A0 above).',
        'Install them directly using package managers (npm, pip, brew, etc.)',
        'and place binaries in `./user/bin/` so they persist across sessions.',
      );
    }

    lines.push(
      '',
      '### Creating Skills',
      '',
      'Create new skills by writing markdown files directly to `./user/skills/`.',
      'File-based: `./user/skills/my-skill.md`',
      'Directory-based: `./user/skills/my-skill/SKILL.md`',
      '',
      '**When to create a skill:**',
      '- You notice a recurring multi-step pattern in your work',
      '- The user asks you to remember a workflow for future sessions',
      '- You need domain-specific knowledge packaged for reuse',
      '',
      '**After creating a skill:** Continue working on your current task.',
      'The skill appears in your list on the next session.',
    );

    return lines;
  }

  renderMinimal(ctx: PromptContext): string[] {
    return [
      '## Skills',
      `${ctx.skills.length} skills available. Read skill files from ./user/skills/ or ./agent/skills/ as needed.`,
    ];
  }
}
