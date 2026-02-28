/**
 * Shared utilities for router providers (LLM router, image router).
 *
 * Extracted to avoid cross-provider imports — image/router.ts was importing
 * parseCompoundId from llm/router.ts, creating a dependency between provider
 * categories that would block independent package extraction.
 */

export interface ModelCandidate {
  provider: string;
  model: string;
}

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
