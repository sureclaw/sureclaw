// src/providers/memory/memoryfs/prompts.ts — LLM prompt templates for category summary generation.
// Adapted from memU's category_summary/category.py and category_with_refs.py.
// Pure string manipulation, no I/O.

// -- Summary generation (no refs) --

export function buildSummaryPrompt(params: {
  category: string;
  originalContent: string;
  newItems: string[];
  targetLength: number;
}): string {
  const { category, originalContent, newItems, targetLength } = params;
  const newItemsText = newItems.map(i => `- ${i}`).join('\n');

  return [
    '# Task Objective',
    'You are a User Profile Synchronization Specialist. Merge newly extracted user information items into the existing profile using add and update operations.',
    'No deletion -- only implicit replacement through newer items. Output the updated, complete profile.',
    '',
    '# Workflow',
    '1. Parse the original content: extract categories, preserve wording style and format.',
    '2. Parse new items: mark each as Add or Update. Distinguish stable facts from one-off events.',
    '3. Update: replace outdated entries with newer ones. Add: deduplicate, then insert into correct category.',
    `4. Summarize to target length of ${targetLength} tokens. Use markdown hierarchy. Cluster items by sub-topic.`,
    '5. Output only the updated markdown profile. No explanations, no meta text.',
    '',
    '# Output Format',
    `# ${category}`,
    '## <sub-topic>',
    '- User information item',
    '- User information item',
    '## <sub-topic>',
    '- User information item',
    '',
    'IMPORTANT: Output ONLY the raw markdown profile. Do NOT wrap in code fences (no ```markdown blocks).',
    `Critical: Do not exceed ${targetLength} tokens. Merge or omit unimportant information to meet this limit.`,
    '',
    '# Input',
    'Topic:',
    category,
    '',
    'Original content:',
    '<content>',
    originalContent || '(empty -- this is a new category)',
    '</content>',
    '',
    'New memory items:',
    '<item>',
    newItemsText,
    '</item>',
  ].join('\n');
}

// -- Summary generation (with refs) --

export function buildSummaryPromptWithRefs(params: {
  category: string;
  originalContent: string;
  newItemsWithIds: Array<{ refId: string; content: string }>;
  targetLength: number;
}): string {
  const { category, originalContent, newItemsWithIds, targetLength } = params;
  const newItemsText = newItemsWithIds.map(i => `- [${i.refId}] ${i.content}`).join('\n');

  return [
    '# Task Objective',
    'You are a User Profile Synchronization Specialist. Merge newly extracted user information items into the existing profile.',
    'IMPORTANT: Include inline references using [ref:ITEM_ID] format when incorporating information from provided items.',
    '',
    '# Reference Rules',
    '1. Every piece of information from new memory items MUST have a [ref:ITEM_ID] citation',
    '2. Use the exact item ID provided in the input',
    '3. Place references immediately after the relevant statement',
    '4. Multiple sources can be cited: [ref:id1,id2]',
    '5. Existing information without new updates does not need references',
    '',
    '# Workflow',
    '1. Parse original content and new items (note each item\'s ID for [ref:ID] citations).',
    '2. Update existing info with refs. Add new info with refs.',
    `3. Summarize to ${targetLength} tokens. PRESERVE all [ref:ITEM_ID] citations.`,
    '4. Output only the updated markdown profile with inline references.',
    '',
    '# Output Format',
    `# ${category}`,
    '## <sub-topic>',
    '- User information item [ref:ITEM_ID]',
    '- User information item [ref:ITEM_ID,ITEM_ID2]',
    '',
    'IMPORTANT: Output ONLY the raw markdown profile. Do NOT wrap in code fences (no ```markdown blocks).',
    `Critical: Do not exceed ${targetLength} tokens. Always include [ref:ITEM_ID] for new items.`,
    '',
    '# Input',
    'Topic:',
    category,
    '',
    'Original content:',
    '<content>',
    originalContent || '(empty -- this is a new category)',
    '</content>',
    '',
    'New memory items with IDs:',
    '<items>',
    newItemsText,
    '</items>',
  ].join('\n');
}

// -- Category patch (incremental CRUD update) --

export function buildPatchPrompt(params: {
  category: string;
  originalContent: string;
  updateContent: string;
}): string {
  const { category, originalContent, updateContent } = params;

  return [
    '# Task Objective',
    'Read an existing user profile and an update, then determine whether the profile needs updating.',
    'If yes, generate the updated profile. If no, indicate that no update is needed.',
    '',
    '# Response Format (JSON):',
    '{"need_update": true/false, "updated_content": "the updated markdown if needed, otherwise empty"}',
    '',
    '# Input',
    'Topic:',
    category,
    '',
    'Original content:',
    '<content>',
    originalContent,
    '</content>',
    '',
    'Update:',
    updateContent,
  ].join('\n');
}

/**
 * Strip markdown code fences that LLMs sometimes wrap output in,
 * e.g. ```markdown\n...\n``` or ```\n...\n```
 */
export function stripCodeFences(text: string): string {
  return text
    .replace(/^```(?:markdown|md)?\s*\n/i, '')
    .replace(/\n```\s*$/, '')
    .trim();
}

export interface PatchResult {
  needUpdate: boolean;
  updatedContent: string;
}

export function parsePatchResponse(response: string): PatchResult {
  try {
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { needUpdate: false, updatedContent: '' };
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      needUpdate: Boolean(parsed.need_update),
      updatedContent: String(parsed.updated_content || ''),
    };
  } catch {
    return { needUpdate: false, updatedContent: '' };
  }
}
