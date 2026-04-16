/**
 * Shared agent setup — identity loading, prompt building, event subscription.
 *
 * Deduplicates logic shared between pi-session.ts and claude-code.ts runners.
 */

import { getLogger } from '../logger.js';
import { PromptBuilder } from './prompt/builder.js';
import { loadIdentityFiles } from './identity-loader.js';
import { loadSkillsMultiDir } from './stream-utils.js';
import { detectSkillInstallIntent } from './prompt/modules/skills.js';
import { join, resolve } from 'node:path';
import { existsSync, readdirSync, statSync, accessSync, constants } from 'node:fs';
import type { AgentConfig } from './runner.js';
import type { ToolFilterContext } from './tool-catalog.js';

const logger = getLogger().child({ component: 'agent-setup' });

const DEFAULT_CONTEXT_WINDOW = 200000;

/** Scan workspace/bin/ for MCP CLI executables. */
function scanMcpCLIs(workspace: string): string[] | undefined {
  if (!workspace) return undefined;
  const binDir = resolve(workspace, 'bin');
  if (!existsSync(binDir)) return undefined;
  try {
    const entries = readdirSync(binDir).filter(f => {
      try {
        const p = join(binDir, f);
        return statSync(p).isFile() && (accessSync(p, constants.X_OK), true);
      } catch { return false; }
    });
    return entries.length > 0 ? entries : undefined;
  } catch { return undefined; }
}

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
  // Load skills from .ax/skills/ in the git workspace.
  const skillDirs: Array<{ dir: string; scope: 'agent' | 'user' }> = [
    { dir: join(config.workspace, '.ax', 'skills'), scope: 'agent' as const },
  ];
  const skills = loadSkillsMultiDir(skillDirs);

  // Identity is pre-loaded from host (via stdin payload from committed git state).
  const identityFiles = loadIdentityFiles(config.identity);

  const hasGovernance = false; // Governance removed — identity changes are validated at git commit time

  // Detect skill install intent from user message
  let skillInstallEnabled = false;
  if (config.userMessage) {
    const msgText = typeof config.userMessage === 'string'
      ? config.userMessage
      : config.userMessage.filter(b => b.type === 'text').map(b => (b as { type: 'text'; text: string }).text).join(' ');
    skillInstallEnabled = detectSkillInstallIntent(msgText);
  }

  const mcpCLIs = scanMcpCLIs(config.workspace);

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
    mcpCLIs,
    skillInstallEnabled,
  });

  const toolFilter: ToolFilterContext = {
    hasHeartbeat: !!identityFiles.heartbeat?.trim(),
    skillInstallEnabled,
  };

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
