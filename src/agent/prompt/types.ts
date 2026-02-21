// src/agent/prompt/types.ts
import type { AgentType } from '../../types.js';

/**
 * Context passed to prompt modules during system prompt construction.
 * Derived from AgentConfig + host-provided taint state.
 */
export interface PromptContext {
  // Agent
  agentType: AgentType;
  workspace: string;
  skills: string[];

  // Security (from host via stdin payload)
  profile: string;       // 'paranoid' | 'balanced' | 'yolo'
  sandboxType: string;   // 'nsjail' | 'seatbelt' | 'docker' | 'bwrap' | 'subprocess'
  taintRatio: number;    // 0-1, current session taint ratio from host
  taintThreshold: number; // profile threshold (0.10, 0.30, 0.60)

  // Identity files (loaded from agentDir, empty string if absent)
  identityFiles: IdentityFiles;

  // Workspace context (CONTEXT.md content)
  contextContent: string;

  // Reply gating (from host — channel messages where bot may choose silence)
  replyOptional?: boolean;

  // Budget
  contextWindow: number;  // model's max tokens (default 200000)
  historyTokens: number;  // estimated tokens in conversation history
}

export interface IdentityFiles {
  agents: string;         // AGENTS.md
  soul: string;           // SOUL.md
  identity: string;       // IDENTITY.md
  user: string;           // USER.md
  bootstrap: string;      // BOOTSTRAP.md
  userBootstrap: string;  // USER_BOOTSTRAP.md (shown when USER.md is absent)
  heartbeat: string;      // HEARTBEAT.md
}

/** Bootstrap mode: soul is absent but bootstrap instructions exist. */
export function isBootstrapMode(ctx: PromptContext): boolean {
  return !ctx.identityFiles.soul && !!ctx.identityFiles.bootstrap;
}

/**
 * A composable unit of system prompt content.
 */
export interface PromptModule {
  /** Unique module name */
  readonly name: string;

  /** Sort order: lower = earlier in prompt. Range 0-100. */
  readonly priority: number;

  /** Whether this module should be included given the current context */
  shouldInclude(ctx: PromptContext): boolean;

  /** Render the module as an array of lines */
  render(ctx: PromptContext): string[];

  /** Estimate token count (1 token ~ 4 chars) */
  estimateTokens(ctx: PromptContext): number;

  /** If true, this module can be dropped when budget is tight */
  optional?: boolean;

  /** Minimal version for tight budgets. Falls back to render() if absent. */
  renderMinimal?(ctx: PromptContext): string[];
}
