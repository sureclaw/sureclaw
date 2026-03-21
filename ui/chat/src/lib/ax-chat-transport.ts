/**
 * Custom ChatTransport that speaks OpenAI SSE format to the AX backend.
 *
 * The AX server returns standard OpenAI-compatible streaming SSE:
 *   data: {"choices":[{"delta":{"content":"..."}}]}
 *   data: [DONE]
 *
 * The AI SDK's DefaultChatTransport expects its own JSON event stream format,
 * so we override processResponseStream to parse OpenAI SSE instead.
 *
 * Session identity: the server derives a deterministic session ID from the
 * `user` field (format: "userId/threadId" → "main:http:userId:threadId").
 * This avoids session_id validation issues and keeps sessions stable per thread.
 */

import { HttpChatTransport, type UIMessage, type UIMessageChunk } from 'ai';

const DEFAULT_USER = 'chat-ui';

interface AxChatTransportOptions {
  api?: string;
  user?: string;
  model?: string;
}

/**
 * Extract plain-text content from a UIMessage's parts array.
 */
function extractText(msg: UIMessage): string {
  if (!msg.parts) return '';
  return msg.parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('');
}

export class AxChatTransport extends HttpChatTransport<UIMessage> {
  constructor(opts: AxChatTransportOptions = {}) {
    const user = opts.user ?? DEFAULT_USER;
    super({
      api: opts.api ?? '/v1/chat/completions',
      prepareSendMessagesRequest: async (options) => ({
        body: {
          model: opts.model ?? 'default',
          stream: true,
          // user format: "userId/threadId" — server derives sessionId from this
          user: options.id ? `${user}/${options.id}` : user,
          messages: options.messages.map((m) => ({
            role: m.role,
            content: extractText(m),
          })),
        },
      }),
    });
  }

  /**
   * Parse OpenAI SSE stream and emit UIMessageChunk events.
   */
  protected processResponseStream(
    stream: ReadableStream<Uint8Array>,
  ): ReadableStream<UIMessageChunk> {
    const textPartId = 'text-0';
    let started = false;

    return stream
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(
        new TransformStream<string, UIMessageChunk>({
          transform(rawChunk, controller) {
            const lines = rawChunk.split('\n');
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed || trimmed.startsWith(':')) continue;

              if (trimmed === 'data: [DONE]') {
                if (started) {
                  controller.enqueue({ type: 'text-end', id: textPartId });
                }
                controller.enqueue({ type: 'finish', finishReason: 'stop' });
                return;
              }

              if (!trimmed.startsWith('data: ')) continue;

              let parsed: any;
              try {
                parsed = JSON.parse(trimmed.slice(6));
              } catch {
                continue;
              }

              const delta = parsed?.choices?.[0]?.delta;
              const finishReason = parsed?.choices?.[0]?.finish_reason;

              if (delta?.content) {
                if (!started) {
                  controller.enqueue({ type: 'text-start', id: textPartId });
                  started = true;
                }
                controller.enqueue({
                  type: 'text-delta',
                  id: textPartId,
                  delta: delta.content,
                });
              }

              if (finishReason && finishReason !== 'null') {
                if (started) {
                  controller.enqueue({ type: 'text-end', id: textPartId });
                }
                const reason =
                  finishReason === 'stop'
                    ? 'stop'
                    : finishReason === 'content_filter'
                      ? 'content-filter'
                      : 'stop';
                controller.enqueue({ type: 'finish', finishReason: reason });
              }
            }
          },
          flush(controller) {
            if (started) {
              controller.enqueue({ type: 'text-end', id: textPartId });
            }
            controller.enqueue({ type: 'finish', finishReason: 'stop' });
          },
        }),
      );
  }
}
