/**
 * Shared utilities for pi-ai message conversion and stream event emission.
 * Used by runner.ts, pi-session.ts, and ipc-transport.ts to eliminate
 * duplicated conversion logic across IPC and proxy LLM transports.
 */

import type { ContentBlock } from '../types.js';
import type { TextContent, ToolCall, AssistantMessage } from '@mariozechner/pi-ai';

/** Cap tool result content to avoid blowing up the LLM context window. */
const MAX_TOOL_RESULT_CHARS = 200_000;

// ── Message types ────────────────────────────────────────────────────

/** Converted message in IPC/Anthropic API format. */
export interface ConvertedMessage {
  role: string;
  content: string | Array<{ type: string; [k: string]: unknown }>;
}

/** Minimal stream interface — matches pi-ai's AssistantMessageEventStream.push() */
interface PushableStream {
  push(event: Record<string, unknown>): void;
}

// ── Message conversion ───────────────────────────────────────────────

/**
 * Convert pi-ai messages to IPC / Anthropic API format.
 * Handles user, assistant, toolResult roles. Empty content gets safe fallbacks
 * (Anthropic API rejects empty content).
 *
 * The output is plain objects compatible with both AX's IPC protocol and
 * the Anthropic SDK's MessageParam[] (callers can cast as needed).
 */
export function convertPiMessages(messages: readonly any[]): ConvertedMessage[] {
  return messages.map((m): ConvertedMessage => {
    if (m.role === 'user') {
      const content = typeof m.content === 'string'
        ? m.content
        : m.content.filter((c: any): c is TextContent => c.type === 'text').map((c: any) => c.text).join('');
      return { role: 'user', content: content || '.' };
    }
    if (m.role === 'assistant') {
      const blocks: Array<{ type: string; [k: string]: unknown }> = [];
      for (const c of m.content) {
        if (c.type === 'text') {
          blocks.push({ type: 'text', text: c.text });
        } else if (c.type === 'toolCall') {
          blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.arguments });
        }
      }
      if (blocks.length === 0) {
        return { role: 'assistant', content: '.' };
      }
      if (blocks.every(b => b.type === 'text')) {
        const text = blocks.map(b => b.text).join('');
        return { role: 'assistant', content: text || '.' };
      }
      return { role: 'assistant', content: blocks };
    }
    if (m.role === 'toolResult') {
      let text = m.content
        .filter((c: any): c is TextContent => c.type === 'text')
        .map((c: any) => c.text)
        .join('');
      if (text.length > MAX_TOOL_RESULT_CHARS) {
        text = text.slice(0, MAX_TOOL_RESULT_CHARS) + `\n\n[truncated — ${text.length} chars total]`;
      }
      return {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: m.toolCallId, content: text || '[no output]' }],
      };
    }
    return { role: 'user', content: '.' };
  });
}

// ── File block injection ─────────────────────────────────────────────

/**
 * Inject content blocks (file_data, document, etc.) into the last plain user message
 * in a converted message array. This makes inline file content visible to the LLM.
 * Skips tool_result messages — only targets the actual user prompt message.
 * Accepts any block-like objects (internal file_data or Anthropic document blocks).
 */
export function injectFileBlocks(messages: ConvertedMessage[], fileBlocks: Array<{ type: string; [k: string]: unknown }>): void {
  if (fileBlocks.length === 0) return;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    // Skip tool_result messages (array content starting with tool_result block)
    if (Array.isArray(m.content) && (m.content as any[])[0]?.type === 'tool_result') continue;
    // Convert existing string content to array form so we can append blocks
    const existing: Array<{ type: string; [k: string]: unknown }> = typeof m.content === 'string'
      ? [{ type: 'text', text: m.content }]
      : [...(m.content as Array<{ type: string; [k: string]: unknown }>)];
    messages[i] = {
      ...m,
      content: [...existing, ...fileBlocks.map(b => ({ ...b }))],
    };
    return;
  }
}

// ── Stream event emission ────────────────────────────────────────────

/**
 * Emit standard pi-ai stream events (start, text_*, toolcall_*, done)
 * from a completed assistant message. Used by both IPC and proxy stream
 * functions to avoid duplicating the event sequence logic.
 */
export function emitStreamEvents(
  stream: PushableStream,
  msg: AssistantMessage,
  fullText: string,
  toolCalls: ToolCall[],
  stopReason: 'stop' | 'toolUse',
): void {
  stream.push({ type: 'start', partial: msg });

  if (fullText) {
    stream.push({ type: 'text_start', contentIndex: 0, partial: msg });
    stream.push({ type: 'text_delta', contentIndex: 0, delta: fullText, partial: msg });
    stream.push({ type: 'text_end', contentIndex: 0, content: fullText, partial: msg });
  }

  for (let i = 0; i < toolCalls.length; i++) {
    const idx = fullText ? i + 1 : i;
    stream.push({ type: 'toolcall_start', contentIndex: idx, partial: msg });
    stream.push({ type: 'toolcall_delta', contentIndex: idx, delta: JSON.stringify(toolCalls[i].arguments), partial: msg });
    stream.push({ type: 'toolcall_end', contentIndex: idx, toolCall: toolCalls[i], partial: msg });
  }

  stream.push({ type: 'done', reason: stopReason, message: msg });
}

// ── Socket / Anthropic client helpers ────────────────────────────────

/**
 * Create a fetch function that routes through a Unix socket via undici.
 */
export async function createSocketFetch(socketPath: string): Promise<typeof globalThis.fetch> {
  const { Agent } = await import('undici');
  const dispatcher = new Agent({ connect: { socketPath } });
  return ((input: string | URL | Request, init?: RequestInit) =>
    fetch(input, { ...init, dispatcher } as RequestInit)) as typeof globalThis.fetch;
}

/**
 * Create a lazy Anthropic SDK client that connects through a Unix socket proxy.
 * Returns a getter function; the client is created on first call and cached.
 */
export function createLazyAnthropicClient(proxySocket: string): () => Promise<any> {
  let promise: Promise<any> | null = null;
  return () => {
    if (!promise) {
      promise = (async () => {
        const [socketFetch, { default: AnthropicSDK }] = await Promise.all([
          createSocketFetch(proxySocket),
          import('@anthropic-ai/sdk'),
        ]);
        return new AnthropicSDK({
          apiKey: 'ax-proxy',
          baseURL: 'http://localhost',
          fetch: socketFetch,
        });
      })();
    }
    return promise;
  };
}

