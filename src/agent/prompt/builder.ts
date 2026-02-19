// src/agent/prompt/builder.ts
import type { PromptContext, PromptModule } from './types.js';
import { allocateModules } from './budget.js';
import { IdentityModule } from './modules/identity.js';
import { InjectionDefenseModule } from './modules/injection-defense.js';
import { SecurityModule } from './modules/security.js';
import { ContextModule } from './modules/context.js';
import { SkillsModule } from './modules/skills.js';
import { HeartbeatModule } from './modules/heartbeat.js';
import { RuntimeModule } from './modules/runtime.js';

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
      new ContextModule(),            // 60
      new SkillsModule(),             // 70
      new HeartbeatModule(),          // 80
      new RuntimeModule(),            // 90
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

    return {
      content,
      metadata: {
        moduleCount: allocations.length,
        modules: allocations.map(a => a.module.name),
        estimatedTokens,
        buildTimeMs: Date.now() - start,
        tokensByModule,
      },
    };
  }
}
