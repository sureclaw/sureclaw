/**
 * Shared agent setup — identity loading, prompt building, event subscription.
 *
 * Deduplicates logic shared between pi-session.ts and claude-code.ts runners.
 */

import { getLogger } from '../logger.js';
import { PromptBuilder } from './prompt/builder.js';
import { loadIdentityFiles } from './identity-loader.js';
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
  // Skills are delivered authoritatively from the host via the stdin payload.
  const skills = config.skills ?? [];

  // Identity is pre-loaded from host (via stdin payload from committed git state).
  const identityFiles = loadIdentityFiles(config.identity);

  const hasGovernance = false; // Governance removed — identity changes are validated at git commit time

  const promptBuilder = new PromptBuilder();
  const promptResult = promptBuilder.build({
    agentType: config.agent ?? 'pi-coding-agent',
    workspace: config.workspace,
    skills,
    profile: config.profile ?? 'balanced',
    sandboxType: config.sandboxType ?? 'docker',
    taintRatio: config.taintRatio ?? 0,
    taintThreshold: config.taintThreshold ?? 1,
    identityFiles,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    historyTokens: config.history?.length ? Math.ceil(JSON.stringify(config.history).length / 4) : 0,
    replyOptional: config.replyOptional ?? false,
    // Enterprise fields
    agentId: config.agentId,
    hasGovernance,
    hasWorkspace: !!config.workspace,
    catalog: config.catalog,
  });

  const toolFilter: ToolFilterContext = {
    hasHeartbeat: !!identityFiles.heartbeat?.trim(),
    // Tool-dispatch mode comes from host Config via the stdin payload.
    // Default to `indirect` when absent so older hosts / inline-built configs
    // still expose describe_tools + call_tool.
    toolDispatchMode: config.tool_dispatch?.mode ?? 'indirect',
  };

  // Catalog visibility — helps diagnose "agent thrashed on tool names"
  // bugs. If catalogSize is 0 but the session had active MCP skills, host
  // discovery likely failed silently. If catalogSize > 0 but the agent
  // still guessed names, the tool-catalog prompt module probably got
  // budget-dropped — cross-reference `modules` in the metadata below.
  const catalog = config.catalog ?? [];
  const catalogBySkill: Record<string, number> = {};
  for (const t of catalog) catalogBySkill[t.skill] = (catalogBySkill[t.skill] ?? 0) + 1;
  logger.info('agent_catalog_received', {
    agentId: config.agentId,
    catalogSize: catalog.length,
    catalogBySkill,
    toolCatalogModuleIncluded: promptResult.metadata.modules.includes('tool-catalog'),
  });

  logger.debug('prompt_built', { ...promptResult.metadata, toolFilter });

  return {
    systemPrompt: promptResult.content,
    metadata: { ...promptResult.metadata },
    toolFilter,
  };
}

/**
 * Subscribe to pi-ai agent events — streams text to stdout (or buffers it
 * for HTTP IPC mode), logs tools and errors to stderr. Returns a state object
 * for tracking output and retrieving buffered content.
 *
 * Works with pi-coding-agent AgentSession.subscribe() event shape.
 *
 * @param opts.buffer - When provided, text is appended to this array instead
 *   of writing to stdout. Used in HTTP IPC mode where the response is sent via
 *   IPC agent_response instead of stdout.
 */
export function subscribeAgentEvents(
  subscribable: { subscribe(fn: (event: any) => void): void },
  config: { verbose?: boolean },
  opts?: { buffer?: string[] },
): { hasOutput: () => boolean; eventCount: () => number; getBuffered: () => string } {
  let hasOutput = false;
  let eventCount = 0;
  let turnCount = 0;
  const buffer = opts?.buffer;

  subscribable.subscribe((event: any) => {
    eventCount++;
    if (event.type === 'message_update') {
      const ame = event.assistantMessageEvent;
      logger.debug('agent_event', { type: ame.type, eventCount });

      if (ame.type === 'text_start' && hasOutput) {
        if (buffer) {
          buffer.push('\n\n');
        } else {
          process.stdout.write('\n\n');
        }
      }
      if (ame.type === 'text_delta') {
        if (buffer) {
          buffer.push(ame.delta);
        } else {
          process.stdout.write(ame.delta);
        }
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
        // Also surface the error in the response
        if (!hasOutput) {
          if (buffer) {
            buffer.push(errText);
          } else {
            process.stdout.write(errText);
          }
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
    getBuffered: () => buffer ? buffer.join('') : '',
  };
}
