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
      const anyPending = ctx.skills.some((s) => (s.kind ?? 'enabled') === 'pending');
      const anyInvalid = ctx.skills.some((s) => s.kind === 'invalid');
      if (anyPending || anyInvalid) {
        lines.push(
          'A skill is usable ONLY when its state is `[ENABLED]`. A `[PENDING]` skill\'s MCP tools are NOT registered and its declared hostnames are NOT on the proxy allowlist — the tools will be missing from your catalog and any direct `fetch()` to its hosts will be denied. Do NOT try `execute_script`, raw `fetch()`, or `npx` workarounds for pending skills. Tell the user the skill is awaiting admin approval and end your turn. A `[INVALID]` skill has a malformed SKILL.md; rewrite it using `skill-creator`.',
          '',
        );
      }
      for (const s of ctx.skills) {
        const kind = s.kind ?? 'enabled';
        const stateLabel = kind === 'pending' ? '[PENDING]' : kind === 'invalid' ? '[INVALID]' : '[ENABLED]';
        let suffix = '';
        if (kind === 'pending' && s.pendingReasons?.length) {
          suffix = ` (waiting on: ${s.pendingReasons.join(', ')})`;
        }
        // Compat bridge: legacy filesystem-backed rows still carry per-skill
        // `warnings` (missing bins). Surface them parenthetically until phase 4
        // migrates those into `pendingReasons`.
        if (s.warnings?.length) {
          suffix = `${suffix} (missing: ${s.warnings.join(', ')})`;
        }
        const desc = s.description ?? '';
        const descPart = desc ? ` — ${desc}` : '';
        lines.push(`- ${stateLabel} **${s.name}**${descPart}${suffix}`);
      }
      lines.push('', 'To use a skill, read `.ax/skills/<name>/SKILL.md` and follow its instructions. Remember: only `[ENABLED]` skills are usable.');
    } else {
      lines.push('## Skills', '', 'No skills are currently installed.');
    }

    if (ctx.hasWorkspace) {
      lines.push(
        '',
        '### Creating new skills',
        '',
        'When the user asks for a capability no installed skill covers, you MUST read `.ax/skills/skill-creator/SKILL.md` **in full** before writing any new SKILL.md. AX\'s frontmatter format is strict and differs from `claude_desktop_config.json` / generic MCP docs — do NOT improvise from training. The parser rejects every one of these common mistakes:',
        '- YAML inside a ```yaml fenced code block — the file must start with `---` on line 1, and frontmatter goes between two `---` lines, NOT inside a code block.',
        '- `title:` instead of `name:` — AX uses `name:`, and it must match the directory (`.ax/skills/linear/` → `name: linear`).',
        '- Bare credential strings (`credentials: [LINEAR_API_KEY]`) — AX requires objects with `envName`, `authType`, `scope`.',
        '- Claude Desktop\'s stdio MCP (`mcp: { type: stdio, command: npx, args: [...] }`) — AX supports **only** remote MCP over `https://`. Use `mcpServers: [{ name, url: https://..., credential }]`.',
        '- Unknown top-level keys (`capabilities`, `configuration`, etc.) — strict Zod rejects them.',
        '',
        'To create a skill, use your file-edit tools to write `.ax/skills/<name>/SKILL.md`. You do not run git yourself — the sidecar commits at end-of-turn automatically.',
        'The skill goes through admin approval in the dashboard before it activates. Once any declared credentials are provided and domains approved, its MCP tools and proxy allowlist entries come online.',
        'If the next turn\'s "Available skills" section shows your new skill as `[INVALID]`, the parser rejected your frontmatter — re-read `.ax/skills/skill-creator/SKILL.md` and rewrite using the exact `---` / `name:` / `---` shape shown in its examples.',
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
