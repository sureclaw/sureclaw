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
 * Runtime info module: agent type, sandbox tier, security profile.
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
    return [
      '## Runtime',
      '',
      `**Agent Type**: ${ctx.agentType}`,
      `**Sandbox**: ${ctx.sandboxType}`,
      `**Security Profile**: ${ctx.profile}`,
      `**Workspace**: ${sanitizeWorkspacePath(ctx.workspace)}`,
    ];
  }
}
