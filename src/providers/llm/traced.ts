// src/providers/llm/traced.ts — OpenTelemetry-instrumented LLM provider wrapper
import { SpanStatusCode, type Tracer, type Span } from '@opentelemetry/api';
import type { LLMProvider, ChatRequest, ChatChunk } from './types.js';

/**
 * Wraps any LLMProvider with OpenTelemetry tracing. Each chat() call becomes a
 * span containing the full request context (model, tools, messages) and response
 * details (text, tool calls, token usage).
 *
 * When the tracer is a no-op (SDK not registered), overhead is negligible — the
 * OTel API returns stub spans that discard all data.
 */
export class TracedLLMProvider implements LLMProvider {
  readonly name: string;

  constructor(
    private readonly inner: LLMProvider,
    private readonly tracer: Tracer,
  ) {
    this.name = inner.name;
  }

  async *chat(req: ChatRequest): AsyncIterable<ChatChunk> {
    const span = this.tracer.startSpan('gen_ai.chat', {
      attributes: {
        'gen_ai.system': this.inner.name,
        'gen_ai.request.model': req.model,
        ...(req.maxTokens != null && { 'gen_ai.request.max_tokens': req.maxTokens }),
        ...(req.tools?.length && {
          'gen_ai.tool.count': req.tools.length,
          'gen_ai.request.tools': JSON.stringify(
            req.tools.map(t => ({ name: t.name, description: t.description })),
          ),
        }),
      },
    });

    // Record each input message as a span event
    for (const msg of req.messages) {
      const content = typeof msg.content === 'string'
        ? msg.content
        : JSON.stringify(msg.content);
      span.addEvent(`gen_ai.${msg.role}.message`, { content });
    }

    let collectedText = '';
    const toolCalls: { name: string; args: string }[] = [];

    try {
      for await (const chunk of this.inner.chat(req)) {
        if (chunk.type === 'text' && chunk.content) {
          collectedText += chunk.content;
        } else if (chunk.type === 'tool_use' && chunk.toolCall) {
          toolCalls.push({
            name: chunk.toolCall.name,
            args: JSON.stringify(chunk.toolCall.args),
          });
        } else if (chunk.type === 'done' && chunk.usage) {
          span.setAttributes({
            'gen_ai.usage.input_tokens': chunk.usage.inputTokens,
            'gen_ai.usage.output_tokens': chunk.usage.outputTokens,
          });
        }

        yield chunk;
      }

      // Record response events after streaming completes
      if (collectedText) {
        span.addEvent('gen_ai.assistant.message', { content: collectedText });
      }
      for (const tc of toolCalls) {
        span.addEvent('gen_ai.tool.call', { name: tc.name, args: tc.args });
      }
      if (toolCalls.length > 0) {
        span.setAttribute('gen_ai.response.tool_call_count', toolCalls.length);
      }
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      throw err;
    } finally {
      span.end();
    }
  }

  async models(): Promise<string[]> {
    return this.inner.models();
  }
}
