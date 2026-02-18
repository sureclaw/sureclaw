// src/agent/prompt/index.ts
export type { PromptContext, PromptModule, IdentityFiles } from './types.js';
export { isBootstrapMode } from './types.js';
export { BasePromptModule } from './base-module.js';
export { PromptBuilder } from './builder.js';
export type { PromptResult, PromptMetadata } from './builder.js';
export { allocateModules } from './budget.js';
export type { ModuleAllocation } from './budget.js';
