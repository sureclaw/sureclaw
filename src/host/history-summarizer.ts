/**
 * History summarizer — compresses old conversation turns into concise summaries
 * and persists them back into the ConversationStore. This enables effectively
 * infinite-length conversations by recursively summarizing older context.
 *
 * Runs on the host side (trusted process) with direct LLM access.
 */

import type { ConversationStore, StoredTurn } from '../conversation-store.js';
import { deserializeContent } from '../conversation-store.js';
import type { LLMProvider, ChatChunk } from '../providers/llm/types.js';
import type { Logger } from '../logger.js';

export interface SummarizationConfig {
  /** Enable persistent summarization (default: false). */
  enabled: boolean;
  /** Summarize when turn count exceeds this threshold (default: 40). */
  threshold: number;
  /** Number of recent turns to keep verbatim (default: 10). */
  keepRecent: number;
}

export const SUMMARIZATION_DEFAULTS: SummarizationConfig = {
  enabled: false,
  threshold: 40,
  keepRecent: 10,
};

/**
 * Extract plain text from stored turn content (which may be JSON ContentBlock[]).
 */
function turnToText(turn: StoredTurn): string {
  const content = deserializeContent(turn.content);
  if (typeof content === 'string') return content;
  return content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map(b => b.text)
    .join('\n');
}

/**
 * Build the transcript string from turns for the summarizer LLM call.
 */
function buildTranscript(turns: StoredTurn[]): string {
  return turns.map(t => {
    const prefix = t.role === 'user'
      ? (t.sender ? `User [${t.sender}]` : 'User')
      : 'Assistant';
    const text = turnToText(t);
    // Mark summary turns so the LLM knows this is already compressed context
    const tag = t.is_summary ? ' (previously summarized)' : '';
    return `${prefix}${tag}: ${text}`;
  }).join('\n\n');
}

/**
 * Call the LLM to summarize a conversation transcript.
 * Uses the 'fast' task type for cost efficiency.
 */
async function callSummarizeLLM(
  llm: LLMProvider,
  transcript: string,
  turnCount: number,
): Promise<string | null> {
  const systemPrompt =
    'You are a conversation summarizer. Your job is to compress conversation ' +
    'history into a concise summary that preserves all important context. ' +
    'Be concise but thorough — the summary replaces the original messages.';

  const userPrompt =
    `Summarize the following ${turnCount} conversation turns. Preserve:\n` +
    '- Key decisions and their rationale\n' +
    '- Code references, file paths, and technical details\n' +
    '- Action items and their status\n' +
    '- User preferences and corrections\n' +
    '- Any errors encountered and how they were resolved\n\n' +
    'Format as a structured summary with clear sections. Be concise.\n\n' +
    '---\n' + transcript + '\n---';

  const chunks: string[] = [];
  const stream = llm.chat({
    model: '', // empty = let router pick
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    maxTokens: 2048,
    taskType: 'fast',
  });

  for await (const chunk of stream) {
    if (chunk.type === 'text' && chunk.content) {
      chunks.push(chunk.content);
    }
  }

  const result = chunks.join('');
  return result.trim() || null;
}

/**
 * Check whether a session needs summarization and perform it if so.
 *
 * Returns true if summarization was performed, false otherwise.
 */
export async function maybeSummarizeHistory(
  sessionId: string,
  conversationStore: ConversationStore,
  llm: LLMProvider,
  config: SummarizationConfig,
  logger: Logger,
): Promise<boolean> {
  if (!config.enabled) return false;

  const totalTurns = conversationStore.count(sessionId);
  if (totalTurns <= config.threshold) return false;

  // Load turns that are candidates for summarization (everything except recent)
  const olderTurns = conversationStore.loadOlderTurns(sessionId, config.keepRecent);
  if (olderTurns.length < 4) return false; // not worth summarizing < 4 turns

  logger.info('history_summarize_start', {
    sessionId,
    totalTurns,
    turnsToSummarize: olderTurns.length,
    keepRecent: config.keepRecent,
  });

  const transcript = buildTranscript(olderTurns);
  const maxId = olderTurns[olderTurns.length - 1].id;

  try {
    const summary = await callSummarizeLLM(llm, transcript, olderTurns.length);

    if (!summary) {
      logger.warn('history_summarize_empty', { sessionId });
      return false;
    }

    const summaryContent =
      `[Conversation summary of ${olderTurns.length} earlier messages]\n\n${summary}`;

    conversationStore.replaceTurnsWithSummary(sessionId, maxId, summaryContent);

    logger.info('history_summarize_done', {
      sessionId,
      summarizedTurns: olderTurns.length,
      summaryLength: summary.length,
      remainingTurns: conversationStore.count(sessionId),
    });

    return true;
  } catch (err) {
    logger.warn('history_summarize_failed', {
      sessionId,
      error: (err as Error).message,
    });
    return false;
  }
}
