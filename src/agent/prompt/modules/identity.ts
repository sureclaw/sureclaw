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

    // Agent instruction (AGENT.md or default)
    if (identityFiles.agent) {
      lines.push(identityFiles.agent);
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
    }

    return lines;
  }
}
