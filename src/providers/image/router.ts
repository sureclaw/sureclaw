/**
 * Image Router — dispatches generate() calls across primary + fallback image models.
 *
 * Mirrors the LLM router pattern: parses compound `provider/model` IDs from
 * config.models.image, loads one child ImageProvider per unique provider name,
 * and runs a fallback loop with per-provider cooldowns.
 */

import { resolveProviderPath } from '../../host/provider-map.js';
import { parseCompoundId } from '../llm/router.js';
import type { ImageProvider, ImageGenerateRequest, ImageGenerateResult } from './types.js';
import type { Config } from '../../types.js';
import { getLogger } from '../../logger.js';

const logger = getLogger().child({ component: 'image-router' });

const INITIAL_COOLDOWN_MS = 30_000;
const MAX_COOLDOWN_MS = 5 * 60 * 1000;

interface CooldownState {
  until: number;
  consecutive: number;
}

/** Classify an error as retryable or permanent. */
function isRetryable(err: unknown): boolean {
  if (!(err instanceof Error)) return true;

  const msg = err.message.toLowerCase();
  if (msg.includes('401') || msg.includes('403') || msg.includes('unauthorized') || msg.includes('forbidden')) return false;
  if (msg.includes('400') || msg.includes('bad request')) return false;
  if (msg.includes('404') || msg.includes('not found') || msg.includes('model not found')) return false;
  if (msg.includes('invalid') && msg.includes('api key')) return false;

  return true;
}

export async function create(config: Config): Promise<ImageProvider> {
  if (!config.models?.image || config.models.image.length === 0) {
    throw new Error('config.models.image is required for image router (array of compound provider/model IDs)');
  }

  const candidates = config.models.image.map(parseCompoundId);

  logger.info('init', {
    image_models: config.models.image,
    candidateCount: candidates.length,
  });

  // Deduplicate provider names and load one child ImageProvider per unique name.
  const uniqueProviders = [...new Set(candidates.map(c => c.provider))];
  const childProviders = new Map<string, ImageProvider>();

  for (const providerName of uniqueProviders) {
    const modulePath = resolveProviderPath('image', providerName);
    const mod = await import(modulePath);
    if (typeof mod.create !== 'function') {
      throw new Error(`Image provider "${providerName}" does not export a create() function`);
    }
    const child: ImageProvider = await mod.create(config, providerName);
    childProviders.set(providerName, child);
    logger.debug('child_loaded', { provider: providerName });
  }

  // Per-provider cooldown state
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

  const routerName = `image-router(${candidates.map(c => `${c.provider}/${c.model}`).join(', ')})`;

  return {
    name: routerName,

    async generate(req: ImageGenerateRequest): Promise<ImageGenerateResult> {
      let lastError: Error | undefined;

      for (const candidate of candidates) {
        const now = Date.now();

        if (isCooledDown(candidate.provider, now)) {
          logger.debug('skip_cooled_down', { provider: candidate.provider, model: candidate.model });
          continue;
        }

        logger.debug('trying', { provider: candidate.provider, model: candidate.model });

        try {
          const child = childProviders.get(candidate.provider)!;
          const childReq: ImageGenerateRequest = { ...req, model: candidate.model };
          const result = await child.generate(childReq);

          resetCooldown(candidate.provider);
          logger.debug('succeeded', { provider: candidate.provider, model: candidate.model });
          return result;
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
        }
      }

      throw lastError ?? new Error('Image router: all candidates exhausted');
    },

    async models(): Promise<string[]> {
      const allModels: string[] = [];
      for (const [providerName, child] of childProviders) {
        const models = await child.models();
        allModels.push(...models.map(m => `${providerName}/${m}`));
      }
      return allModels;
    },
  };
}
