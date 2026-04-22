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
 * `user` field (format: "userId/threadId" → "{agentId}:http:userId:threadId").
 * This avoids session_id validation issues and keeps sessions stable per thread.
 */

import { HttpChatTransport, type UIMessage, type UIMessageChunk } from 'ai';

const DEFAULT_USER = 'guest';

export interface StatusEvent {
  operation: string;
  phase: string;
  message: string;
}

/**
 * Shape matches `src/host/diagnostics.ts` exactly — host is the wire
 * authority. Keep `context` primitives-only and `timestamp` required so a
 * future drift on either side shows up as a TypeScript error instead of
 * silently rendering an undefined-shaped row.
 */
export interface Diagnostic {
  severity: 'info' | 'warn' | 'error';
  kind: string;
  message: string;
  context?: Record<string, string | number | boolean>;
  timestamp: string;
}

interface AxChatTransportOptions {
  api?: string;
  user?: string;
  model?: string;
  onStatus?: (event: StatusEvent) => void;
  onRunStart?: () => void;
  onDiagnostic?: (d: Diagnostic) => void;
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
  private onStatus?: (event: StatusEvent) => void;
  private onRunStart?: () => void;
  private onDiagnostic?: (d: Diagnostic) => void;

  constructor(opts: AxChatTransportOptions = {}) {
    const user = opts.user ?? DEFAULT_USER;
    super({
      api: opts.api ?? '/v1/chat/completions',
      prepareSendMessagesRequest: async (options) => ({
        body: {
          model: opts.model ?? 'default',
          stream: true,
          // user format: "userId/threadId" — server derives sessionId from this
          // Strip assistant-ui's "__LOCALID_" prefix for cleaner session IDs
          user: options.id ? `${user}/${options.id.replace(/^__LOCALID_/, '')}` : user,
          messages: options.messages.map((m) => {
            const parts: any[] = [];
            const text = extractText(m);
            if (text) parts.push({ type: 'text', text });
            // Include file attachments from message parts (AI SDK FileUIPart)
            if (m.parts) {
              for (const p of m.parts) {
                if (p.type === 'file') {
                  const fp = p as { url: string; mediaType?: string; filename?: string };
                  if (fp.mediaType?.startsWith('image/')) {
                    parts.push({ type: 'image', fileId: fp.url, mimeType: fp.mediaType });
                  } else {
                    parts.push({ type: 'file', fileId: fp.url, mimeType: fp.mediaType, filename: fp.filename });
                  }
                }
              }
            }
            // Send as array when there are non-text parts (file/image attachments)
            const hasAttachments = parts.some((p: any) => p.type !== 'text');
            return {
              role: m.role,
              content: hasAttachments ? parts : text,
            };
          }),
        },
      }),
    });
    this.onStatus = opts.onStatus;
    this.onRunStart = opts.onRunStart;
    this.onDiagnostic = opts.onDiagnostic;
  }

  /**
   * Parse OpenAI SSE stream and emit UIMessageChunk events.
   */
  protected processResponseStream(
    stream: ReadableStream<Uint8Array>,
  ): ReadableStream<UIMessageChunk> {
    this.onRunStart?.();
    let textPartCounter = 0;
    let textPartId = 'text-0';
    let started = false;
    // Track named SSE events (event: line precedes data: line)
    let pendingEventName: string | null = null;
    const statusCallback = this.onStatus;
    const diagnosticCallback = this.onDiagnostic;

    // Buffer for incomplete SSE lines split across TextDecoderStream chunks
    let carry = '';
    let finished = false;
    let toolsStarted = false;
    // Track tool call IDs so we can mark them done when next content arrives
    const pendingToolCallIds: string[] = [];

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
                  // Mark any remaining pending tools as done
                  for (const id of pendingToolCallIds) {
                    controller.enqueue({ type: 'tool-output-available', toolCallId: id, output: { ok: true } });
                  }
                  pendingToolCallIds.length = 0;
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
              if (pendingEventName === 'status') {
                try {
                  const payload = JSON.parse(trimmed.slice(6));
                  statusCallback?.(payload);
                } catch { /* malformed event, skip */ }
                pendingEventName = null;
                continue;
              }
              if (pendingEventName === 'diagnostic') {
                try {
                  const payload = JSON.parse(trimmed.slice(6));
                  diagnosticCallback?.(payload);
                } catch { /* malformed event, skip */ }
                pendingEventName = null;
                continue;
              }
              if (pendingEventName === 'content_block') {
                try {
                  const block = JSON.parse(trimmed.slice(6));
                  // Close current text part before inserting non-text content
                  if (started) {
                    controller.enqueue({ type: 'text-end', id: textPartId });
                    started = false;
                    textPartCounter++;
                    textPartId = `text-${textPartCounter}`;
                  }
                  if (block.type === 'image') {
                    // Emit image as an inline HTML block (rendered via text-start/delta/end)
                    const imgTag = `\n\n![Generated image](/v1/files/${block.fileId})\n\n`;
                    controller.enqueue({ type: 'text-start', id: textPartId });
                    controller.enqueue({ type: 'text-delta', id: textPartId, delta: imgTag });
                    controller.enqueue({ type: 'text-end', id: textPartId });
                    textPartCounter++;
                    textPartId = `text-${textPartCounter}`;
                  } else if (block.type === 'file') {
                    const fileLink = `\n\n[${block.filename}](/v1/files/${block.fileId})\n\n`;
                    controller.enqueue({ type: 'text-start', id: textPartId });
                    controller.enqueue({ type: 'text-delta', id: textPartId, delta: fileLink });
                    controller.enqueue({ type: 'text-end', id: textPartId });
                    textPartCounter++;
                    textPartId = `text-${textPartCounter}`;
                  }
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
                  // Mark pending tools as done — content after tools means they completed
                  for (const id of pendingToolCallIds) {
                    controller.enqueue({ type: 'tool-output-available', toolCallId: id, output: { ok: true } });
                  }
                  pendingToolCallIds.length = 0;
                  // Clear status message once real content starts flowing
                  statusCallback?.({ operation: '', phase: 'clear', message: '' });
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
                if (!toolsStarted) {
                  statusCallback?.({ operation: '', phase: 'clear', message: '' });
                  toolsStarted = true;
                }
                // Close current text part so text after tools gets its own part
                if (started) {
                  controller.enqueue({ type: 'text-end', id: textPartId });
                  started = false;
                  textPartCounter++;
                  textPartId = `text-${textPartCounter}`;
                }
                for (const tc of delta.tool_calls) {
                  if (tc.function?.name) {
                    const toolCallId = tc.id ?? `call_${tc.index}`;
                    let args = {};
                    if (tc.function.arguments) {
                      try { args = JSON.parse(tc.function.arguments); } catch { /* partial/malformed args, use empty */ }
                    }
                    controller.enqueue({
                      type: 'tool-input-available',
                      toolCallId,
                      toolName: tc.function.name,
                      input: args,
                    });
                    pendingToolCallIds.push(toolCallId);
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
                if (reason === 'tool-calls') {
                  // Reset for next text segment after tool execution
                  started = false;
                  toolsStarted = false;
                  textPartCounter++;
                  textPartId = `text-${textPartCounter}`;
                } else {
                  controller.enqueue({ type: 'finish', finishReason: reason });
                  finished = true;
                }
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
