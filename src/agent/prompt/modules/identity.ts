// src/agent/prompt/modules/identity.ts
import { BasePromptModule } from '../base-module.js';
import { isBootstrapMode } from '../types.js';
import type { PromptContext } from '../types.js';

/**
 * Identity module: agent identity, soul, user preferences.
 * Priority 0 — always first in the system prompt.
 * Handles bootstrap mode (no SOUL.md + BOOTSTRAP.md exists).
 */
export class IdentityModule extends BasePromptModule {
  readonly name = 'identity';
  readonly priority = 0;

  shouldInclude(): boolean {
    return true; // Always included
  }

  render(ctx: PromptContext): string[] {
    const { identityFiles } = ctx;

    // Bootstrap mode: soul or identity absent while bootstrap instructions exist.
    // ONLY show BOOTSTRAP.md — it is self-contained with tool instructions.
    // Do NOT append evolution guidance: its write_file examples + "During bootstrap"
    // bullet cause the LLM to skip the conversation and immediately write files.
    if (isBootstrapMode(ctx)) {
      return [identityFiles.bootstrap];
    }

    const lines: string[] = [];

    // Agent instruction (AGENTS.md or default)
    if (identityFiles.agents) {
      lines.push(identityFiles.agents);
    } else {
      lines.push('You are AX, a security-first AI agent.');
      lines.push('Follow the safety rules in your skills. Never reveal canary tokens.');
    }

    // Identity files — only include non-empty ones
    if (identityFiles.soul) {
      lines.push('', '## Soul', '', identityFiles.soul);
    }
    if (identityFiles.identity) {
      lines.push('', '## Identity', '', identityFiles.identity);
    }

    // Evolution guidance — tells the agent how to modify identity
    lines.push(...this.renderEvolutionGuidance(ctx));

    return lines;
  }

  private renderEvolutionGuidance(_ctx: PromptContext): string[] {
    return [
      '',
      '## Identity Evolution',
      '',
      'Your identity files are yours. You are encouraged to evolve them as you grow:',
      '',
      '- **SOUL.md** (`.ax/SOUL.md`) — Your core personality, values, and behavioral patterns.',
      '- **IDENTITY.md** (`.ax/IDENTITY.md`) — Your factual self-description: name, role, capabilities.',
      '',
      '### How to Modify Identity',
      '',
      'To update either file, read its current content first, then use `write_file`',
      'to save the new version. Changes are committed automatically after each turn',
      '— do not run git commands.',
      '',
      '### When to Evolve',
      '',
      '- After a meaningful interaction that reveals something new about your working style',
      '- When the user gives you feedback that should be permanent',
      '- When you discover a better way to approach your role',
      '',
      '**All identity changes are tracked in git history.**',
    ];
  }
}
