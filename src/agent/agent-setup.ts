/**
 * Shared agent setup — identity loading, prompt building, event subscription.
 *
 * Deduplicates logic shared between runner.ts (pi-agent-core) and
 * pi-session.ts (pi-coding-agent).
 */

import { getLogger } from '../logger.js';
import { PromptBuilder } from './prompt/builder.js';
import { loadIdentityFiles } from './identity-loader.js';
import { loadSkills } from './stream-utils.js';
import type { AgentConfig } from './runner.js';

const logger = getLogger().child({ component: 'agent-setup' });

const DEFAULT_CONTEXT_WINDOW = 200000;

export interface PromptBuildResult {
  systemPrompt: string;
  metadata: { [key: string]: unknown };
}

/**
 * Build the system prompt from skills, identity files, and configuration.
 * Used by both pi-agent-core and pi-coding-agent runners.
 */
export function buildSystemPrompt(config: AgentConfig): PromptBuildResult {
  const skills = loadSkills(config.skills);
  const identityFiles = loadIdentityFiles({
    agentDir: config.agentDir,
    userId: config.userId,
  });

  const promptBuilder = new PromptBuilder();
  const promptResult = promptBuilder.build({
    agentType: config.agent ?? 'pi-agent-core',
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
    hasWorkspaceTiers: !!(config.agentWorkspace || config.userWorkspace || config.scratchDir),
    hasGovernance: config.profile === 'paranoid' || config.profile === 'balanced',
  });

  logger.debug('prompt_built', { ...promptResult.metadata });

  return {
    systemPrompt: promptResult.content,
    metadata: { ...promptResult.metadata },
  };
}

/**
 * Subscribe to pi-ai agent events — streams text to stdout, logs tools
 * and errors to stderr. Returns a state object for tracking output.
 *
 * Works with both pi-agent-core Agent.subscribe() and
 * pi-coding-agent AgentSession.subscribe() — same event shape.
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
