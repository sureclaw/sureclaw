/**
 * Anthropic Messages API proxy — translates HTTP POST /v1/messages
 * into IPC llm_call requests to the host, then returns responses in
 * Anthropic Messages API format (JSON or SSE streaming).
 *
 * This preserves AX's security pipeline: all LLM calls go through the
 * host's handleIPC, which does audit logging and taint budget tracking.
 */

import { createServer, type Server } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, unlinkSync } from 'node:fs';
import { createConnection } from 'node:net';

// ── IPC client (minimal, inline — avoids importing container code) ──

interface IPCResponse {
  ok: boolean;
  chunks?: Array<{
    type: 'text' | 'tool_use' | 'done';
    content?: string;
    toolCall?: { id: string; name: string; args: Record<string, unknown> };
    usage?: { inputTokens: number; outputTokens: number };
  }>;
  error?: string;
}

function ipcCall(socketPath: string, payload: Record<string, unknown>): Promise<IPCResponse> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = Buffer.alloc(0);

    socket.on('connect', () => {
      const data = Buffer.from(JSON.stringify(payload), 'utf-8');
      const header = Buffer.alloc(4);
      header.writeUInt32BE(data.length, 0);
      socket.write(Buffer.concat([header, data]));
    });

    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      // Read length-prefixed message
      if (buffer.length >= 4) {
        const msgLen = buffer.readUInt32BE(0);
        if (buffer.length >= 4 + msgLen) {
          const raw = buffer.subarray(4, 4 + msgLen).toString('utf-8');
          socket.destroy();
          try {
            resolve(JSON.parse(raw));
          } catch (err) {
            reject(new Error(`Failed to parse IPC response: ${(err as Error).message}`));
          }
        }
      }
    });

    socket.on('error', reject);
  });
}

// ── Request types ───────────────────────────────────────────────────

interface AnthropicMessage {
  role: string;
  content: string | Array<{ type: string; [k: string]: unknown }>;
}

interface AnthropicRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: string | Array<{ type: string; text: string }>;
  tools?: Array<{ name: string; description: string; input_schema: unknown }>;
  max_tokens?: number;
  stream?: boolean;
}

// ── Proxy server ────────────────────────────────────────────────────

export function startAnthropicProxy(
  proxySocketPath: string,
  ipcSocketPath: string,
): { server: Server; stop: () => void } {
  // Clean up stale socket
  if (existsSync(proxySocketPath)) {
    unlinkSync(proxySocketPath);
  }

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key, anthropic-version');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Only handle POST /v1/messages
    if (req.url !== '/v1/messages' || req.method !== 'POST') {
      const body = JSON.stringify({ type: 'error', error: { type: 'not_found', message: 'Not found' } });
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(body);
      return;
    }

    try {
      const rawBody = await readBody(req);
      const apiReq: AnthropicRequest = JSON.parse(rawBody);

      // Convert Anthropic format to IPC format
      const ipcMessages: Array<{ role: string; content: string | unknown[] }> = [];

      // System prompt
      if (apiReq.system) {
        const systemText = typeof apiReq.system === 'string'
          ? apiReq.system
          : apiReq.system.map(b => b.text).join('\n');
        ipcMessages.push({ role: 'system', content: systemText });
      }

      // Messages
      for (const msg of apiReq.messages) {
        if (typeof msg.content === 'string') {
          ipcMessages.push({ role: msg.role, content: msg.content });
        } else {
          // Pass structured content through (tool_use, tool_result, text blocks)
          ipcMessages.push({ role: msg.role, content: msg.content });
        }
      }

      // Tools
      const ipcTools = apiReq.tools?.map(t => ({
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      }));

      // Make IPC call
      const ipcResponse = await ipcCall(ipcSocketPath, {
        action: 'llm_call',
        model: apiReq.model,
        messages: ipcMessages,
        tools: ipcTools,
        maxTokens: apiReq.max_tokens,
      });

      if (!ipcResponse.ok) {
        const errBody = JSON.stringify({
          type: 'error',
          error: { type: 'api_error', message: ipcResponse.error ?? 'LLM call failed' },
        });
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(errBody);
        return;
      }

      // Build Anthropic response content
      const contentBlocks: Array<Record<string, unknown>> = [];
      let inputTokens = 0;
      let outputTokens = 0;
      const stopReason = ipcResponse.chunks?.some(c => c.type === 'tool_use') ? 'tool_use' : 'end_turn';

      for (const chunk of ipcResponse.chunks ?? []) {
        if (chunk.type === 'text' && chunk.content) {
          contentBlocks.push({ type: 'text', text: chunk.content });
        } else if (chunk.type === 'tool_use' && chunk.toolCall) {
          contentBlocks.push({
            type: 'tool_use',
            id: chunk.toolCall.id,
            name: chunk.toolCall.name,
            input: chunk.toolCall.args,
          });
        } else if (chunk.type === 'done' && chunk.usage) {
          inputTokens = chunk.usage.inputTokens;
          outputTokens = chunk.usage.outputTokens;
        }
      }

      if (apiReq.stream) {
        // SSE streaming response
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });

        // message_start
        sendSSE(res, 'message_start', {
          type: 'message_start',
          message: {
            id: `msg_${Date.now()}`,
            type: 'message',
            role: 'assistant',
            content: [],
            model: apiReq.model,
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: inputTokens, output_tokens: 0 },
          },
        });

        // content_block events
        for (let i = 0; i < contentBlocks.length; i++) {
          const block = contentBlocks[i];

          sendSSE(res, 'content_block_start', {
            type: 'content_block_start',
            index: i,
            content_block: block.type === 'text'
              ? { type: 'text', text: '' }
              : { type: 'tool_use', id: block.id, name: block.name, input: {} },
          });

          if (block.type === 'text') {
            sendSSE(res, 'content_block_delta', {
              type: 'content_block_delta',
              index: i,
              delta: { type: 'text_delta', text: block.text },
            });
          } else if (block.type === 'tool_use') {
            sendSSE(res, 'content_block_delta', {
              type: 'content_block_delta',
              index: i,
              delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
            });
          }

          sendSSE(res, 'content_block_stop', {
            type: 'content_block_stop',
            index: i,
          });
        }

        // message_delta + message_stop
        sendSSE(res, 'message_delta', {
          type: 'message_delta',
          delta: { stop_reason: stopReason, stop_sequence: null },
          usage: { output_tokens: outputTokens },
        });

        sendSSE(res, 'message_stop', { type: 'message_stop' });

        res.end();
      } else {
        // Non-streaming JSON response
        const response = {
          id: `msg_${Date.now()}`,
          type: 'message',
          role: 'assistant',
          content: contentBlocks,
          model: apiReq.model,
          stop_reason: stopReason,
          stop_sequence: null,
          usage: { input_tokens: inputTokens, output_tokens: outputTokens },
        };

        const body = JSON.stringify(response);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
        res.end(body);
      }
    } catch (err) {
      const errBody = JSON.stringify({
        type: 'error',
        error: { type: 'api_error', message: (err as Error).message },
      });
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
      }
      res.end(errBody);
    }
  });

  server.listen(proxySocketPath);

  return {
    server,
    stop: () => {
      server.close();
      try { unlinkSync(proxySocketPath); } catch { /* ignore */ }
    },
  };
}

function sendSSE(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  const MAX_BODY = 4 * 1024 * 1024; // 4MB

  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new Error('Request body too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf-8');
}
