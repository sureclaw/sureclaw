// src/agent/prompt/modules/runtime.ts
import { BasePromptModule } from '../base-module.js';
import { isBootstrapMode } from '../types.js';
import type { PromptContext } from '../types.js';

/**
 * Format current local time as ISO 8601 with UTC offset, e.g. "2026-02-21T20:45:00-05:00".
 */
function localISOString(now: Date = new Date()): string {
  const off = now.getTimezoneOffset(); // minutes, positive = west of UTC
  const sign = off <= 0 ? '+' : '-';
  const absOff = Math.abs(off);
  const hh = String(Math.floor(absOff / 60)).padStart(2, '0');
  const mm = String(absOff % 60).padStart(2, '0');
  // Build YYYY-MM-DDTHH:mm:ss±HH:MM using local components
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}` +
    `${sign}${hh}:${mm}`
  );
}

/**
 * Cache-stable time: rounds minutes to nearest 5 and zeroes seconds.
 * Improves prompt-cache hit rate while still giving the model useful
 * time awareness (OpenClaw pattern).
 */
function cacheStableTime(now: Date = new Date()): string {
  const rounded = new Date(now);
  rounded.setMinutes(Math.floor(rounded.getMinutes() / 5) * 5);
  rounded.setSeconds(0);
  return localISOString(rounded);
}

/**
 * Runtime info module: agent type, sandbox tier, security profile, current time.
 * Priority 90 — last module.
 * Optional — can be dropped if token budget is tight.
 */
export class RuntimeModule extends BasePromptModule {
  readonly name = 'runtime';
  readonly priority = 90;
  readonly optional = true;

  shouldInclude(ctx: PromptContext): boolean {
    if (isBootstrapMode(ctx)) return false;
    return true;
  }

  render(ctx: PromptContext): string[] {
    const lines = [
      '## Runtime',
      '',
      `**Agent Type**: ${ctx.agentType}`,
      `**Sandbox**: ${ctx.sandboxType}`,
      `**Security Profile**: ${ctx.profile}`,
      `**Working Directory**: . (use ./scratch for working files)`,
      ...(ctx.hasAgentWorkspace ? [
        `**Agent Workspace**: ./agent (shared persistent files for this agent)`,
        `  - ./agent/identity/ — agent identity files (SOUL.md, IDENTITY.md, etc.) [read-only]`,
        `  - ./agent/skills/ — shared agent skills [read-only]`,
        ...(ctx.mcpCLIs?.length ? [
          `  - ./agent/bin/ — MCP tool CLIs (in PATH)`,
          `    Run \`<tool> --help\` for usage. Available: ${ctx.mcpCLIs.join(', ')}`,
          `    These are Node.js CLIs. When writing multi-step scripts, use sandbox_write_file to write a .js file to ./scratch/, then run it with \`node scratch/script.js\`. Do not use heredocs or cat.`,
        ] : []),
      ] : []),
      ...(ctx.hasUserWorkspace ? [
        `**User Workspace**: ./user (persistent files for the current user)`,
        `  - ./user/skills/ — your personal skills`,
        `  - ./user/bin/ — your installed binaries (in PATH)`,
      ] : []),
      `**Current Time**: ${cacheStableTime()}`,
    ];

    // Enterprise context
    if (ctx.agentId) {
      lines.push(`**Agent ID**: ${ctx.agentId}`);
    }
    if (ctx.hasGovernance) {
      lines.push('', '### Governance',
        'Identity changes go through a proposal system. Use `governance({ type: "propose" })` to suggest changes.',
        'Use `governance({ type: "list_proposals" })` to check pending proposals.',
      );
    }

    return lines;
  }
}
