/**
 * HTTP request handling — OpenAI-compatible API surface.
 *
 * Handles routing, request parsing, SSE streaming, and non-streaming
 * response formatting. The actual completion logic lives in server-completions.ts.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

// =====================================================
// Types
// =====================================================

export interface OpenAIChatRequest {
  model?: string;
  messages: { role: string; content: string }[];
  stream?: boolean;
  max_tokens?: number;
  session_id?: string;
}

export interface OpenAIChatResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: {
    index: number;
    message: { role: 'assistant'; content: string };
    finish_reason: 'stop' | 'length' | 'content_filter';
  }[];
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export interface OpenAIStreamChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: {
    index: number;
    delta: { role?: string; content?: string };
    finish_reason: 'stop' | 'length' | 'content_filter' | null;
  }[];
}

// =====================================================
// HTTP Utilities
// =====================================================

export function sendError(res: ServerResponse, status: number, message: string): void {
  const body = JSON.stringify({ error: { message, type: 'invalid_request_error', code: null } });
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

export function sendSSEChunk(res: ServerResponse, chunk: OpenAIStreamChunk): void {
  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
}

export async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  const MAX_BODY = 1024 * 1024; // 1MB

  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new Error('Request body too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf-8');
}
