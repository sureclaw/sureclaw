// src/providers/memory/cortex/extractor.ts — Memory extraction via LLM
import type { ConversationTurn } from '../types.js';
import type { LLMProvider } from '../../llm/types.js';
import type { CortexItem, MemoryType } from './types.js';
import { MEMORY_TYPES } from './types.js';
import { computeContentHash } from './content-hash.js';
import { llmComplete } from './llm-helpers.js';

const MAX_ITEMS_PER_CONVERSATION = 20;

const VALID_CATEGORIES = new Set([
  'personal_info', 'preferences', 'relationships', 'activities', 'goals',
  'experiences', 'knowledge', 'opinions', 'habits', 'work_life',
]);

const EXTRACTION_PROMPT = `Extract discrete facts, preferences, and action items from this conversation that should be remembered about the user. For each item:
- content: A short canonical statement using the SIMPLEST possible wording. Use "Subject verb object" form. Strip filler words, qualifiers, and synonyms. The SAME fact must ALWAYS produce the SAME wording regardless of how the user phrased it.
  Examples of canonical form:
  - "Prefers dark mode" (not "Likes to use dark mode in editors" or "Prefers using dark mode in all code editors")
  - "Uses TypeScript for all projects" (not "The user uses TypeScript for all of their projects")
  - "Runs tests before committing" (not "Always runs the test suite before making a commit")
- memoryType: one of profile, event, knowledge, behavior, skill, tool
- category: one of personal_info, preferences, relationships, activities, goals, experiences, knowledge, opinions, habits, work_life
- actionable: (optional) true ONLY if this item implies something the user needs to do, be reminded about, or follow up on
- hintKind: (required if actionable is true) one of pending_task, follow_up, temporal_pattern

Only extract information the user explicitly states or clearly implies. Do not infer or speculate.

Respond with ONLY a JSON array: [{"content": "...", "memoryType": "...", "category": "...", "actionable": true, "hintKind": "..."}]
If nothing worth remembering, respond with: []`;

const VALID_HINT_KINDS = new Set(['pending_task', 'follow_up', 'temporal_pattern']);

/**
 * Extract memory items from conversation using an LLM.
 * Throws if the LLM call fails or returns unparseable output.
 */
export async function extractByLLM(
  conversation: ConversationTurn[],
  scope: string,
  llm: LLMProvider,
  model?: string,
): Promise<(Omit<CortexItem, 'id'> & { actionable?: true; hintKind?: string })[]> {
  const conversationText = conversation
    .map(t => `${t.role}: ${t.content}`)
    .join('\n');

  const prompt = `${EXTRACTION_PROMPT}\n\nConversation:\n${conversationText}`;

  const raw = await llmComplete(llm, prompt, { model, maxTokens: 2000 });

  // Extract JSON array from response (handle markdown fences)
  const jsonMatch = raw.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    throw new Error('LLM extraction returned no JSON array');
  }

  const parsed: unknown = JSON.parse(jsonMatch[0]);
  if (!Array.isArray(parsed)) {
    throw new Error('LLM extraction response is not an array');
  }

  const now = new Date().toISOString();
  const validTypes = new Set<string>(MEMORY_TYPES);

  return parsed
    .filter((item): item is { content: string; memoryType: string; category: string } =>
      typeof item === 'object' && item !== null &&
      typeof (item as any).content === 'string' &&
      typeof (item as any).memoryType === 'string' &&
      typeof (item as any).category === 'string',
    )
    .slice(0, MAX_ITEMS_PER_CONVERSATION)
    .map(item => {
      const memoryType = validTypes.has(item.memoryType)
        ? item.memoryType as MemoryType
        : 'knowledge' as MemoryType;
      const category = VALID_CATEGORIES.has(item.category)
        ? item.category
        : defaultCategoryForType(memoryType);

      const actionable = (item as any).actionable === true ? true : undefined;
      const hintKind = actionable && VALID_HINT_KINDS.has((item as any).hintKind)
        ? (item as any).hintKind as string
        : undefined;

      return {
        content: item.content,
        memoryType,
        category,
        contentHash: computeContentHash(item.content),
        confidence: 0.85,
        reinforcementCount: 1,
        lastReinforcedAt: now,
        createdAt: now,
        updatedAt: now,
        scope,
        ...(actionable ? { actionable } : {}),
        ...(hintKind ? { hintKind } : {}),
      };
    });
}

/** Default category mapping by memory type. */
function defaultCategoryForType(memoryType: MemoryType): string {
  switch (memoryType) {
    case 'profile': return 'personal_info';
    case 'event': return 'experiences';
    case 'knowledge': return 'knowledge';
    case 'behavior': return 'habits';
    case 'skill': return 'knowledge';
    case 'tool': return 'work_life';
  }
}
