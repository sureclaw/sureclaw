/**
 * AcceptanceClient — SSE-aware HTTP client for AX's /v1/chat/completions endpoint.
 *
 * Sends messages, parses streaming SSE responses, and handles credential submission.
 *
 * Endpoint reference (from src/host/server.ts):
 *   GET  /health                    — { status: 'ok' | 'draining' }
 *   POST /v1/chat/completions       — OpenAI-compatible streaming/non-streaming
 *   POST /v1/credentials/provide    — { envName, value } → { ok: true }
 *
 * SSE named events emitted during streaming:
 *   credential_required  — { envName, sessionId, requestId }
 *   oauth_required       — { envName, sessionId, authorizeUrl, requestId }
 */

export interface ChatResponse {
  /** Accumulated text content from all chunks */
  content: string;
  /** Named SSE events (e.g., credential_required) mapped to their data arrays */
  events: Map<string, any[]>;
  /** Raw parsed chunks from data: lines */
  chunks: any[];
  /** HTTP status code */
  status: number;
  /** Finish reason from the last chunk */
  finishReason: string;
}

export class AcceptanceClient {
  constructor(private baseUrl: string) {}

  /**
   * Send a chat message and collect the full streamed response.
   */
  async sendMessage(content: string, opts: {
    sessionId: string;
    user?: string;
    model?: string;
    timeoutMs?: number;
  }): Promise<ChatResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 60_000);

    try {
      const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(opts.user ? { 'X-User-Id': opts.user } : {}),
        },
        body: JSON.stringify({
          model: opts.model ?? 'openrouter/google/gemini-3-flash-preview',
          messages: [{ role: 'user', content }],
          stream: true,
          session_id: opts.sessionId,
        }),
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        return {
          content: '',
          events: new Map(),
          chunks: [],
          status: response.status,
          finishReason: 'error',
        };
      }

      return await this.parseSSEStream(response.body, response.status);
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Provide a credential value (e.g., after receiving a credential_required event).
   *
   * Endpoint: POST /v1/credentials/provide
   * Body: { envName: string, value: string }
   */
  async provideCredential(envName: string, value: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/v1/credentials/provide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ envName, value }),
    });
    if (!response.ok) {
      throw new Error(`Failed to provide credential: ${response.status} ${response.statusText}`);
    }
  }

  /**
   * Wait for the server to be ready (health check).
   *
   * Polls GET /health until it returns 200 with { status: 'ok' }.
   */
  async waitForReady(timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${this.baseUrl}/health`, {
          signal: AbortSignal.timeout(2000),
        });
        if (res.ok) return;
      } catch {
        // Server not ready yet
      }
      await new Promise(r => setTimeout(r, 1000));
    }
    throw new Error(`Server not ready after ${timeoutMs}ms`);
  }

  /**
   * Parse an SSE stream from the /v1/chat/completions endpoint.
   *
   * Handles:
   *  - Standard OpenAI data: chunks (content deltas, finish_reason)
   *  - Named events (event: credential_required, event: oauth_required)
   *  - Keepalive comments (: lines)
   *  - data: [DONE] terminator
   */
  private async parseSSEStream(body: ReadableStream<Uint8Array>, status: number): Promise<ChatResponse> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    const events = new Map<string, any[]>();
    const chunks: any[] = [];
    let finishReason = '';
    let currentEvent = '';  // tracks named events (event: xxx lines)

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';  // Keep incomplete line in buffer

        for (const line of lines) {
          // Named event line
          if (line.startsWith('event: ')) {
            currentEvent = line.slice(7).trim();
            continue;
          }

          // Keepalive comment
          if (line.startsWith(':')) continue;

          // Data line
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') continue;

            try {
              const parsed = JSON.parse(data);

              if (currentEvent) {
                // Named event — store in events map
                if (!events.has(currentEvent)) events.set(currentEvent, []);
                events.get(currentEvent)!.push(parsed);
                currentEvent = '';
                continue;
              }

              chunks.push(parsed);

              // Extract content from delta
              const choices = parsed.choices ?? [];
              for (const choice of choices) {
                if (choice.delta?.content) {
                  content += choice.delta.content;
                }
                if (choice.finish_reason) {
                  finishReason = choice.finish_reason;
                }
              }
            } catch {
              // Ignore unparseable data lines
            }
          }

          // Empty line resets named event tracking
          if (line.trim() === '') {
            currentEvent = '';
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    return { content, events, chunks, status, finishReason };
  }
}
