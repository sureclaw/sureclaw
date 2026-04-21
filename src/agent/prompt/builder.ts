// src/agent/prompt/builder.ts
import type { PromptContext, PromptModule } from './types.js';
import { allocateModules } from './budget.js';
import { IdentityModule } from './modules/identity.js';
import { InjectionDefenseModule } from './modules/injection-defense.js';
import { SecurityModule } from './modules/security.js';
import { ToolStyleModule } from './modules/tool-style.js';
import { MemoryRecallModule } from './modules/memory-recall.js';
import { SkillsModule } from './modules/skills.js';
import { CommandsModule } from './modules/commands.js';
import { DelegationModule } from './modules/delegation.js';
import { HeartbeatModule } from './modules/heartbeat.js';
import { RuntimeModule } from './modules/runtime.js';
import { ToolCatalogModule } from './modules/tool-catalog.js';
import { ReplyGateModule } from './modules/reply-gate.js';

export interface PromptResult {
  content: string;
  metadata: PromptMetadata;
}

export interface PromptMetadata {
  moduleCount: number;
  modules: string[];
  estimatedTokens: number;
  buildTimeMs: number;
  tokensByModule: Record<string, number>;
  /** Model's max context window in tokens. */
  contextWindow: number;
  /** Estimated tokens consumed by conversation history. */
  historyTokens: number;
  /** Percentage of context window still available (0-100). */
  percentRemaining: number;
}

/**
 * Assembles system prompt from ordered modules.
 * Modules are registered at construction and filtered/rendered per-call.
 */
export class PromptBuilder {
  private readonly modules: PromptModule[];

  constructor() {
    this.modules = [
      new IdentityModule(),           // 0
      new InjectionDefenseModule(),   // 5
      new SecurityModule(),           // 10
      new ToolStyleModule(),          // 12
      new MemoryRecallModule(),       // 60
      new SkillsModule(),             // 70
      new CommandsModule(),           // 72
      new DelegationModule(),         // 75
      new HeartbeatModule(),          // 80
      new RuntimeModule(),            // 90
      new ToolCatalogModule(),        // 92
      new ReplyGateModule(),          // 95
    ].sort((a, b) => a.priority - b.priority);
  }

  build(ctx: PromptContext): PromptResult {
    const start = Date.now();

    // Filter modules that should be included, then allocate within budget
    const eligible = this.modules.filter(m => m.shouldInclude(ctx));
    const allocations = allocateModules(eligible, ctx);

    // Render each module (using minimal version when flagged by budget manager)
    const sections: string[] = [];
    const tokensByModule: Record<string, number> = {};
    for (const { module: mod, useMinimal } of allocations) {
      const lines = useMinimal && mod.renderMinimal
        ? mod.renderMinimal(ctx)
        : mod.render(ctx);
      if (lines.length > 0) {
        const section = lines.join('\n');
        sections.push(section);
        tokensByModule[mod.name] = Math.ceil(section.length / 4);
      }
    }

    const content = sections.join('\n\n');
    const estimatedTokens = Math.ceil(content.length / 4);
    const used = estimatedTokens + ctx.historyTokens;
    const percentRemaining = ctx.contextWindow > 0
      ? Math.max(0, Math.round(((ctx.contextWindow - used) / ctx.contextWindow) * 100))
      : 0;

    return {
      content,
      metadata: {
        moduleCount: allocations.length,
        modules: allocations.map(a => a.module.name),
        estimatedTokens,
        buildTimeMs: Date.now() - start,
        tokensByModule,
        contextWindow: ctx.contextWindow,
        historyTokens: ctx.historyTokens,
        percentRemaining,
      },
    };
  }
}
