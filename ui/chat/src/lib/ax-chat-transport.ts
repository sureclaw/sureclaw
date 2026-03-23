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

export interface CredentialRequiredEvent {
  envName: string;
  sessionId: string;
  requestId: string;
}

interface AxChatTransportOptions {
  api?: string;
  user?: string;
  model?: string;
  onCredentialRequired?: (event: CredentialRequiredEvent) => void;
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
  private onCredentialRequired?: (event: CredentialRequiredEvent) => void;

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
    this.onCredentialRequired = opts.onCredentialRequired;
  }

  /**
   * Parse OpenAI SSE stream and emit UIMessageChunk events.
   */
  protected processResponseStream(
    stream: ReadableStream<Uint8Array>,
  ): ReadableStream<UIMessageChunk> {
    const textPartId = 'text-0';
    let started = false;
    // Track named SSE events (event: line precedes data: line)
    let pendingEventName: string | null = null;
    const credentialCallback = this.onCredentialRequired;

    // Buffer for incomplete SSE lines split across TextDecoderStream chunks
    let carry = '';
    let finished = false;

    return stream
      .pipeThrough(new TextDecoderStream() as ReadableWritablePair<string, Uint8Array>)
      .pipeThrough(
        new TransformStream<string, UIMessageChunk>({
          transform(rawChunk, controller) {
            const data = carry + rawChunk;
            const lines = data.split('\n');
            // Last element may be incomplete — carry it to next chunk
            carry = lines.pop() ?? '';

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed || trimmed.startsWith(':')) continue;

              // Track named SSE event type
              if (trimmed.startsWith('event: ')) {
                pendingEventName = trimmed.slice(7).trim();
                continue;
              }

              if (trimmed === 'data: [DONE]') {
                pendingEventName = null;
                if (!finished) {
                  if (started) {
                    controller.enqueue({ type: 'text-end', id: textPartId });
                  }
                  controller.enqueue({ type: 'finish', finishReason: 'stop' });
                  finished = true;
                }
                return;
              }

              if (!trimmed.startsWith('data: ')) continue;

              // Handle named events
              if (pendingEventName === 'credential_required' && credentialCallback) {
                try {
                  const payload = JSON.parse(trimmed.slice(6));
                  credentialCallback(payload);
                } catch { /* malformed event, skip */ }
                pendingEventName = null;
                continue;
              }
              pendingEventName = null;

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

              // Handle tool calls from the OpenAI SSE stream
              if (delta?.tool_calls) {
                for (const tc of delta.tool_calls) {
                  if (tc.function?.name) {
                    let args = {};
                    if (tc.function.arguments) {
                      try { args = JSON.parse(tc.function.arguments); } catch { /* partial/malformed args, use empty */ }
                    }
                    controller.enqueue({
                      type: 'tool-input-available',
                      toolCallId: tc.id ?? `call_${tc.index}`,
                      toolName: tc.function.name,
                      input: args,
                    });
                  }
                }
              }

              if (finishReason && finishReason !== 'null' && !finished) {
                if (started) {
                  controller.enqueue({ type: 'text-end', id: textPartId });
                }
                const reason =
                  finishReason === 'stop'
                    ? 'stop'
                    : finishReason === 'tool_calls'
                      ? 'tool-calls'
                      : finishReason === 'content_filter'
                        ? 'content-filter'
                        : 'stop';
                controller.enqueue({ type: 'finish', finishReason: reason });
                finished = true;
              }
            }
          },
          flush(controller) {
            if (!finished) {
              if (started) {
                controller.enqueue({ type: 'text-end', id: textPartId });
              }
              controller.enqueue({ type: 'finish', finishReason: 'stop' });
            }
          },
        }),
      );
  }
}
