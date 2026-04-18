// src/agent/prompt/modules/skills.ts
import { BasePromptModule } from '../base-module.js';
import type { PromptContext } from '../types.js';

/**
 * Skills module: summarises available skills for the agent. Skills live in
 * `.ax/skills/<name>/SKILL.md`; the agent reads them on demand.
 * Priority 70 — late in prompt, after context.
 */
export class SkillsModule extends BasePromptModule {
  readonly name = 'skills';
  readonly priority = 70;
  readonly optional = true;

  shouldInclude(_ctx: PromptContext): boolean {
    return true;
  }

  render(ctx: PromptContext): string[] {
    const lines: string[] = [];

    if (ctx.skills.length > 0) {
      lines.push('## Available skills', '');
      for (const s of ctx.skills) {
        const kind = s.kind ?? 'enabled';
        let prefix = '';
        if (kind === 'pending') {
          prefix = s.pendingReasons?.length
            ? `(setup pending: ${s.pendingReasons.join(', ')}) `
            : '(setup pending) ';
        } else if (kind === 'invalid') {
          prefix = '(invalid) ';
        }
        // Compat bridge: legacy filesystem-backed rows still carry per-skill
        // `warnings` (missing bins). Surface them parenthetically until phase 4
        // migrates those into `pendingReasons`.
        if (s.warnings?.length) {
          prefix = `${prefix}(missing: ${s.warnings.join(', ')}) `;
        }
        const desc = s.description ?? '';
        const tail = prefix || desc ? ` — ${prefix}${desc}`.trimEnd() : '';
        lines.push(`- **${s.name}**${tail}`);
      }
      lines.push('', 'To use a skill, read `.ax/skills/<name>/SKILL.md` and follow its instructions.');
    } else {
      lines.push('## Skills', '', 'No skills are currently installed.');
    }

    if (ctx.hasWorkspace) {
      lines.push(
        '',
        '### Creating Skills',
        '',
        'Skills are git-native: write `SKILL.md` to `.ax/skills/<name>/SKILL.md` using your file-edit tools, then commit and push.',
        'The host reconciler picks up the push and enables the skill once any required credentials and domain approvals are in place.',
      );
    }

    return lines;
  }

  renderMinimal(ctx: PromptContext): string[] {
    return [
      '## Skills',
      ctx.skills.length > 0
        ? `${ctx.skills.length} skills available. Read \`.ax/skills/<name>/SKILL.md\` to load one.`
        : 'No skills installed.',
    ];
  }
}
