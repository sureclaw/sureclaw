// src/agent/prompt/modules/runtime.ts
import { BasePromptModule } from '../base-module.js';
import { isBootstrapMode } from '../types.js';
import type { PromptContext } from '../types.js';

/**
 * Sanitize workspace path: strip everything up to and including 'workspaces/'
 * so the agent never sees the host username or home directory.
 * e.g. "/home/user/.ax/data/workspaces/main/cli/default" → "./workspace"
 */
function sanitizeWorkspacePath(fullPath: string): string {
  const marker = '/workspaces/';
  const idx = fullPath.indexOf(marker);
  if (idx !== -1) {
    return './workspace';
  }
  // Temp workspaces (e.g. /tmp/ax-ws-xxxxx) — just show generic label
  if (fullPath.includes('/ax-ws-')) {
    return './workspace';
  }
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
      `**Current Time**: ${localISOString()}`,
    ];

    // Enterprise context
    if (ctx.agentId) {
      lines.push(`**Agent ID**: ${ctx.agentId}`);
    }
    if (ctx.hasWorkspaceTiers) {
      lines.push('', '### Workspace Tiers',
        '- **agent**: Shared files (read-only in sandbox). Use `workspace_write` with tier "agent" to write.',
        '- **user**: Your personal persistent files. Use `workspace_write` with tier "user".',
        '- **scratch**: Ephemeral per-session files. Deleted when session ends.',
      );
    }
    if (ctx.hasGovernance) {
      lines.push('', '### Governance',
        'Identity changes go through a proposal system. Use `identity_propose` to suggest changes.',
        'Use `proposal_list` to check pending proposals.',
      );
    }

    return lines;
  }
}
