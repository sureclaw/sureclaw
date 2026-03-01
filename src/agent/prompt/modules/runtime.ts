// src/agent/prompt/modules/runtime.ts
import { BasePromptModule } from '../base-module.js';
import { isBootstrapMode } from '../types.js';
import type { PromptContext } from '../types.js';

/**
 * Sanitize workspace path for display in the prompt.
 *
 * With canonical sandbox paths, the workspace is already at a clean path
 * like /workspace (Docker/bwrap/nsjail) or /tmp/.ax-mounts-xxx/workspace
 * (seatbelt/subprocess). We display it as ./workspace for simplicity.
 */
function sanitizeWorkspacePath(fullPath: string): string {
  // Canonical path from Docker/bwrap/nsjail
  if (fullPath === '/workspace') return './workspace';
  // Symlink-based path from seatbelt/subprocess
  if (fullPath.includes('.ax-mounts-') && fullPath.endsWith('/workspace')) return './workspace';
  // Legacy host paths (backward compat)
  if (fullPath.includes('/workspaces/') || fullPath.includes('/ax-ws-')) return './workspace';
  return './workspace';
}

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
      `**Workspace**: ${sanitizeWorkspacePath(ctx.workspace)}`,
      `**Current Time**: ${cacheStableTime()}`,
    ];

    // Enterprise context
    if (ctx.agentId) {
      lines.push(`**Agent ID**: ${ctx.agentId}`);
    }
    if (ctx.hasWorkspaceTiers) {
      lines.push('', '### Workspace Tiers',
        '- **agent**: Shared files (read-only in sandbox). Use `workspace({ type: "write", tier: "agent" })` to write.',
        '- **user**: Your personal persistent files. Use `workspace({ type: "write", tier: "user" })`.',
        '- **scratch**: Ephemeral per-session files. Deleted when session ends.',
      );
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
