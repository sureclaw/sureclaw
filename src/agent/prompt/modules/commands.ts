import { BasePromptModule } from '../base-module.js';
import type { PromptContext } from '../types.js';

/** Escape pipe characters and strip newlines for markdown table cells. */
function escapeTableCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ').trim();
}

/**
 * Commands module: surfaces installed plugin slash commands.
 * Priority 72 — just after skills (70).
 */
export class CommandsModule extends BasePromptModule {
  readonly name = 'commands';
  readonly priority = 72;
  readonly optional = true;

  shouldInclude(ctx: PromptContext): boolean {
    return (ctx.commands?.length ?? 0) > 0;
  }

  render(ctx: PromptContext): string[] {
    const lines: string[] = [
      '## Plugin Commands',
      '',
      'These slash commands are available from installed plugins.',
      'When the user invokes a command, follow the instructions from the command content.',
      '',
      '| Command | Plugin | Description |',
      '|---------|--------|-------------|',
    ];

    for (const cmd of ctx.commands ?? []) {
      const firstLine = cmd.content.split('\n').find(l => l.trim() && !l.startsWith('#'))?.trim() ?? '';
      lines.push(`| /${escapeTableCell(cmd.name)} | ${escapeTableCell(cmd.pluginName)} | ${escapeTableCell(firstLine)} |`);
    }

    return lines;
  }

  renderMinimal(ctx: PromptContext): string[] {
    return [
      '## Commands',
      `${ctx.commands?.length ?? 0} plugin commands available.`,
    ];
  }
}
