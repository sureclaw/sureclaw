// src/agent/prompt/modules/skills.ts
import { BasePromptModule } from '../base-module.js';
import type { PromptContext } from '../types.js';

const INSTALL_ACTIONS = /\b(install|add|get|download|find|search|setup|set\s*up|configure|enable|activate|load|fetch|grab|pull|import|browse|look\s*(?:for|up))\b/i;

const SKILL_NOUNS = /\b(skills?|plugins?|extensions?|add-?ons?|modules?|packages?|integrations?|connectors?|tools?|capabilit(?:y|ies)|recipes?|workflows?|automations?|templates?|helpers?|utilities?|apps?|agents?|abilit(?:y|ies))\b/i;

const INQUIRY_PATTERNS = /\b(is there|are there|do you have|any|know of|recommend|suggest)\b/i;

const REGISTRY_REF = /clawhub|skills\.sh|github\.com/i;

/** Detect if user message indicates skill install intent. */
export function detectSkillInstallIntent(message: string): boolean {
  if (REGISTRY_REF.test(message)) return true;
  if (INSTALL_ACTIONS.test(message) && SKILL_NOUNS.test(message)) return true;
  if (INQUIRY_PATTERNS.test(message) && SKILL_NOUNS.test(message)) return true;
  return false;
}

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

  shouldInclude(_ctx: PromptContext): boolean {
    // Always include — skill installation guidance is needed even with no skills loaded
    return true;
  }

  render(ctx: PromptContext): string[] {
    const lines: string[] = [];

    if (ctx.skills.length > 0) {
      const rows = ctx.skills
        .map(s => {
          const warn = s.warnings?.length ? ` \u26A0 ${s.warnings.join(', ')}` : '';
          return `| ${s.name} | ${s.description}${warn} | \`/workspace/skills/${s.path}\` |`;
        })
        .join('\n');

      // Collect skills with missing deps for install guidance
      const skillsWithWarnings = ctx.skills.filter(s => s.warnings?.length);

      lines.push(
        '## Available Skills (Already Installed)',
        '',
        'These skills are already installed locally. Do NOT download or re-install them.',
        'Before replying, scan this list for a skill that matches the current task.',
        '',
        '**To use a skill:** call `read_file` with the exact path from the table, then follow its instructions.',
        'That is the ONLY step needed — one read_file call, then act on what it says.',
        'Do NOT use bash ls or any other discovery tool.',
        '',
        '| Skill | Description | Path |',
        '|-------|-------------|------|',
        rows,
      );

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
    } else {
      lines.push(
        '## Skills',
        '',
        'No skills are currently installed. You can search for and install skills from skills.sh or ClawHub.',
      );
    }

    if (ctx.hasWorkspace) {
      lines.push(
        '',
        '### Creating Skills',
        '',
        'Use the `skill` tool with `type: "create"` to author a new skill.',
        'Skills are saved to `/workspace/skills/`.',
      );
    }

    if (ctx.skillInstallEnabled) {
      lines.push(
        '',
        '### Installing New Skills',
        '',
        'Browse skills at https://skills.sh/ — the primary skill directory.',
        '',
        'By search: `skill({ query: "what you need" })`',
        'By 3-part path (owner/repo/skill): `skill({ slug: "vercel-labs/agent-skills/react-best-practices" })`',
        'By skills.sh URL: `skill({ slug: "https://skills.sh/owner/repo/skill" })`',
        'By GitHub URL: `skill({ slug: "https://github.com/owner/repo/tree/main/skill" })`',
        'By ClawHub slug: `skill({ slug: "author/skill-name" })`',
        '',
        'When the user provides a URL (skills.sh, GitHub, or ClawHub), pass it directly',
        'as the `slug` — the host extracts the correct slug from the URL.',
        'Do NOT use `query` with a URL — that triggers a search which may find the wrong skill.',
        '',
        'The host downloads, validates, and installs the skill automatically.',
        'The response includes `requiresEnv` (needed credentials) and `missingBins` (missing binaries).',
        'For each entry in `requiresEnv`, call `request_credential({ envName: "..." })`.',
      );
    }

    return lines;
  }

  renderMinimal(ctx: PromptContext): string[] {
    return [
      '## Skills',
      ctx.skills.length > 0
        ? `${ctx.skills.length} skills available. Use read_file with the skill path to load one.`
        : 'No skills installed.',
    ];
  }
}
