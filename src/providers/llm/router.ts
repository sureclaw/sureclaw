/**
 * LLM Router — dispatches chat() calls across task-type model chains.
 *
 * Reads the `models` map from config (keyed by task type: default, fast,
 * thinking, coding). Each task type has its own fallback chain of compound
 * `provider/model` IDs. On each chat() call, the router resolves the
 * request's `taskType` to the appropriate chain, falling back to 'default'
 * when the requested type has no models configured.
 *
 * Loads one child LLMProvider per unique provider name across all task types,
 * and runs a fallback loop with per-provider cooldowns.
 *
 * Active for all IPC-based agents. The `claude-code` agent is excluded —
 * it uses Anthropic directly via the credential-injecting proxy.
 */

import { resolveProviderPath } from '../../host/provider-map.js';
import type { LLMProvider, ChatRequest, ChatChunk } from './types.js';
import type { Config, LLMTaskType } from '../../types.js';
import { LLM_TASK_TYPES } from '../../types.js';
import { getLogger } from '../../logger.js';

const logger = getLogger().child({ component: 'llm-router' });

// ───────────────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────────────

interface ModelCandidate {
  provider: string;
  model: string;
}

interface CooldownState {
  until: number;
  consecutive: number;
}

// ───────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────

const INITIAL_COOLDOWN_MS = 30_000;
const MAX_COOLDOWN_MS = 5 * 60 * 1000;

/** Split a compound `provider/model` ID on the first `/`. */
export function parseCompoundId(id: string): ModelCandidate {
  const slashIdx = id.indexOf('/');
  if (slashIdx < 0) {
    throw new Error(
      `Invalid model ID "${id}": must be a compound provider/model ID (e.g. "openrouter/gpt-4.1")`,
    );
  }
  return {
    provider: id.slice(0, slashIdx),
    model: id.slice(slashIdx + 1),
  };
}

/** Classify an error as retryable or permanent. */
function isRetryable(err: unknown): boolean {
  if (!(err instanceof Error)) return true; // unknown errors default to retryable

  const msg = err.message.toLowerCase();

  // Permanent: auth, bad request, not found
  if (msg.includes('401') || msg.includes('403') || msg.includes('unauthorized') || msg.includes('forbidden')) return false;
  if (msg.includes('400') || msg.includes('bad request')) return false;
  if (msg.includes('404') || msg.includes('not found') || msg.includes('model not found')) return false;
  if (msg.includes('invalid') && msg.includes('api key')) return false;

  // Retryable: rate limit, server error, timeout, connection
  // (and anything we don't recognize)
  return true;
}

// ───────────────────────────────────────────────────────
// Provider factory
// ───────────────────────────────────────────────────────

export async function create(config: Config): Promise<LLMProvider> {
  if (!config.models || !config.models.default || config.models.default.length === 0) {
    throw new Error('config.models.default is required for LLM router (array of compound provider/model IDs)');
  }

  // Build per-task-type candidate chains (LLM types only, excluding 'image')
  const taskChains = new Map<LLMTaskType, ModelCandidate[]>();
  for (const taskType of LLM_TASK_TYPES) {
    const ids = config.models[taskType];
    if (ids && ids.length > 0) {
      taskChains.set(taskType, ids.map(parseCompoundId));
    }
  }

  // 'default' is guaranteed to exist by the check above
  const defaultCandidates = taskChains.get('default')!;

  logger.info('init', {
    taskTypes: [...taskChains.keys()],
    defaultModels: config.models.default,
    totalChains: taskChains.size,
  });

  // Deduplicate provider names across ALL task types and load one child LLMProvider per unique name.
  const allCandidates = [...taskChains.values()].flat();
  const uniqueProviders = [...new Set(allCandidates.map(c => c.provider))];
  const childProviders = new Map<string, LLMProvider>();

  for (const providerName of uniqueProviders) {
    const modulePath = resolveProviderPath('llm', providerName);
    const mod = await import(modulePath);
    if (typeof mod.create !== 'function') {
      throw new Error(`LLM provider "${providerName}" does not export a create() function`);
    }
    const child: LLMProvider = await mod.create(config, providerName);
    childProviders.set(providerName, child);
    logger.debug('child_loaded', { provider: providerName });
  }

  // Per-provider cooldown state (in-memory, resets on restart)
  const cooldowns = new Map<string, CooldownState>();

  function isCooledDown(providerName: string, now: number): boolean {
    const state = cooldowns.get(providerName);
    return !!state && now < state.until;
  }

  function applyCooldown(providerName: string, now: number): void {
    const existing = cooldowns.get(providerName);
    const consecutive = (existing?.consecutive ?? 0) + 1;
    const duration = Math.min(INITIAL_COOLDOWN_MS * Math.pow(2, consecutive - 1), MAX_COOLDOWN_MS);
    cooldowns.set(providerName, { until: now + duration, consecutive });
    logger.debug('cooldown_applied', { provider: providerName, durationMs: duration, consecutive });
  }

  function resetCooldown(providerName: string): void {
    if (cooldowns.has(providerName)) {
      cooldowns.delete(providerName);
      logger.debug('cooldown_reset', { provider: providerName });
    }
  }

  /** Resolve a task type to its candidate chain, falling back to 'default'. */
  function resolveCandidates(taskType?: LLMTaskType): ModelCandidate[] {
    if (taskType && taskChains.has(taskType)) {
      return taskChains.get(taskType)!;
    }
    return defaultCandidates;
  }

  // Compose a display name for the router
  const routerName = `router(${defaultCandidates.map(c => `${c.provider}/${c.model}`).join(', ')})`;

  return {
    name: routerName,

    async *chat(req: ChatRequest): AsyncIterable<ChatChunk> {
      const candidates = resolveCandidates(req.taskType);
      let lastError: Error | undefined;

      logger.debug('chat_dispatch', {
        taskType: req.taskType ?? 'default',
        candidateCount: candidates.length,
        candidates: candidates.map(c => `${c.provider}/${c.model}`),
      });

      for (const candidate of candidates) {
        const now = Date.now();

        // Skip cooled-down providers
        if (isCooledDown(candidate.provider, now)) {
          const state = cooldowns.get(candidate.provider)!;
          logger.debug('skip_cooled_down', {
            provider: candidate.provider,
            model: candidate.model,
            cooldownRemainingMs: state.until - now,
          });
          continue;
        }

        logger.debug('trying', { provider: candidate.provider, model: candidate.model });

        try {
          const child = childProviders.get(candidate.provider)!;
          const childReq: ChatRequest = { ...req, model: candidate.model };

          yield* child.chat(childReq);

          // Success — reset cooldown and return
          resetCooldown(candidate.provider);
          logger.debug('succeeded', { provider: candidate.provider, model: candidate.model });
          return;
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
          const retryable = isRetryable(err);

          logger.info('failed', {
            provider: candidate.provider,
            model: candidate.model,
            error: lastError.message,
            retryable,
          });

          if (retryable) {
            applyCooldown(candidate.provider, Date.now());
          }
          // Both retryable and permanent: skip to next candidate
        }
      }

      // All candidates exhausted
      throw lastError ?? new Error('LLM router: all candidates exhausted');
    },

    async models(): Promise<string[]> {
      // Aggregate models from all child providers
      const allModels: string[] = [];
      for (const [providerName, child] of childProviders) {
        const models = await child.models();
        allModels.push(...models.map(m => `${providerName}/${m}`));
      }
      return allModels;
    },
  };
}
