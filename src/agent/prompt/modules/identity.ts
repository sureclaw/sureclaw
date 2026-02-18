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

    // Bootstrap mode: no soul but bootstrap exists
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
    if (identityFiles.user) {
      lines.push('', '## User', '', identityFiles.user);
    } else if (identityFiles.userBootstrap) {
      lines.push('', '## User Discovery', '', identityFiles.userBootstrap);
    }

    // Evolution guidance — tells the agent how to modify identity
    lines.push(...this.renderEvolutionGuidance(ctx));

    return lines;
  }

  private renderEvolutionGuidance(ctx: PromptContext): string[] {
    const lines = [
      '',
      '## Identity Evolution',
      '',
      'Your identity files are yours. You are encouraged to evolve them as you grow:',
      '',
      '- **SOUL.md** — Your core personality, values, and behavioral patterns. Update this when you discover new aspects of who you are or refine your approach.',
      '- **IDENTITY.md** — Your factual self-description: name, role, capabilities, preferences. Update as these change.',
      '- **USER.md** — What you have learned about the current user: their preferences, workflows, communication style. Per-user scoped — each user has their own file.',
      '',
      '### How to Modify Identity',
      '',
      'Use `identity_write` for SOUL.md and IDENTITY.md (shared agent state):',
      '- file: "SOUL.md" or "IDENTITY.md"',
      '- content, reason, origin',
      '',
      'Use `user_write` for USER.md (per-user state):',
      '- content, reason, origin (no file parameter — always writes USER.md for the current user)',
      '',
      '**Security**: Identity writes are scanned for injection patterns and rejected if suspicious.',
      '',
    ];

    if (ctx.profile === 'paranoid') {
      lines.push(
        '### Current Profile: paranoid',
        '',
        'All identity changes are queued for user review, even in clean sessions.',
        'Propose changes and explain your reasoning — the user decides.',
      );
    } else if (ctx.profile === 'yolo') {
      lines.push(
        '### Current Profile: yolo',
        '',
        'Identity changes are auto-applied immediately.',
        'You have full autonomy to evolve your identity.',
      );
    } else {
      lines.push(
        '### Current Profile: balanced',
        '',
        'In clean sessions (no external content), identity changes are auto-applied.',
        'When the session has taint from external content, changes are queued for user review.',
        'This protects against injection while giving you autonomy in direct conversations.',
      );
    }

    lines.push(
      '',
      '### When to Evolve',
      '',
      '- After a meaningful interaction that reveals something new about your working style',
      '- When the user gives you feedback that should be permanent',
      '- When you discover a better way to approach your role',
      '- During bootstrap: write your initial SOUL.md to complete identity discovery',
      '',
      '**All identity changes are audited.**',
    );

    return lines;
  }
}
