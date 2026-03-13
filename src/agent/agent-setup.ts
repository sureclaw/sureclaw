/**
 * Shared agent setup — identity loading, prompt building, event subscription.
 *
 * Deduplicates logic shared between pi-session.ts and claude-code.ts runners.
 */

import { getLogger } from '../logger.js';
import { PromptBuilder } from './prompt/builder.js';
import { loadIdentityFiles } from './identity-loader.js';
import { loadSkills } from './stream-utils.js';
import type { AgentConfig } from './runner.js';
import type { ToolFilterContext } from './tool-catalog.js';

const logger = getLogger().child({ component: 'agent-setup' });

const DEFAULT_CONTEXT_WINDOW = 200000;

export interface PromptBuildResult {
  systemPrompt: string;
  metadata: { [key: string]: unknown };
  /** Context for filtering tools to match prompt module inclusion. */
  toolFilter: ToolFilterContext;
}

/**
 * Build the system prompt from skills, identity files, and configuration.
 * Used by both pi-coding-agent and claude-code runners.
 *
 * Also returns a ToolFilterContext so callers can filter the tool catalog
 * to match which prompt modules were included (e.g., no heartbeat content
 * → no HeartbeatModule → no scheduler tools).
 */
export function buildSystemPrompt(config: AgentConfig): PromptBuildResult {
  // Skills come via stdin payload (array), map to SkillSummary[] directly.
  const skills: import('./prompt/types.js').SkillSummary[] = Array.isArray(config.skills)
    ? config.skills.map(s => ({ name: s.name, description: s.description, path: s.path }))
    : [];

  // Identity is pre-loaded from host (via stdin payload from DocumentStore).
  const identityFiles = loadIdentityFiles({
    userId: config.userId,
    preloaded: config.identity,
  });

  const hasWorkspaceTiers = !!(config.agentWorkspace || config.userWorkspace);
  const hasGovernance = config.profile === 'paranoid' || config.profile === 'balanced';

  const promptBuilder = new PromptBuilder();
  const promptResult = promptBuilder.build({
    agentType: config.agent ?? 'pi-coding-agent',
    workspace: config.workspace,
    skills,
    profile: config.profile ?? 'balanced',
    sandboxType: config.sandboxType ?? 'subprocess',
    taintRatio: config.taintRatio ?? 0,
    taintThreshold: config.taintThreshold ?? 1,
    identityFiles,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    historyTokens: config.history?.length ? Math.ceil(JSON.stringify(config.history).length / 4) : 0,
    replyOptional: config.replyOptional ?? false,
    // Enterprise fields
    agentId: config.agentId,
    hasWorkspaceTiers,
    hasGovernance,
  });

  const toolFilter: ToolFilterContext = {
    hasHeartbeat: !!identityFiles.heartbeat?.trim(),
    hasSkills: skills.length > 0,
    hasWorkspaceTiers,
    hasGovernance,
  };

  logger.debug('prompt_built', { ...promptResult.metadata, toolFilter });

  return {
    systemPrompt: promptResult.content,
    metadata: { ...promptResult.metadata },
    toolFilter,
  };
}

/**
 * Subscribe to pi-ai agent events — streams text to stdout, logs tools
 * and errors to stderr. Returns a state object for tracking output.
 *
 * Works with pi-coding-agent AgentSession.subscribe() event shape.
 */
export function subscribeAgentEvents(
  subscribable: { subscribe(fn: (event: any) => void): void },
  config: { verbose?: boolean },
): { hasOutput: () => boolean; eventCount: () => number } {
  let hasOutput = false;
  let eventCount = 0;
  let turnCount = 0;

  subscribable.subscribe((event: any) => {
    eventCount++;
    if (event.type === 'message_update') {
      const ame = event.assistantMessageEvent;
      logger.debug('agent_event', { type: ame.type, eventCount });

      if (ame.type === 'text_start' && hasOutput) {
        process.stdout.write('\n\n');
      }
      if (ame.type === 'text_delta') {
        process.stdout.write(ame.delta);
        hasOutput = true;
      }
      if (ame.type === 'toolcall_end') {
        logger.debug('tool_call', { toolName: ame.toolCall.name, toolId: ame.toolCall.id });
        if (config.verbose) {
          process.stderr.write(`[tool] ${ame.toolCall.name}\n`);
        }
      }
      if (ame.type === 'error') {
        const errText = ame.error?.errorMessage ?? String(ame.error);
        logger.error('agent_error_event', { error: errText });
        process.stderr.write(`Agent error: ${errText}\n`);
        // Also write to stdout so the server can surface the error in the response
        if (!hasOutput) {
          process.stdout.write(errText);
          hasOutput = true;
        }
      }
      if (ame.type === 'done') {
        turnCount++;
        logger.debug('agent_done_event', { reason: ame.reason });
        if (config.verbose) {
          process.stderr.write(`[turn ${turnCount}] ${ame.reason}\n`);
        }
      }
    }
  });

  return {
    hasOutput: () => hasOutput,
    eventCount: () => eventCount,
  };
}
