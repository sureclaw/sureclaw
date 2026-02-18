// src/agent/prompt/modules/runtime.ts
import { BasePromptModule } from '../base-module.js';
import { isBootstrapMode } from '../types.js';
import type { PromptContext } from '../types.js';

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
      `**Workspace**: ${ctx.workspace}`,
    ];
  }
}
