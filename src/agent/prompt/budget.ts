// src/agent/prompt/budget.ts
import type { PromptModule, PromptContext } from './types.js';

const OUTPUT_RESERVE = 4096; // Reserve tokens for model output

export interface ModuleAllocation {
  module: PromptModule;
  useMinimal: boolean;
}

/**
 * Filter modules to fit within the context window budget.
 * Required modules are always included. Optional modules are added
 * by priority until budget is exhausted, using renderMinimal if available.
 */
export function allocateModules(modules: PromptModule[], ctx: PromptContext): ModuleAllocation[] {
  const budget = ctx.contextWindow - ctx.historyTokens - OUTPUT_RESERVE;
  const required = modules.filter(m => !m.optional);
  const optional = modules.filter(m => m.optional);

  // Required modules always included
  const allocations = new Map<PromptModule, ModuleAllocation>();
  for (const m of required) {
    allocations.set(m, { module: m, useMinimal: false });
  }
  let used = required.reduce((sum, m) => sum + m.estimateTokens(ctx), 0);

  // Add optional modules that fit
  for (const mod of optional) {
    const fullTokens = mod.estimateTokens(ctx);
    if (used + fullTokens <= budget) {
      allocations.set(mod, { module: mod, useMinimal: false });
      used += fullTokens;
    } else if (mod.renderMinimal) {
      // Try minimal version
      const minTokens = Math.ceil(mod.renderMinimal(ctx).join('\n').length / 4);
      if (used + minTokens <= budget) {
        allocations.set(mod, { module: mod, useMinimal: true });
        used += minTokens;
      }
    }
    // Otherwise drop the module
  }

  // Preserve original priority order
  return modules.filter(m => allocations.has(m)).map(m => allocations.get(m)!);
}
