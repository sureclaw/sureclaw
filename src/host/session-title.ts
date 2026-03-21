/**
 * Auto-generate session titles from the first user message
 * using the fast LLM model.
 */

import { getLogger } from '../logger.js';

const logger = getLogger().child({ component: 'session-title' });

export interface TitleLLM {
  complete(prompt: string): Promise<string>;
}

/**
 * Generate a short (3-5 word) title for a chat session from the first user message.
 * Falls back to truncating the message if the LLM call fails.
 */
export async function generateSessionTitle(userMessage: string, llm: TitleLLM): Promise<string> {
  try {
    const prompt = `Summarize this user message as a 3-5 word conversation title. Reply with only the title, no quotes or punctuation at the end.\n\nUser message: ${userMessage}`;
    const title = await llm.complete(prompt);
    // Clean up: remove quotes, trim, limit length
    const cleaned = title.replace(/^["']|["']$/g, '').trim();
    return cleaned.length > 50 ? cleaned.substring(0, 47) + '...' : cleaned;
  } catch (err) {
    logger.warn('title_generation_failed', { error: (err as Error).message });
    // Fallback: truncate the user message
    const text = userMessage.trim();
    return text.length <= 50 ? text : text.substring(0, 47) + '...';
  }
}
